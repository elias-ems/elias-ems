import type { ChargeInterval } from "./charge-plan";

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

export function applySlotValues<
  T extends {
    solarW: number;
    loadW: number;
    buy: number;
    sell: number;
    curtailment?: ChargeInterval["curtailment"];
  },
>(slot: T, values: BenchmarkValues): T {
  let curtailment = slot.curtailment;
  if (curtailment && values.solarW !== slot.solarW) {
    if (slot.solarW > 0) {
      const ratio = values.solarW / slot.solarW;
      const availableW = curtailment.availableW * ratio;
      curtailment = {
        ...curtailment,
        fixedW: curtailment.fixedW * ratio,
        availableW,
        floorW: Math.min(curtailment.floorW, availableW),
        fixedArrays: curtailment.fixedArrays?.map((array) => ({
          ...array,
          availableW: array.availableW * ratio,
        })),
        modulatingArrays: curtailment.modulatingArrays?.map((array) => {
          const scaledAvailableW = array.availableW * ratio;
          return {
            ...array,
            availableW: scaledAvailableW,
            floorW: Math.min(array.floorW, scaledAvailableW),
          };
        }),
      };
    } else {
      const availableW = values.solarW;
      const modulatingCount = curtailment.modulatingArrays?.length ?? 0;
      curtailment = {
        ...curtailment,
        fixedW: 0,
        availableW,
        floorW: 0,
        fixedArrays: curtailment.fixedArrays?.map((array) => ({
          ...array,
          availableW: 0,
        })),
        modulatingArrays: curtailment.modulatingArrays?.map((array) => ({
          ...array,
          availableW:
            modulatingCount > 0 ? availableW / modulatingCount : availableW,
          floorW: 0,
        })),
      };
    }
  }

  return {
    ...slot,
    ...values,
    curtailment,
  };
}

export function parseBenchmarkValues(
  raw: FormDataEntryValue | null,
  count: number,
): BenchmarkValues[] {
  if (typeof raw !== "string" || raw.length > 5_000_000)
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

export function parseCustomDataset(raw: FormDataEntryValue | null): {
  input: Record<string, unknown>;
  settings: Record<string, unknown>;
} | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.length > 5_000_000) {
    throw new BenchmarkInputError("Imported dataset is too large (max 5 MB).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BenchmarkInputError("Imported dataset is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BenchmarkInputError("Imported dataset must be an object.");
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.slots) || obj.slots.length === 0) {
    throw new BenchmarkInputError(
      "Imported dataset must contain a non-empty slots array.",
    );
  }
  if (!obj.model || typeof obj.model !== "object") {
    throw new BenchmarkInputError(
      "Imported dataset must declare a battery model.",
    );
  }
  if (
    typeof obj.terminalReserveKwh !== "number" ||
    !Number.isFinite(obj.terminalReserveKwh)
  ) {
    throw new BenchmarkInputError(
      "Imported dataset must declare terminalReserveKwh.",
    );
  }
  const m = obj.model as Record<string, unknown>;
  for (const key of [
    "capacityKwh",
    "minSoc",
    "maxSoc",
    "minW",
    "maxW",
    "stepW",
    "dischargeW",
    "efficiency",
    "wearPerKwh",
    "soc",
  ]) {
    if (typeof m[key] !== "number" || !Number.isFinite(m[key])) {
      throw new BenchmarkInputError(
        `Battery model is missing or invalid for property: ${key}`,
      );
    }
  }
  for (let i = 0; i < obj.slots.length; i++) {
    const s = obj.slots[i] as Record<string, unknown>;
    if (!s || typeof s !== "object") {
      throw new BenchmarkInputError(`Interval ${i + 1} is not a valid object.`);
    }
    for (const key of ["start", "end", "solarW", "loadW", "buy", "sell"]) {
      if (typeof s[key] !== "number" || !Number.isFinite(s[key])) {
        throw new BenchmarkInputError(
          `Interval ${i + 1}: ${key} must be a finite number.`,
        );
      }
    }
  }
  let settingsObj = obj.settings as Record<string, unknown> | undefined;
  if (!settingsObj || typeof settingsObj !== "object") {
    const deadline = new Date(
      (obj.slots[obj.slots.length - 1] as Record<string, unknown>)
        .end as number,
    ).toISOString();
    settingsObj = {
      deadline,
      targetSoc: m.maxSoc,
      solarHaircut: 0.2,
      switchCost: 0.002,
      passes: 4,
      spikeBufferKwh: 0.54,
      algorithm: "cost-optimized",
      algorithms: ["cost-optimized", "evening-target"],
    };
  }
  return { input: obj, settings: settingsObj };
}
