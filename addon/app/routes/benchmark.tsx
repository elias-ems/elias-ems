import type { CSSProperties } from "react";
import { useFetcher } from "react-router";
import { cardStyle, ruleStyle } from "../components/dashboard/chrome";
import { benchmarkDataset, runBenchmark } from "../lib/benchmark.server";
import type { Route } from "./+types/benchmark";

export function loader() {
  return benchmarkDataset();
}

export async function action() {
  try {
    return { report: await runBenchmark(), error: null };
  } catch (error) {
    console.error("Benchmark failed", error);
    return {
      report: null,
      error: "The benchmark could not finish. Please try again.",
    };
  }
}

const cell: CSSProperties = {
  padding: "0.65rem",
  textAlign: "right",
  borderBottom: "1px solid var(--color-border)",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
};
const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};
const money = (value: number) => `€${value.toFixed(4)}`;

export default function Benchmark({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const report = fetcher.data?.report;
  const { input, settings, algorithms } = loaderData;
  const time = (value: number | string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: input.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  return (
    <main
      className="page"
      style={{ display: "grid", gap: "1.5rem", minWidth: 0 }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Benchmark</h1>
        <p>Compare every algorithm against the same static dataset.</p>
        <p style={ruleStyle}>
          11 September 2026 · {time(input.slots[0].start)}–
          {time(input.slots[input.slots.length - 1].end)} · {input.timeZone} ·{" "}
          {input.slots.length} intervals · {input.model.capacityKwh} kWh battery
        </p>
      </div>
      <section
        style={{ ...cardStyle, padding: "1rem" }}
        aria-label="Benchmark setup"
      >
        <p style={{ marginTop: 0 }}>
          Algorithms: {algorithms.join(" and ")}. Target: {settings.targetSoc}%
          charge at {time(settings.deadline)}.
        </p>
        <p>
          Each schedule is evaluated with measured solar and{" "}
          {settings.solarHaircut * 100}% less solar. Settings are fixed and
          independent of your live configuration.
        </p>
        <fetcher.Form method="post">
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "0.65rem 1rem",
              font: "inherit",
              cursor: busy ? "wait" : "pointer",
            }}
          >
            {busy ? "Running all algorithms…" : "Run all algorithms"}
          </button>
        </fetcher.Form>
        <p role="status" aria-live="polite">
          {busy
            ? "Running the fixed dataset. This may take a few seconds."
            : report
              ? `Completed at ${time(report.completedAt)} (${input.timeZone}).`
              : "Ready to run."}
        </p>
        {fetcher.data?.error && <p role="alert">{fetcher.data.error}</p>}
      </section>
      {report && (
        <section
          aria-label="Benchmark results"
          aria-busy={busy}
          style={{ minWidth: 0 }}
        >
          <h2>Results{busy ? " — previous run" : ""}</h2>
          <p style={ruleStyle}>
            Lower energy cost is better, but compare deadline charge and target
            shortfall too: the algorithms have different objectives. Runtime is
            indicative for one run.
          </p>
          {[0, settings.solarHaircut].map((haircut, index) => (
            <div
              key={haircut}
              style={{
                ...cardStyle,
                padding: "1rem",
                marginTop: "1rem",
                overflowX: "auto",
              }}
            >
              <table style={table}>
                <caption
                  style={{
                    textAlign: "left",
                    fontWeight: 600,
                    marginBottom: "0.75rem",
                  }}
                >
                  {haircut === 0
                    ? "Measured solar"
                    : `${haircut * 100}% less solar`}
                </caption>
                <thead>
                  <tr>
                    {[
                      "Algorithm",
                      "Energy cost",
                      "Deadline charge",
                      "Target shortfall",
                      "End charge",
                      "Limit changes",
                      "Runtime",
                    ].map((label) => (
                      <th key={label} scope="col" style={cell}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.results.map((result) => {
                    const s = result.scenarios[index];
                    return (
                      <tr key={result.id}>
                        <th scope="row" style={{ ...cell, textAlign: "left" }}>
                          {result.label}
                        </th>
                        <td style={cell}>{money(s.energyCost)}</td>
                        <td style={cell}>{s.deadlineSoc.toFixed(1)}%</td>
                        <td style={cell}>
                          {s.targetShortfallKwh.toFixed(3)} kWh
                        </td>
                        <td style={cell}>{s.endSoc.toFixed(1)}%</td>
                        <td style={cell}>{s.switches}</td>
                        <td style={cell}>{result.elapsedMs.toFixed(0)} ms</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          <details style={{ ...cardStyle, padding: "1rem", marginTop: "1rem" }}>
            <summary>Compare interval schedules</summary>
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <caption>
                  Charge ceilings and end-of-interval charge with measured solar
                  ({input.timeZone})
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={cell}>
                      Interval
                    </th>
                    {report.results.map((r) => (
                      <th key={r.id} scope="col" style={cell}>
                        {r.label} · ceiling / charge
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {input.slots.map((slot, index) => (
                    <tr key={slot.start}>
                      <th scope="row" style={cell}>
                        {time(slot.start)}–{time(slot.end)}
                      </th>
                      {report.results.map((r) => (
                        <td key={r.id} style={cell}>
                          {r.scenarios[0].points[index].limitW} W /{" "}
                          {r.scenarios[0].points[index].soc.toFixed(1)}%
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
      <details style={{ ...cardStyle, padding: "1rem" }}>
        <summary>Dataset assumptions</summary>
        <p>
          This is a measured-hindsight simulation, not achieved savings or a
          test of historical forecasts. The reduced-solar scenario is known to
          Evening target during planning.
        </p>
        <ul>
          {input.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        <p>
          Evening target uses a {settings.spikeBufferKwh} kWh daytime buffer
          preference, €{settings.switchCost} per limit change, and{" "}
          {settings.passes} search passes.
        </p>
      </details>
    </main>
  );
}
