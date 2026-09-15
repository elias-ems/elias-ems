import { listBatteries } from "./batteries.server";
import {
  type BatteryHistory,
  type HistoryRangeHours,
  historySamples,
} from "./battery-history";
import { fetchHaHistory } from "./ha.server";

export async function readBatteryHistory(
  hours: HistoryRangeHours,
  now = Date.now(),
): Promise<{ batteries: BatteryHistory[]; from: number; to: number }> {
  const batteries = await listBatteries();
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
