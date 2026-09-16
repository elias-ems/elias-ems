export const benchmarkFields = [
  { key: "solarW", label: "Solar (W)", min: 0, max: 1_000_000 },
  { key: "loadW", label: "Demand (W)", min: 0, max: 1_000_000 },
  { key: "buy", label: "Import (€/kWh)", min: -100, max: 100 },
  { key: "sell", label: "Export (€/kWh)", min: -100, max: 100 },
] as const;

export type BenchmarkValues = Record<
  (typeof benchmarkFields)[number]["key"],
  number
>;

export class BenchmarkInputError extends Error {}

export function parseBenchmarkValues(
  raw: FormDataEntryValue | null,
  count: number,
): BenchmarkValues[] {
  if (typeof raw !== "string" || raw.length > 100_000)
    throw new BenchmarkInputError(
      "Submit the interval dataset before running the benchmark.",
    );
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new BenchmarkInputError(
      "The dataset is not valid JSON. Reset the dataset and try again.",
    );
  }
  if (!Array.isArray(values) || values.length !== count)
    throw new BenchmarkInputError(
      `The dataset must contain exactly ${count} intervals.`,
    );
  return values.map((row: unknown, index) => {
    if (!row || typeof row !== "object")
      throw new BenchmarkInputError(`Interval ${index + 1} is missing.`);
    const result = {} as BenchmarkValues;
    for (const field of benchmarkFields) {
      const value = (row as Record<string, unknown>)[field.key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < field.min ||
        value > field.max
      )
        throw new BenchmarkInputError(
          `Interval ${index + 1}: ${field.label} must be between ${field.min} and ${field.max}.`,
        );
      result[field.key] = value;
    }
    return result;
  });
}
