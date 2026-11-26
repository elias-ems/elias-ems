import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGrid } from "../../app/lib/grid.server";
import {
  parseSettingsBackup,
  previewRevision,
  readSettings,
  restoreSettings,
  serializeSettings,
} from "../../app/lib/settings-backup.server";

const control = vi.hoisted(() => ({
  pendingControlTick: vi.fn(async () => {}),
  stopControlLoop: vi.fn(),
  syncControlLoop: vi.fn(async () => {}),
  releaseBattery: vi.fn(async (_old: unknown) => true),
  releasePvArray: vi.fn(async (_old: unknown) => true),
}));
vi.mock("../../app/lib/control-loop.server", () => control);

let directory: string;
const file = (name: string) => path.join(directory, name);
const seed = (name: string, value: unknown) =>
  writeFile(file(name), JSON.stringify(value));

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "elias-ems-settings-"));
  vi.stubEnv("DATA_DIR", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("settings backup", () => {
  it("rejects a stale preview and keeps the later edit", async () => {
    const before = await readSettings();
    const desired = { ...before, grid: { powerEntityId: "sensor.backup" } };
    await saveGrid({ powerEntityId: "sensor.later" });

    await expect(
      restoreSettings(desired, previewRevision(before, desired)),
    ).rejects.toThrow("Preview the file again");
    expect((await readSettings()).grid.powerEntityId).toBe("sensor.later");
    expect(control.stopControlLoop).not.toHaveBeenCalled();
  });

  it("keeps the legacy files readable if the atomic write fails", async () => {
    const before = await readSettings();
    const desired = { ...before, grid: { powerEntityId: "sensor.backup" } };
    control.pendingControlTick.mockImplementationOnce(async () => {
      await mkdir(file("settings.json"));
    });
    await expect(
      restoreSettings(desired, previewRevision(before, desired)),
    ).rejects.toThrow();
    await rm(file("settings.json"), { recursive: true });
    expect(await readSettings()).toEqual(before);
    expect(control.syncControlLoop).toHaveBeenCalledOnce();
  });

  it("uses the outgoing device identities and aborts when a release fails", async () => {
    await seed("batteries.json", [
      {
        id: "battery-a",
        title: "Outgoing battery",
        powerEntityId: "sensor.battery_power",
        energyEntityId: "sensor.battery_energy",
        socEntityId: "sensor.battery_soc",
        capacityKwh: 10,
        minChargePercent: 10,
        maxChargePercent: 90,
        steered: true,
        commandContract: 1,
      },
    ]);
    await seed("pv-entities.json", [
      {
        id: "pv-a",
        title: "Outgoing PV",
        powerEntityId: "sensor.pv_power",
        energyEntityId: "sensor.pv_energy",
        ratedPowerW: 5000,
        curtailable: true,
        unrelatedSecret: "must not be exported",
      },
    ]);
    await seed("control.json", { enabled: true, strategy: "evening-target" });
    await seed("curtailment.json", { enabled: true });
    await seed("charge-limit-leases.json", [{ batteryId: "battery-a" }]);

    const before = await readSettings();
    const desired = parseSettingsBackup(
      serializeSettings({
        ...before,
        control: { ...before.control, enabled: false },
        curtailment: { ...before.curtailment, enabled: false },
        batteries: [],
        pvEntities: [],
      }),
    );
    const revision = previewRevision(before, desired);
    expect(serializeSettings(before)).not.toContain("unrelatedSecret");
    expect(serializeSettings(before)).not.toContain("charge-limit-leases");

    control.releasePvArray.mockResolvedValueOnce(false);
    await expect(restoreSettings(desired, revision)).rejects.toThrow(
      "could not release",
    );
    expect(await readSettings()).toEqual(before);

    await restoreSettings(desired, revision);
    expect(control.releaseBattery).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "battery-a", title: "Outgoing battery" }),
    );
    expect(control.releasePvArray).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "pv-a",
        title: "Outgoing PV",
        ratedPowerW: 5000,
      }),
    );
    expect(await readSettings()).toEqual(desired);

    await saveGrid({ powerEntityId: "sensor.later" });
    expect(await readSettings()).toEqual({
      ...desired,
      grid: { powerEntityId: "sensor.later" },
    });
  });
});
