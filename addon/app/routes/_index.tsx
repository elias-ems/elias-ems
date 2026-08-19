import { useEffect, useState } from "react";
import { Link, useHref, useRevalidator } from "react-router";
import DiagnosticsBox from "../components/DiagnosticsBox";
import { headingStyle, hintStyle, rowStyle } from "../components/form";
import LiveHealthFacts from "../components/LiveHealthFacts";
import LiveStatus from "../components/LiveStatus";
import Measurement from "../components/Measurement";
import { readControlConfig } from "../lib/control-config.server";
import { controlLoopStatus } from "../lib/control-loop.server";
import { type DashboardReadings, readDashboard } from "../lib/dashboard.server";
import { readDiagnostics } from "../lib/diagnostics.server";
import type { Reading } from "../lib/readings";
import type { Route } from "./+types/_index";

/** How often the readings refresh themselves, in milliseconds. */
const REFRESH_INTERVAL = 5_000;

/**
 * The same, while the browser says the page is hidden. Slower rather than
 * stopped: the add-on panel usually sits in a background tab and there is no
 * point polling Home Assistant for nobody, but "hidden" is not something to
 * trust absolutely — a document embedded in an iframe reports it for reasons
 * that have nothing to do with whether a person is looking at the page, and a
 * refresh that stops entirely on a wrong answer never starts again.
 */
const HIDDEN_REFRESH_INTERVAL = 60_000;

/** Enough of the log to be useful on first paint; the box then polls for more. */
const INITIAL_LOG_ENTRIES = 50;

export async function loader() {
  const [readings, config] = await Promise.all([
    readDashboard(),
    readControlConfig(),
  ]);

  return {
    ...readings,
    control: {
      enabled: config.enabled,
      status: controlLoopStatus(),
      // Only battery control's own entries: this box sits under that heading,
      // and the whole log is the Tools page's job.
      diagnostics: readDiagnostics({
        origin: "battery-control",
        limit: INITIAL_LOG_ENTRIES,
      }),
    },
  };
}

/**
 * Subscribes to the readings stream, which pushes a fresh set every time Home
 * Assistant says one of the entities on this page moved.
 *
 * Returns what to render and whether the stream is working. Until the first
 * message lands there is nothing to render but the loader's own data, which is
 * also what keeps hydration honest: the first client render is the server's.
 */
function useStreamedReadings(): {
  readings: DashboardReadings | null;
  streaming: boolean;
} {
  const [readings, setReadings] = useState<DashboardReadings | null>(null);
  const [streaming, setStreaming] = useState(false);

  // Through `useHref`, so the URL carries the ingress prefix. A bare
  // "/api/readings" would be resolved against the Home Assistant origin, where
  // this app is not served — the same trap the asset manifest falls into.
  const href = useHref("/api/readings");

  useEffect(() => {
    const source = new EventSource(href);

    source.addEventListener("message", (event) => {
      setReadings(JSON.parse(event.data) as DashboardReadings);
      setStreaming(true);
    });

    // EventSource reconnects on its own, so an error is not the end of the
    // stream — but it does mean this one is not delivering right now, which is
    // the moment to let polling take over. A stream that comes back says so
    // with its next message.
    source.addEventListener("error", () => setStreaming(false));

    return () => {
      source.close();
      setStreaming(false);
    };
  }, [href]);

  return { readings, streaming };
}

/**
 * Keeps the loader's readings current when the stream cannot: power is a live
 * value, so a number that never moves would be misleading.
 *
 * The next refresh is scheduled only once the previous one has come back,
 * rather than on a fixed interval. A `setInterval` would need a guard against
 * refreshes piling up on a slow Home Assistant, and every version of that guard
 * is one stuck request away from skipping every refresh from then on — the page
 * then sits there showing whatever it last managed to read, which is exactly
 * the failure this is meant to prevent.
 */
