export type HistorySample = {
  at: number;
  value: number;
};

export type BatteryHistory = {
  id: string;
  title: string;
  minChargePercent: number;
  maxChargePercent: number;
  charge: HistorySample[];
  power: HistorySample[];
  energy: HistorySample[];
};

export type HistoryRangeHours = 24 | 72 | 168;

export function historyRange(value: string | null): HistoryRangeHours {
  if (value === "72") return 72;
  if (value === "168") return 168;
  return 24;
}

type HaHistoryState = {
  state?: string;
  last_changed?: string;
  last_updated?: string;
};

/** Recorder states reduced to finite, drawable points in chronological order. */
export function historySamples(states: HaHistoryState[] = []): HistorySample[] {
  return states
    .map((state) => ({
      at: Date.parse(state.last_changed ?? state.last_updated ?? ""),
      value: Number(state.state),
    }))
    .filter(
      (point) => Number.isFinite(point.at) && Number.isFinite(point.value),
    )
    .sort((a, b) => a.at - b.at);
}
