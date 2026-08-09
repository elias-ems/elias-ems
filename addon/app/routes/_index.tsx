import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { fetchHaState, type HaState } from "../lib/ha.server";
import { listPvEntities } from "../lib/pv-entities.server";
import type { Route } from "./+types/_index";

/** How often the readings refresh themselves, in milliseconds. */
const REFRESH_INTERVAL = 10_000;

type Reading = {
  display: string;
  /** False when the number shown isn't a real current value. */
  ok: boolean;
};

/**
 * Formatted here on the server rather than in the component: these strings are
 * locale-dependent, and formatting them during render would risk the server and
 * the browser disagreeing and tripping a hydration mismatch.
 */
function toReading(state: HaState | null): Reading {
  if (!state) return { display: "no such entity", ok: false };
  if (state.state === "unavailable" || state.state === "unknown") {
    return { display: state.state, ok: false };
  }

  const value = Number(state.state);
  const shown = Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : state.state;
  const unit = state.attributes?.unit_of_measurement;

  return { display: unit ? `${shown} ${unit}` : shown, ok: true };
}

export async function loader() {
  const pvEntities = await listPvEntities();

  try {
    const arrays = await Promise.all(
      pvEntities.map(async (entity) => {
        const [power, energy] = await Promise.all([
          fetchHaState(entity.powerEntityId),
          fetchHaState(entity.energyEntityId),
        ]);
        return {
          id: entity.id,
          title: entity.title,
          power: toReading(power),
          energy: toReading(energy),
        };
      }),
    );
    return { arrays, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      arrays: pvEntities.map((entity) => ({
        id: entity.id,
        title: entity.title,
        power: null,
        energy: null,
      })),
      error: message,
    };
  }
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { arrays, error } = loaderData;
  const revalidator = useRevalidator();

  // Power is a live reading, so a number that never moves would be misleading.
  // Skip hidden tabs — this polls Home Assistant, and the add-on panel is
  // usually left open in a background tab.
  useEffect(() => {
    if (arrays.length === 0) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [arrays.length, revalidator]);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 640 }}>
      <h1>Solar</h1>

      {arrays.length === 0 ? (
        <p style={{ color: "#7b8794" }}>
          No PV entities yet — add one in <Link to="/settings">Settings</Link>.
        </p>
      ) : (
        <>
          {error && (
            <p style={{ fontSize: "0.875rem", color: "#7b8794" }}>
              Couldn't read live values from Home Assistant: {error}
            </p>
          )}

          <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
            {arrays.map((array) => (
              <li
                key={array.id}
                style={{
                  padding: "0.75rem 0",
                  borderBottom: "1px solid #e4e7eb",
                }}
              >
                <div style={{ fontWeight: 600 }}>{array.title}</div>
                <div
                  style={{
                    display: "flex",
                    gap: "2rem",
                    marginTop: "0.35rem",
                  }}
                >
                  <Measurement label="Power" reading={array.power} />
                  <Measurement label="Energy" reading={array.energy} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function Measurement({
  label,
  reading,
}: {
  label: string;
  reading: Reading | null;
}) {
  return (
    <div>
      <div style={{ fontSize: "0.75rem", color: "#7b8794" }}>{label}</div>
      <div
        style={{
          fontVariantNumeric: "tabular-nums",
          color: reading?.ok ? "#1f2933" : "#7b8794",
        }}
      >
        {reading ? reading.display : "—"}
      </div>
    </div>
  );
}
