import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumptionCounters } from "../addon/app/lib/energy-forecast.ts";

export function payload(capture) {
  const result =
    capture.result.structuredContent ??
    JSON.parse(capture.result.content.find((c) => c.type === "text").text);
  const data = result.data ?? result;
  if (
    data.success === false ||
    data.entities?.some((e) => e.has_more || e.error)
  )
    throw new Error("Incomplete capture: resolve errors/pagination first");
  return data;
}
export function kwhFactor(unit) {
  const factor = { Wh: 0.001, kWh: 1, MWh: 1000 }[unit];
  if (factor === undefined) throw new Error(`Unsupported energy unit: ${unit}`);
  return factor;
}
export function stateAt(rows, at) {
  const row = rows
    .filter((r) => Date.parse(r.last_updated ?? r.last_changed) <= at)
    .at(-1);
  if (!row?.state.trim() || !Number.isFinite(Number(row.state)))
    throw new Error(`Missing state at ${new Date(at).toISOString()}`);
  return Number(row.state);
}
// Integrate recorded tariff changes exactly, including sub-second update delays.
export function averagePrice(rows, start, end) {
  const boundaries = [
    start,
    ...rows
      .map((r) => Date.parse(r.last_updated ?? r.last_changed))
      .filter((t) => t > start && t < end),
    end,
  ];
  return boundaries
    .slice(0, -1)
    .reduce(
      (sum, t, i) =>
        sum + (stateAt(rows, t) * (boundaries[i + 1] - t)) / (end - start),
      0,
    );
}

export async function prepare(directory, spec) {
  const read = async (name) =>
    JSON.parse(await readFile(path.join(directory, `${name}.json`), "utf8"));
  const capture = await read("energy-history");
  const prefs = payload(await read("energy-prefs")).config;
  const stats = payload(capture).entities;
  const units = payload(await read("counter-units")).states;
  const historyCapture = await read("state-history");
  const history = payload(historyCapture).entities;
  const rows = (id) => {
    const entity = history.find((e) => e.entity_id === id);
    if (!entity?.states?.length) throw new Error(`Missing history: ${id}`);
    return [...entity.states].sort(
      (a, b) =>
        Date.parse(a.last_updated ?? a.last_changed) -
        Date.parse(b.last_updated ?? b.last_changed),
    );
  };
  const counters = consumptionCounters(prefs);
  const maps = new Map(
    [...counters.keys()].map((id) => {
      const entity = stats.find((e) => e.entity_id === id);
      if (!entity?.statistics?.length)
        throw new Error(`Missing statistics: ${id}`);
      const factor = kwhFactor(
        entity.unit_of_measurement ??
          units[id]?.attributes?.unit_of_measurement,
      );
      return [
        id,
        new Map(
          entity.statistics.map((r) => [
            r.start,
            typeof r.change === "number" && Number.isFinite(r.change)
              ? r.change * factor
              : null,
          ]),
        ),
      ];
    }),
  );
  const solarIds = prefs.energy_sources
    .filter((s) => s.type === "solar")
    .map((s) => s.stat_energy_from);
  const start = Date.parse(spec.start);
  const end = Math.min(
    Date.parse(spec.end),
    Math.floor(
      Math.min(
        Date.parse(capture.capturedAt),
        Date.parse(historyCapture.capturedAt),
      ) / 3600000,
    ) * 3600000,
    ...[...maps.values()].map((m) => Math.max(...m.keys()) + 3600000),
  );
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    start % 3600000
  )
    throw new Error("Invalid or empty completed-hour window");
  const slots = [];
  for (let t = start; t < end; t += 900000) {
    const hour = Math.floor(t / 3600000) * 3600000;
    const value = (id) => {
      const v = maps.get(id)?.get(hour);
      if (v == null || v < -1e-6)
        throw new Error(
          `Missing/negative energy: ${id} at ${new Date(hour).toISOString()}`,
        );
      return Math.max(0, v);
    };
    const loadW = [...counters].reduce(
      (sum, [id, sign]) => sum + sign * value(id) * 1000,
      0,
    );
    if (loadW < -1)
      throw new Error(
        `Negative reconstructed demand at ${new Date(hour).toISOString()}: ${loadW} W`,
      );
    slots.push({
      start: t,
      end: Math.min(t + 900000, end),
      solarW: solarIds.reduce((sum, id) => sum + value(id) * 1000, 0),
      loadW: Math.max(0, loadW),
      buy: averagePrice(rows(spec.buyEntity), t, Math.min(t + 900000, end)),
      sell: averagePrice(rows(spec.sellEntity), t, Math.min(t + 900000, end)),
      estimatedPrice: false,
    });
  }
  return {
    schemaVersion: 1,
    id: spec.id,
    timeZone: spec.timeZone,
    currency: spec.currency,
    kind: "measured-hindsight",
    capturedAt: capture.capturedAt,
    requestedEnd: spec.end,
    actualEnd: new Date(end).toISOString(),
    model: { ...spec.model, soc: stateAt(rows(spec.socEntity), start) },
    terminalReserveKwh: spec.terminalReserveKwh,
    assumptions: [
      "Measured hourly solar and reconstructed demand repeated across quarter-hours: perfect hindsight, not forecasts available at the time.",
      "Recorded tariffs time-weighted within each quarter-hour; not verified against Elias price formulas.",
      "Measured solar may already include curtailment; no counterfactual available solar inferred.",
      "Current counter units and battery settings assumed to apply throughout the capture.",
      ...spec.assumptions,
    ],
    slots,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, specFile, output] = process.argv.slice(2);
  const dataset = await prepare(
    directory,
    JSON.parse(await readFile(specFile, "utf8")),
  );
  await writeFile(output, JSON.stringify(dataset, null, 2));
  console.log(
    `${dataset.id}: ${dataset.slots.length} intervals through ${dataset.actualEnd}`,
  );
}