function useRefreshingReadings(enabled: boolean) {
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (!enabled) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let refreshing = false;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(
        refresh,
        document.visibilityState === "visible"
          ? REFRESH_INTERVAL
          : HIDDEN_REFRESH_INTERVAL,
      );
    };

    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      // A failed revalidation is already reported by the loader, which returns
      // the reason instead of throwing; all that matters here is that one bad
      // round does not end the schedule.
      await revalidate().catch(() => {});
      refreshing = false;
      if (!stopped) schedule();
    };

    // Coming back to the page should show current numbers straight away rather
    // than the minute-old ones it was left on.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, revalidate]);
}

/**
 * An already-formatted price as something `Measurement` can render.
 *
 * No `updatedAt`: a price belongs to a quarter-hour slot rather than to the
 * moment a sensor happened to report it, and the slot it belongs to is named
 * under the card. Hovering for "last changed" would answer a question nobody
 * asked about a price and give a misleading answer to the one they did.
 */
function priceReading(display: string | null): Reading | null {
  return display === null ? null : { display, ok: true, updatedAt: null };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { control } = loaderData;
  const { readings, streaming } = useStreamedReadings();

  // The stream's readings once it has sent any, the loader's until then. Both
  // are built by the same function on the server, so they are interchangeable.
  const { arrays, grid, batteries, prices, error, health } =
    readings ?? loaderData;

  const hasReadings =
    arrays.length > 0 ||
    grid.configured ||
    batteries.length > 0 ||
    prices.configured;

  // Only while the stream isn't delivering. If it never connects — an ingress
  // proxy that buffers, a browser with EventSource disabled — the page quietly
  // goes back to polling rather than showing numbers that stopped moving.
  useRefreshingReadings(hasReadings && !streaming);

  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>Home</h1>

      {hasReadings && <LiveStatus health={health} streaming={streaming} />}

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

      <Panel title="Grid" empty={grid.configured ? null : "No grid sensor"}>
        <div style={{ ...measurementsStyle, marginTop: "0.75rem" }}>
          <Measurement label="Power" reading={grid.power} />
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

      <Panel
        title="Prices"
        empty={prices.configured ? null : "No price source"}
      >
        {prices.error ? (
          <p style={{ ...hintStyle, marginTop: "0.75rem" }}>{prices.error}</p>
        ) : (
          <>
            <div style={{ ...measurementsStyle, marginTop: "0.75rem" }}>
              <Measurement
                label="Buying"
                reading={priceReading(prices.consumption)}
              />
              <Measurement
                label="Selling"
                reading={priceReading(prices.production)}
              />
              {/*
                The exchange price sits beside the two derived from it, not
                instead of them. It is what makes a formula checkable against a
                bill, and what makes a mis-picked entity — one already carrying
                markups — visible rather than plausible.
              */}
              <Measurement
                label="Exchange"
                reading={priceReading(prices.spot)}
              />
            </div>
            <p style={{ ...hintStyle, marginTop: "0.5rem" }}>
              {[prices.slot, prices.coverage].filter(Boolean).join(" · ")}
            </p>
          </>
        )}
      </Panel>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={headingStyle}>Battery control</h2>
        <p style={{ ...hintStyle, marginTop: "0.35rem" }}>
          {control.enabled
            ? `Running the ${control.status.strategy} strategy whenever a reading changes, at most every ${control.status.intervalSeconds}s.`
            : "Disabled."}{" "}
          <Link to="/settings">Settings</Link>
        </p>
        <DiagnosticsBox
          origin="battery-control"
          initialEntries={control.diagnostics}
          subtitle={control.status.running ? "loop running" : "loop stopped"}
        >
          <LiveHealthFacts health={health} />
        </DiagnosticsBox>
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
          {/* Number-neutral on purpose: the grid is one sensor, the other two
              panels are lists. */}
          {empty} yet — head to <Link to="/settings">Settings</Link>.
        </p>
      ) : (
        children
      )}
    </section>
  );
}
