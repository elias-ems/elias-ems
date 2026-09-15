import { beforeEach, describe, expect, it, vi } from "vitest";
import { historyRange, historySamples } from "../../app/lib/battery-history";

const { fetchHistory } = vi.hoisted(() => ({ fetchHistory: vi.fn() }));

vi.mock("../../app/lib/batteries.server", () => ({
  listBatteries: vi.fn(async () => [
    {
      id: "home",
      title: "Home battery",
      minChargePercent: 10,
      maxChargePercent: 90,
      socEntityId: "sensor.battery_soc",
      powerEntityId: "sensor.battery_power",
      energyEntityId: "sensor.battery_energy",
    },
  ]),
}));

vi.mock("../../app/lib/ha.server", () => ({
  fetchHaHistory: fetchHistory,
}));

describe("battery history", () => {
  it("accepts only the ranges offered by the page", () => {
    expect(historyRange(null)).toBe(24);
    expect(historyRange("72")).toBe(72);
    expect(historyRange("168")).toBe(168);
    expect(historyRange("999")).toBe(24);
  });

  it("keeps finite recorder values and orders them", () => {
    expect(
      historySamples([
        { state: "unknown", last_changed: "2026-09-15T09:00:00Z" },
        { state: "45.5", last_changed: "2026-09-15T08:00:00Z" },
        { state: "46", last_changed: "2026-09-15T10:00:00Z" },
      ]),
    ).toEqual([
      { at: Date.parse("2026-09-15T08:00:00Z"), value: 45.5 },
      { at: Date.parse("2026-09-15T10:00:00Z"), value: 46 },
    ]);
  });
});

describe("battery history cache", () => {
  beforeEach(async () => {
    fetchHistory.mockReset();
    fetchHistory.mockResolvedValue({});
    const { resetBatteryHistoryCache } = await import(
      "../../app/lib/battery-history.server"
    );
    resetBatteryHistoryCache();
  });

  it("reuses a 24-hour result for one minute", async () => {
    const { readBatteryHistory } = await import(
      "../../app/lib/battery-history.server"
    );
    await readBatteryHistory(24, 1_000_000);
    await readBatteryHistory(24, 1_059_999);
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    await readBatteryHistory(24, 1_060_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("reuses longer ranges for five minutes", async () => {
    const { readBatteryHistory } = await import(
      "../../app/lib/battery-history.server"
    );
    await readBatteryHistory(168, 1_000_000);
    await readBatteryHistory(168, 1_299_999);
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    await readBatteryHistory(168, 1_300_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("deduplicates simultaneous Recorder requests", async () => {
    let release: (value: Record<string, never>) => void = () => {};
    fetchHistory.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { readBatteryHistory } = await import(
      "../../app/lib/battery-history.server"
    );
    const first = readBatteryHistory(72, 1_000_000);
    const second = readBatteryHistory(72, 1_000_000);

    release({});
    await Promise.all([first, second]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });
});
