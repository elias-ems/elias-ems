/** Energy dashboard contracts, normalized without depending on a provider. */
export type EnergySource = {
  type: string;
  stat_energy_from?: string | null;
  stat_energy_to?: string | null;
  flow_from?: { stat_energy_from: string }[];
  flow_to?: { stat_energy_to: string }[];
  config_entry_solar_forecast?: string[] | null;
};
export type EnergyPreferences = { energy_sources: EnergySource[] };
export type SolarHour = { start: number; wh: number };
export type EnergyStatistics = Record<
  string,
  { start: number; end?: number; change: number | null }[]
>;

export function selectedForecasts(prefs: EnergyPreferences): string[] {
  const solar = prefs.energy_sources.filter((s) => s.type === "solar");
  if (
    !solar.length ||
    solar.some((s) => !s.config_entry_solar_forecast?.length)
  ) {
    throw new Error(
      "Select a forecast for every solar source in Home Assistant's Energy dashboard.",
    );
  }
  return [
    ...new Set(solar.flatMap((s) => s.config_entry_solar_forecast || [])),
  ];
}

export function combineSolar(
  ids: string[],
  raw: Record<string, { wh_hours?: Record<string, unknown> }>,
): SolarHour[] {
  const maps = ids.map((id) => {
    const hours = raw[id]?.wh_hours;
    if (!hours) throw new Error("A selected solar forecast is unavailable.");
    const result = new Map<number, number>();
    for (const [stamp, wh] of Object.entries(hours)) {
      const start = Date.parse(stamp);
      if (
        !Number.isFinite(start) ||
        typeof wh !== "number" ||
        !Number.isFinite(wh) ||
        wh < 0
      ) {
        throw new Error("The solar forecast contains invalid hourly energy.");
      }
      if (result.has(start))
        throw new Error("The solar forecast contains duplicate hours.");
      result.set(start, wh);
    }
    return result;
  });
  if (!maps.length) throw new Error("No solar forecast selected.");
  // Intersection, never quietly treat a missing array/hour as zero production.
  return [...maps[0].keys()]
    .filter((t) => maps.every((m) => m.has(t)))
    .sort((a, b) => a - b)
    .map((start) => ({
      start,
      wh: maps.reduce((sum, map) => sum + (map.get(start) ?? 0), 0),
    }));
}

/** Signed energy counters needed to reconstruct household demand. Supports HA's older grid shape. */
export function consumptionCounters(
  prefs: EnergyPreferences,
): Map<string, number> {
  const counters = new Map<string, number>();
  let hasImport = false;
  let hasExport = false;
  const add = (id: string | null | undefined, sign: number) => {
    if (!id) return;
    if (counters.has(id))
      throw new Error(
        "Energy dashboard counters overlap; household demand cannot be reconstructed reliably.",
      );
    counters.set(id, sign);
  };
  if (
    !prefs.energy_sources.some((s) => s.type === "grid") ||
    !prefs.energy_sources.some((s) => s.type === "battery")
  ) {
    throw new Error(
      "Configure grid and battery energy counters in the Energy dashboard to learn household consumption.",
    );
  }
  for (const s of prefs.energy_sources) {
    if (!["grid", "solar", "battery"].includes(s.type)) continue;
    if (s.type === "solar" && !s.stat_energy_from)
      throw new Error("Solar production energy counters are required.");
    if (s.type === "grid") {
      hasImport ||= Boolean(
        s.stat_energy_from || s.flow_from?.some((f) => f.stat_energy_from),
      );
      hasExport ||= Boolean(
        s.stat_energy_to || s.flow_to?.some((f) => f.stat_energy_to),
      );
    }
    if (s.type === "grid" && (s.flow_from || s.flow_to)) {
      for (const f of s.flow_from || []) add(f.stat_energy_from, 1);
      for (const f of s.flow_to || []) add(f.stat_energy_to, -1);
    } else {
      if (s.type === "battery" && (!s.stat_energy_from || !s.stat_energy_to))
        throw new Error(
          "Battery charge and discharge energy counters are required.",
        );
      add(s.stat_energy_from, 1);
      if (s.type !== "solar") add(s.stat_energy_to, -1);
    }
  }
  if (!hasImport || !hasExport)
    throw new Error(
      "Grid import and export energy counters are both required to reconstruct household demand.",
    );
  return counters;
}

export type LoadProfile = {
  watts: number[];
  samples: number[];
  hours: number;
  timeZone: string;
};
export function localHour(at: number, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(at),
  );
}
export function buildLoadProfile(
  counters: Map<string, number>,
  stats: EnergyStatistics,
  timeZone: string,
): LoadProfile {
  if (!counters.size)
    throw new Error("No household consumption counters configured.");
  const rows = [...counters].map(([id, sign]) => ({
    sign,
    rows: new Map((stats[id] || []).map((s) => [s.start, s])),
  }));
  const watts = new Array<number>(24).fill(0);
  const samples = new Array<number>(24).fill(0);
  let hours = 0;
  for (const t of rows[0].rows.keys()) {
    let kwh = 0;
    let valid = true;
    for (const row of rows) {
      const sample = row.rows.get(t);
      if (
        !sample ||
        sample.change === null ||
        !Number.isFinite(sample.change) ||
        sample.change < 0 ||
        !Number.isFinite(sample.start) ||
        (sample.end !== undefined &&
          (!Number.isFinite(sample.end) ||
            Math.abs(sample.end - sample.start - 3_600_000) > 1))
      ) {
        valid = false;
        break;
      }
      kwh += sample.change * row.sign;
    }
    if (!valid || kwh < -0.05) continue;
    const hour = localHour(t, timeZone);
    watts[hour] += Math.max(0, kwh) * 1000;
    samples[hour]++;
    hours++;
  }
  if (samples.some((n) => n < 3))
    throw new Error(
      "At least three complete days of hourly household energy history are needed. Missing history is not treated as zero load.",
    );
  return {
    watts: watts.map((w, i) => w / samples[i]),
    samples,
    hours,
    timeZone,
  };
}
