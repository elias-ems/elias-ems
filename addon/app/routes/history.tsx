import { NavLink, useNavigation } from "react-router";
import {
  cardStyle,
  eyebrowStyle,
  ruleStyle,
} from "../components/dashboard/chrome";
import HistoryChart from "../components/history/HistoryChart";
import { type HistoryRangeHours, historyRange } from "../lib/battery-history";
import { readBatteryHistory } from "../lib/battery-history.server";
import type { Route } from "./+types/history";

const ranges: Array<{ hours: HistoryRangeHours; label: string }> = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const hours = historyRange(new URL(request.url).searchParams.get("hours"));
  try {
    return { hours, ...(await readBatteryHistory(hours)), error: null };
  } catch (error) {
    const now = Date.now();
    return {
      hours,
      batteries: [],
      from: now - hours * 3_600_000,
      to: now,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default function History({ loaderData }: Route.ComponentProps) {
  const { batteries, from, to, hours, error } = loaderData;
  const navigation = useNavigation();
  const loading =
    navigation.state !== "idle" && navigation.location?.pathname === "/history";
  const pendingHours =
    loading && navigation.location
      ? historyRange(
          new URLSearchParams(navigation.location.search).get("hours"),
        )
      : null;
  const selectedHours = pendingHours ?? hours;
  const pendingLabel = ranges.find(
    (range) => range.hours === pendingHours,
  )?.label;

  return (
    <main className="page dash">
      <div>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Battery history</h1>
        <p style={{ ...ruleStyle, marginTop: "0.35rem" }}>
          Recorded state of charge, power and energy from Home Assistant.
        </p>
      </div>

      <nav
        aria-label="History range"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
      >
        {ranges.map((range) => (
          <NavLink
            key={range.hours}
            to={`?hours=${range.hours}`}
            aria-current={selectedHours === range.hours ? "page" : undefined}
            aria-disabled={loading}
            onClick={(event) => {
              if (loading) event.preventDefault();
            }}
            style={{
              padding: "0.45rem 0.75rem",
              borderRadius: 999,
              border: "1px solid var(--color-border-strong)",
              background:
                selectedHours === range.hours
                  ? "var(--color-battery-soft)"
                  : "var(--color-surface)",
              color:
                selectedHours === range.hours
                  ? "var(--color-battery)"
                  : "var(--color-text-muted)",
              fontSize: "0.75rem",
              fontWeight: 600,
              textDecoration: "none",
              cursor: loading ? "wait" : "pointer",
              opacity: loading && selectedHours !== range.hours ? 0.6 : 1,
            }}
          >
            {range.label}
          </NavLink>
        ))}
      </nav>

      <p
        aria-live="polite"
        style={{
          ...ruleStyle,
          minHeight: "1.2em",
          margin: 0,
          color: loading ? "var(--color-battery)" : "transparent",
        }}
      >
        {loading ? `Loading ${pendingLabel ?? "history"}…` : "History loaded"}
      </p>

      {error && (
        <p style={{ ...ruleStyle, color: "var(--color-danger)" }}>
          Couldn’t read Recorder history: {error}
        </p>
      )}
      {!error && batteries.length === 0 && (
        <p style={ruleStyle}>
          Add a battery in Settings to see its history here.
        </p>
      )}

      <div
        className="dash"
        aria-busy={loading}
        style={{
          opacity: loading ? 0.55 : 1,
          transition: "opacity 120ms ease",
        }}
      >
        {batteries.map((battery) => (
          <section key={battery.id} style={{ ...cardStyle, padding: "1rem" }}>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.125rem" }}>
              {battery.title}
            </h2>
            <p style={{ ...ruleStyle, marginBottom: "1rem" }}>
              Operating window {battery.minChargePercent}–
              {battery.maxChargePercent}%
            </p>
            <div className="history-grid">
              <div>
                <h3 style={eyebrowStyle}>State of charge</h3>
                <HistoryChart
                  samples={battery.charge}
                  from={from}
                  to={to}
                  color="var(--color-battery)"
                  unit="%"
                  label={`${battery.title} state of charge`}
                  domain={[0, 100]}
                />
              </div>
              <div>
                <h3 style={eyebrowStyle}>Battery power</h3>
                <HistoryChart
                  samples={battery.power}
                  from={from}
                  to={to}
                  color="var(--color-pv)"
                  unit="W"
                  label={`${battery.title} power`}
                  zeroLine
                />
              </div>
              <div>
                <h3 style={eyebrowStyle}>Energy counter</h3>
                <HistoryChart
                  samples={battery.energy}
                  from={from}
                  to={to}
                  color="var(--color-export)"
                  unit="kWh"
                  label={`${battery.title} energy`}
                />
              </div>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
