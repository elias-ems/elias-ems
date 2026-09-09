import { readControlConfig } from "./control-config.server";
import {
  buildLoadProfile,
  combineSolar,
  consumptionCounters,
  type EnergyPreferences,
  type EnergyStatistics,
  selectedForecasts,
} from "./energy-forecast";
import { haCommands } from "./ha-command.server";

let historyCache:
  | { key: string; at: number; profile: ReturnType<typeof buildLoadProfile> }
  | undefined;

export async function readEnergyForecast(
  now = Date.now(),
  report: (key: string, message: string) => void = () => {},
) {
  const [prefs, forecasts, config] = await haCommands<
    [
      EnergyPreferences,
      Record<string, { wh_hours?: Record<string, unknown> }>,
      { time_zone: string },
    ]
  >([
    { type: "energy/get_prefs" },
    { type: "energy/solar_forecast" },
    { type: "get_config" },
  ]).catch((error) => {
    report("solar", error instanceof Error ? error.message : String(error));
    throw error;
  });
  const { ids, solar } = (() => {
    try {
      const ids = selectedForecasts(prefs);
      return { ids, solar: combineSolar(ids, forecasts) };
    } catch (error) {
      report("solar", error instanceof Error ? error.message : String(error));
      throw error;
    }
  })();
  if (prefs.energy_sources.filter((s) => s.type === "battery").length !== 1)
    throw new Error(
      "Charge-limit planning requires one household battery source in the Energy dashboard.",
    );
  report(
    "solar",
    `${ids.length} sources; ${solar.length} shared forecast hours`,
  );
  const counters = consumptionCounters(prefs, await readControlConfig());
  const key = JSON.stringify([config.time_zone, [...counters]]);
  if (
    !historyCache ||
    historyCache.key !== key ||
    now - historyCache.at > 3_600_000
  ) {
    const end = Math.floor(now / 3_600_000) * 3_600_000;
    const [stats] = await haCommands<[EnergyStatistics]>([
      {
        type: "recorder/statistics_during_period",
        start_time: new Date(end - 14 * 86_400_000).toISOString(),
        end_time: new Date(end).toISOString(),
        statistic_ids: [...counters.keys()],
        period: "hour",
        types: ["change"],
        units: { energy: "kWh" },
      },
    ]);
    historyCache = {
      key,
      at: now,
      profile: buildLoadProfile(counters, stats, config.time_zone),
    };
  }
  return {
    preferences: prefs,
    solar,
    profile: historyCache.profile,
    sources: ids,
    fetchedAt: now,
    forecastEnd: solar.length ? solar[solar.length - 1].start + 3_600_000 : now,
  };
}
