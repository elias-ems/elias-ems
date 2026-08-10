import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import DebugBox from "../components/DebugBox";
import { headingStyle, hintStyle, rowStyle } from "../components/form";
import Measurement from "../components/Measurement";
import { listBatteries } from "../lib/batteries.server";
import { readControlConfig } from "../lib/control-config.server";
import { readControlLog } from "../lib/control-log.server";
import { controlLoopStatus } from "../lib/control-loop.server";
import { isGridConfigured } from "../lib/grid";
import { readGrid } from "../lib/grid.server";
import { fetchHaState, type HaState } from "../lib/ha.server";
import { listPvEntities } from "../lib/pv-entities.server";
import { toReading } from "../lib/readings.server";
import type { Route } from "./+types/_index";

/** How often the readings refresh themselves, in milliseconds. */
const REFRESH_INTERVAL = 10_000;

/** Enough of the log to be useful on first paint; the debug box then polls for more. */
const INITIAL_LOG_ENTRIES = 50;

/**
 * Reads every entity the page needs in one round of requests, deduplicated — the
 * same sensor can legitimately be configured in two places.
 *
 * A Home Assistant that can't be reached is reported once, for the whole page,
 * rather than turning into one failure per card: the cause is the same for all
 * of them, and every reading falls back to "—".
 */
async function readStates(ids: Array<string | undefined>): Promise<{
  states: Map<string, HaState | null>;
  error: string | null;
}> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];

  try {
    const entries = await Promise.all(
      unique.map(async (id) => [id, await fetchHaState(id)] as const),
    );
    return { states: new Map(entries), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { states: new Map(), error: message };
  }
}

export async function loader() {
  const [pvEntities, grid, batteries, config] = await Promise.all([
    listPvEntities(),
    readGrid(),
    listBatteries(),
    readControlConfig(),
  ]);

  const { states, error } = await readStates([
    ...pvEntities.flatMap((entity) => [
      entity.powerEntityId,
      entity.energyEntityId,
    ]),
    grid.importEntityId,
    grid.exportEntityId,
    ...batteries.flatMap((battery) => [
      battery.powerEntityId,
      battery.energyEntityId,
      battery.socEntityId,
    ]),
  ]);

  // Null rather than a reading when the fetch never happened, so the card shows
  // a dash instead of claiming the entity is missing.
  const reading = (id: string) =>
    states.has(id) ? toReading(states.get(id) ?? null) : null;

  return {
    arrays: pvEntities.map((entity) => ({
      id: entity.id,
      title: entity.title,
      power: reading(entity.powerEntityId),
      energy: reading(entity.energyEntityId),
    })),
    grid: {
      configured: isGridConfigured(grid),
      consumption: grid.importEntityId ? reading(grid.importEntityId) : null,
      production: grid.exportEntityId ? reading(grid.exportEntityId) : null,
    },
    batteries: batteries.map((battery) => ({
      id: battery.id,
      title: battery.title,
      window: `${battery.minChargePercent}–${battery.maxChargePercent}% of ${battery.capacityKwh} kWh`,
      charge: reading(battery.socEntityId),
      power: reading(battery.powerEntityId),
      energy: reading(battery.energyEntityId),
    })),
    control: {
      enabled: config.enabled,
      status: controlLoopStatus(),
      entries: readControlLog(INITIAL_LOG_ENTRIES),
    },
    error,
  };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { arrays, grid, batteries, control, error } = loaderData;
  const revalidator = useRevalidator();

  const hasReadings =
    arrays.length > 0 || grid.configured || batteries.length > 0;

  // Power is a live reading, so a number that never moves would be misleading.
  // Skip hidden tabs — this polls Home Assistant, and the add-on panel is
  // usually left open in a background tab.
  useEffect(() => {
    if (!hasReadings) return undefined;
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      ) {
        revalidator.revalidate();
      }
    }, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [hasReadings, revalidator]);

  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>Home</h1>

      {error && (
        <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>
          Couldn't read live values from Home Assistant: {error}
        </p>
      )}

      <Panel
        title="Solar"
        empty={arrays.length === 0 ? "No PV entities" : null}
      >
        <ul style={listStyle}>
          {arrays.map((array) => (
            <li key={array.id} style={rowStyle}>
              <div style={{ fontWeight: 600 }}>{array.title}</div>
              <div style={measurementsStyle}>
                <Measurement label="Power" reading={array.power} />
                <Measurement label="Energy" reading={array.energy} />
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Grid" empty={grid.configured ? null : "No grid sensors"}>
        <div style={{ ...measurementsStyle, marginTop: "0.75rem" }}>
          <Measurement label="Consumption" reading={grid.consumption} />
          <Measurement label="Production" reading={grid.production} />
        </div>
      </Panel>

      <Panel
        title="Batteries"
        empty={batteries.length === 0 ? "No batteries" : null}
      >
        <ul style={listStyle}>
          {batteries.map((battery) => (
            <li key={battery.id} style={rowStyle}>
              <div style={{ fontWeight: 600 }}>{battery.title}</div>
              <div style={hintStyle}>{battery.window}</div>
              <div style={measurementsStyle}>
                <Measurement label="Charge" reading={battery.charge} />
                <Measurement label="Power" reading={battery.power} />
                <Measurement label="Energy" reading={battery.energy} />
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={headingStyle}>Battery control</h2>
        <p style={{ ...hintStyle, marginTop: "0.35rem" }}>
          {control.enabled
            ? `Running the ${control.status.strategy} strategy every ${control.status.intervalSeconds}s.`
            : "Disabled."}{" "}
          <Link to="/settings">Settings</Link>
        </p>
        <DebugBox
          initial={{ status: control.status, entries: control.entries }}
        />
      </section>
    </main>
  );
}

const listStyle = { listStyle: "none", padding: 0, margin: 0 } as const;
const measurementsStyle = {
  display: "flex",
  gap: "2rem",
  marginTop: "0.35rem",
} as const;

/**
 * A section that either has readings to show or says what to configure. The
 * empty state stays a section rather than disappearing, so the page's shape
 * doesn't change as things get configured.
 */
function Panel({
  title,
  empty,
  children,
}: {
  title: string;
  /** The reason there is nothing to show, or null when there is. */
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: "2rem" }}>
      <h2 style={headingStyle}>{title}</h2>
      {empty ? (
        <p style={{ ...hintStyle, marginTop: "0.35rem" }}>
          {empty} yet — add them in <Link to="/settings">Settings</Link>.
        </p>
      ) : (
        children
      )}
    </section>
  );
}
