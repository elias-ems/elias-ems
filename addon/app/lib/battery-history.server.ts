import { listBatteries } from "./batteries.server";
import {
  type BatteryHistory,
  type HistoryRangeHours,
  historySamples,
} from "./battery-history";
import { fetchHaHistory } from "./ha.server";

type HistoryResult = Awaited<ReturnType<typeof loadBatteryHistory>>;
type CachedHistory = {
  expiresAt: number;
  value: HistoryResult | Promise<HistoryResult>;
};

const cache = new Map<string, CachedHistory>();

function cacheTtl(hours: HistoryRangeHours): number {
  return hours === 24 ? 60_000 : 5 * 60_000;
}

export async function readBatteryHistory(
  hours: HistoryRangeHours,
  now = Date.now(),
): Promise<{ batteries: BatteryHistory[]; from: number; to: number }> {
  const batteries = await listBatteries();
  for (const [cachedKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(cachedKey);
  }
  const key = JSON.stringify([
    hours,
    batteries.map((battery) => [
      battery.id,
      battery.title,
      battery.minChargePercent,
      battery.maxChargePercent,
      battery.socEntityId,
      battery.powerEntityId,
      battery.energyEntityId,
    ]),
  ]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const pending = loadBatteryHistory(batteries, hours, now);
  cache.set(key, { expiresAt: now + cacheTtl(hours), value: pending });
  try {
    const value = await pending;
    cache.set(key, { expiresAt: now + cacheTtl(hours), value });
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

async function loadBatteryHistory(
  batteries: Awaited<ReturnType<typeof listBatteries>>,
  hours: HistoryRangeHours,
  now: number,
): Promise<{ batteries: BatteryHistory[]; from: number; to: number }> {
  const to = now;
  const from = to - hours * 3_600_000;
  const entityIds = [
    ...new Set(
      batteries.flatMap((battery) => [
        battery.socEntityId,
        battery.powerEntityId,
        battery.energyEntityId,
      ]),
    ),
  ].filter(Boolean);

  if (entityIds.length === 0) return { batteries: [], from, to };

  const history = await fetchHaHistory(entityIds, new Date(from), new Date(to));

  return {
    from,
    to,
    batteries: batteries.map((battery) => ({
      id: battery.id,
      title: battery.title,
      minChargePercent: battery.minChargePercent,
      maxChargePercent: battery.maxChargePercent,
      charge: historySamples(history[battery.socEntityId]),
      power: historySamples(history[battery.powerEntityId]),
      energy: historySamples(history[battery.energyEntityId]),
    })),
  };
}

/** Test-only: history is process-local, so each test starts without prior reads. */
export function resetBatteryHistoryCache() {
  cache.clear();
}
