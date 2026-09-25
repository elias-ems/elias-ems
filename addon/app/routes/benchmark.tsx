import { type CSSProperties, useState } from "react";
import { useFetcher } from "react-router";
import BenchmarkDataset, {
  draftValues,
  serializeDraft,
} from "../components/BenchmarkDataset";
import { cardStyle, ruleStyle } from "../components/dashboard/chrome";
import type {
  BenchmarkInput,
  BenchmarkSettings,
} from "../lib/benchmark.server";
import { benchmarkDataset, runBenchmark } from "../lib/benchmark.server";
import {
  applySlotValues,
  BenchmarkInputError,
  parseBenchmarkValues,
  parseCustomDataset,
} from "../lib/benchmark-input";
import type { PlannerExportDataset } from "../lib/planner-export.server";
import type { Route } from "./+types/benchmark";

export function loader() {
  return benchmarkDataset();
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const form = await request.formData();
    const custom = parseCustomDataset(form.get("customDataset"));
    const targetInput =
      (custom?.input as unknown as BenchmarkInput) ?? benchmarkDataset().input;
    const targetSettings =
      (custom?.settings as unknown as BenchmarkSettings) ??
      benchmarkDataset().settings;
    const values = parseBenchmarkValues(
      form.get("dataset"),
      targetInput.slots.length,
    );
    return {
      report: await runBenchmark(values, targetInput, targetSettings),
      error: null,
    };
  } catch (error) {
    if (error instanceof BenchmarkInputError)
      return { report: null, error: error.message };
    console.error("Benchmark failed", error);
    return {
      report: null,
      error:
        error instanceof Error
          ? error.message
          : "The benchmark could not finish. Please try again.",
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

type ActiveBenchmarkInput = BenchmarkInput & {
  devices?: PlannerExportDataset["devices"];
};

export default function Benchmark({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [reportDismissed, setReportDismissed] = useState(false);
  const rawReport = fetcher.data?.report;
  const report = reportDismissed ? null : rawReport;

  const [customData, setCustomData] = useState<{
    input: ActiveBenchmarkInput;
    settings: BenchmarkSettings;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const activeInput: ActiveBenchmarkInput =
    customData?.input ?? loaderData.input;
  const activeSettings = customData?.settings ?? loaderData.settings;
  const { algorithms } = loaderData;

  const [draft, setDraft] = useState(() => draftValues(activeInput.slots));
  const serialized = serializeDraft(draft);
  const edited = serialized !== serializeDraft(draftValues(activeInput.slots));
  const isInputMatchingReport = Boolean(
    report &&
      report.input.id === activeInput.id &&
      report.input.model.capacityKwh === activeInput.model.capacityKwh &&
      report.input.model.soc === activeInput.model.soc &&
      report.input.model.maxSoc === activeInput.model.maxSoc &&
      report.input.model.minSoc === activeInput.model.minSoc &&
      (!report.settings ||
        (report.settings.deadline === activeSettings.deadline &&
          report.settings.solarHaircut === activeSettings.solarHaircut &&
          report.settings.targetSoc === activeSettings.targetSoc)),
  );
  const stale = Boolean(
    report &&
      (!isInputMatchingReport ||
        serialized !== serializeDraft(draftValues(report.input.slots))),
  );

  const time = (value: number | string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: activeInput.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));

  const formatDate = (value: number | string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: activeInput.timeZone,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(value));

  const handleFileImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = JSON.parse(text);
        if (!parsed.slots || !Array.isArray(parsed.slots) || !parsed.model) {
          setImportError(
            "Invalid planner dataset: missing 'slots' array or 'model' object.",
          );
          return;
        }
        const deadline =
          parsed.settings?.deadline ??
          new Date(parsed.slots[parsed.slots.length - 1].end).toISOString();
        const settings: BenchmarkSettings = {
          deadline,
          targetSoc: parsed.settings?.targetSoc ?? parsed.model.maxSoc ?? 100,
          solarHaircut: parsed.settings?.solarHaircut ?? 0.2,
          switchCost: parsed.settings?.switchCost ?? 0.002,
          passes: parsed.settings?.passes ?? 4,
          spikeBufferKwh: parsed.settings?.spikeBufferKwh ?? 0.54,
          algorithm: parsed.settings?.algorithm ?? "cost-optimized",
          algorithms: parsed.settings?.algorithms ?? [
            "cost-optimized",
            "evening-target",
          ],
        };
        setCustomData({ input: parsed, settings });
        setDraft(draftValues(parsed.slots));
        setImportError(null);
        setReportDismissed(true);
      } catch (err) {
        setImportError(
          `Failed to parse JSON file: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const handleResetToBundled = () => {
    setCustomData(null);
    setDraft(draftValues(loaderData.input.slots));
    setImportError(null);
    setReportDismissed(true);
  };

  const handleResetDraft = () => {
    setDraft(draftValues(activeInput.slots));
  };

  const handleExportCurrent = () => {
    const exportObj = {
      ...activeInput,
      slots: activeInput.slots.map((slot, i) =>
        applySlotValues(slot, {
          solarW: Number(draft[i]?.solarW ?? slot.solarW),
          loadW: Number(draft[i]?.loadW ?? slot.loadW),
          buy: Number(draft[i]?.buy ?? slot.buy),
          sell: Number(draft[i]?.sell ?? slot.sell),
        }),
      ),
      settings: activeSettings,
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `benchmark-${activeInput.id || "dataset"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const devices = activeInput.devices;

  return (
    <main
      className="page"
      style={{ display: "grid", gap: "1.5rem", minWidth: 0 }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Benchmark</h1>
        <p>
          Compare every algorithm against the bundled dataset or your imported /
          edited copy.
        </p>
        <p style={ruleStyle}>
          {formatDate(activeInput.slots[0].start)} ·{" "}
          {time(activeInput.slots[0].start)}–
          {time(activeInput.slots[activeInput.slots.length - 1].end)} ·{" "}
          {activeInput.timeZone} · {activeInput.slots.length} intervals ·{" "}
          {activeInput.model.capacityKwh} kWh battery
        </p>
      </div>

      <section
        style={{ ...cardStyle, padding: "1rem" }}
        aria-label="Benchmark setup"
      >
        <p style={{ marginTop: 0 }}>
          Algorithms: {algorithms.join(" and ")}. Target:{" "}
          {activeSettings.targetSoc}% charge at {time(activeSettings.deadline)}.
        </p>
        <p>
          Each schedule is evaluated with measured solar and{" "}
          {activeSettings.solarHaircut * 100}% less solar.
          {customData
            ? " Using imported dataset and experiment settings."
            : " Settings are fixed and independent of your live configuration."}{" "}
          Interval values can be edited below.
        </p>

        <div
          style={{
            display: "flex",
            gap: "1rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <fetcher.Form
            method="post"
            id="benchmark-run"
            onSubmit={() => setReportDismissed(false)}
          >
            <input type="hidden" name="dataset" value={serialized} />
            {customData && (
              <input
                type="hidden"
                name="customDataset"
                value={JSON.stringify({
                  ...customData.input,
                  settings: customData.settings,
                })}
              />
            )}
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

          <label
            style={{
              padding: "0.6rem 1rem",
              font: "inherit",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 4,
              background: "var(--color-surface)",
              cursor: busy ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.875rem",
            }}
          >
            <span>Import planner data (JSON)</span>
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={handleFileImport}
              disabled={busy}
            />
          </label>
        </div>

        {importError && (
          <p
            role="alert"
            style={{ color: "var(--color-error)", marginTop: "0.75rem" }}
          >
            {importError}
          </p>
        )}

        <p role="status" aria-live="polite">
          {busy
            ? "Running the submitted dataset. This may take a few seconds."
            : report
              ? `Completed at ${time(report.completedAt)} (${activeInput.timeZone}).`
              : "Ready to run."}
        </p>
        {fetcher.data?.error && <p role="alert">{fetcher.data.error}</p>}
        <p>
          {customData
            ? `Using imported dataset: ${customData.input.id || "custom"} (${customData.input.slots.length} intervals).`
            : edited
              ? "Using an edited copy of the bundled dataset."
              : "Using the bundled dataset."}
        </p>
        {stale && (
          <p role="status">
            Inputs changed since the displayed results. Run all algorithms again
            to update them.
          </p>
        )}
      </section>

      {devices && (
        <details style={{ ...cardStyle, padding: "1rem" }} open>
          <summary style={{ fontWeight: 600, cursor: "pointer" }}>
            Configured devices from imported dataset
          </summary>
          <div
            style={{
              display: "grid",
              gap: "1rem",
              marginTop: "0.75rem",
              fontSize: "0.875rem",
            }}
          >
            {devices.battery && (
              <div>
                <strong>Battery:</strong> {devices.battery.title} ·{" "}
                {devices.battery.capacityKwh} kWh capacity · SoC{" "}
                {devices.battery.minChargePercent}%–
                {devices.battery.maxChargePercent}% · Max charge{" "}
                {devices.battery.maxChargePowerW ?? "—"} W / Max discharge{" "}
                {devices.battery.maxDischargePowerW ?? "—"} W · Efficiency{" "}
                {devices.battery.chargeEfficiencyPercent ?? 95}%
              </div>
            )}
            {devices.pvEntities && devices.pvEntities.length > 0 && (
              <div>
                <strong>PV Inverters / Arrays:</strong>
                <ul style={{ margin: "0.25rem 0 0 1.25rem", padding: 0 }}>
                  {devices.pvEntities.map((pv) => (
                    <li key={pv.id}>
                      {pv.title} — {pv.ratedPowerW} W rating ({pv.controlMode},{" "}
                      {pv.curtailable ? "curtailable" : "fixed"})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {devices.curtailment && (
              <div>
                <strong>Curtailment:</strong>{" "}
                {devices.curtailment.enabled ? "Enabled" : "Disabled"} ·
                Strategy: {devices.curtailment.strategy} · Price threshold: €
                {devices.curtailment.priceThresholdPerKwh}/kWh · Min limit:{" "}
                {devices.curtailment.minLimitPercent}%
              </div>
            )}
            {devices.control && (
              <div>
                <strong>Control:</strong> Strategy: {devices.control.strategy} ·
                Evening hour: {devices.control.eveningHour}:00 · Ceiling switch
                cost: €{devices.control.ceilingSwitchCost}
              </div>
            )}
            {devices.prices && (
              <div>
                <strong>Prices:</strong> Source: {devices.prices.source} (
                {devices.prices.forecastEntityId || "no entity"}) · Currency:{" "}
                {activeInput.currency}
              </div>
            )}
          </div>
        </details>
      )}

      <BenchmarkDataset
        draft={draft}
        onChange={setDraft}
        reset={handleResetDraft}
        resetToBundled={handleResetToBundled}
        isCustom={Boolean(customData)}
        onExport={handleExportCurrent}
        disabled={busy}
        intervals={activeInput.slots.map(
          (slot) => `${time(slot.start)}–${time(slot.end)}`,
        )}
        model={activeInput.model}
        reserve={activeInput.terminalReserveKwh}
      />

      {report && (
        <section
          aria-label="Benchmark results"
          aria-busy={busy}
          style={{ minWidth: 0 }}
        >
          <h2>Results{busy ? " — previous run" : ""}</h2>
          <p>
            {!isInputMatchingReport
              ? "Run used a different dataset or settings."
              : serializeDraft(draftValues(report.input.slots)) ===
                  serializeDraft(draftValues(activeInput.slots))
                ? customData
                  ? `Run used the imported dataset (${activeInput.id || "custom"}).`
                  : "Run used the bundled dataset."
                : "Run used an edited dataset; original measurement assumptions may no longer apply."}
          </p>
          <p style={ruleStyle}>
            Lower energy cost is better, but compare deadline charge and target
            shortfall too: the algorithms have different objectives. Runtime is
            indicative for one run.
          </p>
          {[
            0,
            report.settings?.solarHaircut ?? activeSettings.solarHaircut,
          ].map((haircut, index) => (
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
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              Compare interval schedules
            </summary>
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <caption>
                  Charge ceilings and end-of-interval charge with measured solar
                  ({activeInput.timeZone})
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={cell}>
                      Interval
                    </th>
                    {[
                      "Solar (W)",
                      "Demand (W)",
                      "Import (€/kWh)",
                      "Export (€/kWh)",
                    ].map((label) => (
                      <th key={label} scope="col" style={cell}>
                        {label}
                      </th>
                    ))}
                    {report.results.map((r) => (
                      <th key={r.id} scope="col" style={cell}>
                        {r.label} · ceiling / charge
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.input.slots.map((slot, index) => (
                    <tr key={slot.start}>
                      <th scope="row" style={cell}>
                        {time(slot.start)}–{time(slot.end)}
                      </th>
                      <td style={cell}>{slot.solarW}</td>
                      <td style={cell}>{slot.loadW}</td>
                      <td style={cell}>{slot.buy}</td>
                      <td style={cell}>{slot.sell}</td>
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
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Dataset assumptions
        </summary>
        <p>
          This is a measured-hindsight simulation or forecast snapshot. The
          reduced-solar scenario is evaluated during planning.
        </p>
        <ul>
          {(activeInput.assumptions ?? []).map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        <p>
          Evening target uses a {activeSettings.spikeBufferKwh ?? 0.54} kWh
          daytime buffer preference, €{activeSettings.switchCost ?? 0.002} per
          limit change, and {activeSettings.passes ?? 4} search passes.
        </p>
      </details>
    </main>
  );
}
