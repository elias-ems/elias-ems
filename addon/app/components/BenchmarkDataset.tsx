import type { BenchmarkValues } from "../lib/benchmark-input";
import { benchmarkFields } from "../lib/benchmark-input";
import { cardStyle } from "./dashboard/chrome";
import { inputStyle } from "./form";

export type BenchmarkDraft = Record<keyof BenchmarkValues, string>[];
export function draftValues(slots: BenchmarkValues[]): BenchmarkDraft {
  return slots.map((slot) => ({
    solarW: String(slot.solarW),
    loadW: String(slot.loadW),
    buy: String(slot.buy),
    sell: String(slot.sell),
  }));
}
export function serializeDraft(draft: BenchmarkDraft) {
  return JSON.stringify(
    draft.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value.trim() === "" ? null : Number(value),
        ]),
      ),
    ),
  );
}

export default function BenchmarkDataset({
  draft,
  onChange,
  reset,
  resetToBundled,
  isCustom,
  onExport,
  disabled,
  intervals,
  model,
  reserve,
}: {
  draft: BenchmarkDraft;
  onChange: (draft: BenchmarkDraft) => void;
  reset: () => void;
  resetToBundled?: () => void;
  isCustom?: boolean;
  onExport?: () => void;
  disabled: boolean;
  intervals: string[];
  model: Record<string, number>;
  reserve: number;
}) {
  return (
    <section
      style={{ ...cardStyle, padding: "1rem", minWidth: 0 }}
      aria-label="Input dataset"
    >
      <h2 style={{ marginTop: 0 }}>Input dataset</h2>
      <p>
        Edit the interval values, then run all algorithms again. Changes last
        while this page stays open. Times, battery model and experiment settings
        stay fixed.
      </p>
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <button type="button" onClick={reset} disabled={disabled}>
          {isCustom ? "Reset table edits" : "Reset to bundled dataset"}
        </button>
        {isCustom && resetToBundled && (
          <button type="button" onClick={resetToBundled} disabled={disabled}>
            Switch back to bundled dataset
          </button>
        )}
        {onExport && (
          <button type="button" onClick={onExport} disabled={disabled}>
            Export current dataset (JSON)
          </button>
        )}
      </div>
      <details style={{ marginTop: "1rem" }}>
        <summary>Battery model and reserve</summary>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            gap: "0.5rem 1rem",
          }}
        >
          {Object.entries(model).map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt>
                {(
                  {
                    capacityKwh: "Capacity (kWh)",
                    minSoc: "Minimum charge (%)",
                    maxSoc: "Maximum charge (%)",
                    soc: "Initial charge (%)",
                    minW: "Minimum ceiling (W)",
                    maxW: "Maximum ceiling (W)",
                    stepW: "Ceiling step (W)",
                    dischargeW: "Discharge limit (W)",
                    efficiency: "Efficiency (fraction)",
                    wearPerKwh: "Wear cost (€/kWh)",
                  } as Record<string, string>
                )[key] ?? key}
              </dt>
              <dd style={{ margin: 0 }}>{value}</dd>
            </div>
          ))}
          <dt>Terminal reserve (kWh)</dt>
          <dd style={{ margin: 0 }}>{reserve}</dd>
        </dl>
      </details>
      <div style={{ overflowX: "auto", marginTop: "1rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <caption style={{ textAlign: "left", marginBottom: "0.75rem" }}>
            Dataset intervals · prices may be negative
          </caption>
          <thead>
            <tr>
              <th scope="col">Interval</th>
              {benchmarkFields.map((field) => (
                <th key={field.key} scope="col">
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draft.map((row, index) => (
              <tr key={intervals[index]}>
                <th
                  scope="row"
                  style={{ whiteSpace: "nowrap", fontSize: "0.875rem" }}
                >
                  {intervals[index]}
                </th>
                {benchmarkFields.map((field) => (
                  <td key={field.key} style={{ padding: "0.25rem" }}>
                    <input
                      form="benchmark-run"
                      type="number"
                      step="any"
                      required
                      min={field.min}
                      max={field.max}
                      disabled={disabled}
                      aria-label={`${intervals[index]} ${field.label}`}
                      value={row[field.key]}
                      onChange={(event) =>
                        onChange(
                          draft.map((previous, i) =>
                            i === index
                              ? { ...previous, [field.key]: event.target.value }
                              : previous,
                          ),
                        )
                      }
                      style={{
                        ...inputStyle(),
                        width: "100%",
                        minWidth: "8rem",
                        boxSizing: "border-box",
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="submit"
        form="benchmark-run"
        disabled={disabled}
        style={{ marginTop: "1rem" }}
      >
        Run with these inputs
      </button>
    </section>
  );
}
