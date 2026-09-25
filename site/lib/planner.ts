import type { EveningSettings } from "../../addon/app/lib/charge-evening.ts";
import {
  evening,
  validateSettings,
} from "../../addon/app/lib/charge-evening.ts";
import type {
  ChargeInterval,
  ChargeModel,
} from "../../addon/app/lib/charge-plan.ts";

export type PlannerDataset = {
  schemaVersion: 1;
  kind: "forecast-snapshot";
  id: string;
  timeZone: string;
  currency: string;
  model: ChargeModel;
  slots: ChargeInterval[];
  terminalReserveKwh: number;
  settings: EveningSettings;
  assumptions: string[];
  devices?: unknown;
  context?: unknown;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function number(
  value: unknown,
  label: string,
  min = -Infinity,
  max = Infinity,
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}

/** Validate the untrusted file before it reaches the production planner. */
export function parseDataset(value: unknown): PlannerDataset {
  const d = object(value);
  if (d.schemaVersion !== 1 || d.kind !== "forecast-snapshot")
    throw new Error(
      "Import a version 1 forecast-snapshot from Export planner data.",
    );
  if (
    typeof d.id !== "string" ||
    typeof d.currency !== "string" ||
    typeof d.timeZone !== "string"
  )
    throw new Error("Dataset identity, currency and time zone are required.");
  new Intl.DateTimeFormat("en", { timeZone: d.timeZone }).format(0);
  if (
    !Array.isArray(d.assumptions) ||
    !d.assumptions.every((a) => typeof a === "string")
  )
    throw new Error("Dataset assumptions must be text.");
  const m = object(d.model);
  number(m.capacityKwh, "capacity", Number.MIN_VALUE);
  number(m.minSoc, "minimum SoC", 0, 100);
  number(m.maxSoc, "maximum SoC", Number(m.minSoc), 100);
  if (m.minSoc === m.maxSoc) throw new Error("SoC window must be positive.");
  number(m.soc, "initial SoC", 0, 100);
  number(m.minW, "minimum charge power", 0);
  number(m.maxW, "maximum charge power", Number(m.minW));
  number(m.stepW, "charge step", Number.MIN_VALUE);
  number(m.dischargeW, "discharge power", Number.MIN_VALUE);
  number(m.efficiency, "efficiency", Number.MIN_VALUE, 1);
  number(m.wearPerKwh, "battery wear", 0);
  if ((Number(m.maxW) - Number(m.minW)) / Number(m.stepW) > 2000)
    throw new Error("At most 2000 charge steps are supported.");
  if (m.dischargeStepW !== undefined) {
    number(m.dischargeStepW, "discharge step", Number.MIN_VALUE);
    number(m.dischargeMinW ?? 0, "minimum discharge", 0, Number(m.dischargeW));
    if (
      (Number(m.dischargeW) - Number(m.dischargeMinW ?? 0)) /
        Number(m.dischargeStepW) >
      2000
    )
      throw new Error("At most 2000 discharge steps are supported.");
  }
  number(d.terminalReserveKwh, "terminal reserve", 0);
  if (!Array.isArray(d.slots) || !d.slots.length || d.slots.length > 384)
    throw new Error("Expected 1–384 planning intervals.");
  let previousEnd: number | undefined;
  for (const raw of d.slots) {
    const s = object(raw);
    const start = number(s.start, "interval start", -8.64e15, 8.64e15);
    const end = number(s.end, "interval end", -8.64e15, 8.64e15);
    if (end <= start || (previousEnd !== undefined && start !== previousEnd))
      throw new Error(
        "Intervals must be ordered, contiguous and have positive duration.",
      );
    previousEnd = end;
    for (const key of ["solarW", "loadW"]) number(s[key], key, 0);
    for (const key of ["buy", "sell"]) number(s[key], key);
    if (typeof s.estimatedPrice !== "boolean")
      throw new Error("Missing estimated-price flag.");
    if (s.curtailment !== undefined) {
      const c = object(s.curtailment);
      for (const key of ["fixedW", "availableW", "floorW", "exportAllowanceW"])
        number(c[key], `curtailment ${key}`, 0);
      number(c.gridTargetW, "grid target");
      for (const key of ["ceilingW", "deadbandW"])
        if (c[key] !== undefined) number(c[key], key, 0);
      for (const key of ["fixedArrays", "modulatingArrays"]) {
        if (c[key] === undefined) continue;
        if (!Array.isArray(c[key]) || c[key].length > 100)
          throw new Error("Invalid PV arrays.");
        for (const rawArray of c[key]) {
          const a = object(rawArray);
          number(a.availableW, "available PV", 0);
          number(
            a[key === "fixedArrays" ? "ceilingW" : "floorW"],
            "PV bound",
            0,
          );
          for (const field of ["ceilingW", "stepW"])
            if (a[field] !== undefined) number(a[field], field, 0);
          if (
            a.initiallyStepped !== undefined &&
            typeof a.initiallyStepped !== "boolean"
          )
            throw new Error("Invalid initial curtailment state.");
        }
      }
    }
  }
  object(d.settings);
  const dataset = d as unknown as PlannerDataset;
  validateSettings(dataset, dataset.settings);
  return dataset;
}

export async function runPlanner(value: unknown) {
  const dataset = parseDataset(value);
  return evening(dataset, dataset.settings);
}
