import { createHash } from "node:crypto";
import {
  type Battery,
  batterySlug,
  isSteerable,
  parseBattery,
  steerableBy,
} from "./batteries";
import { listBatteries } from "./batteries.server";
import {
  BATTERY_COMMAND_SCHEMA_VERSION,
  isBatteryMode,
} from "./battery-command";
import { commandOwner } from "./battery-commands.server";
import {
  interruptPlanning,
  invalidateChargePlans,
  withChargeLimitLock,
} from "./charge-limit-loop.server";
import { CHARGE_LIMIT_BATTERY_ERROR } from "./charge-limit-status";
import { type ControlConfig, isStrategyId } from "./control";
import { readControlConfig } from "./control-config.server";
import {
  pendingControlTick,
  releaseBattery,
  releasePvArray,
  stopControlLoop,
  syncControlLoop,
} from "./control-loop.server";
import {
  bandFieldName,
  CURTAILMENT_BAND_COUNT,
  type CurtailmentBand,
  type CurtailmentConfig,
  isCurtailmentStrategyId,
  NO_CURTAILABLE_ARRAY_ERROR,
  NO_PRICES_ERROR,
  parseCurtailmentConfig,
} from "./curtailment";
import { readCurtailmentConfig } from "./curtailment-config.server";
import { appendDiagnostic } from "./diagnostics.server";
import type { Grid } from "./grid";
import { readGrid } from "./grid.server";
import { parseFormula } from "./price-formula";
import {
  isPriceConfigured,
  isPriceSourceKind,
  type PriceConfig,
  parsePriceConfig,
} from "./prices";
import { readPriceConfig } from "./prices.server";
import {
  isCurtailable,
  isPvControlMode,
  type PvEntity,
  parsePvEntity,
  pvSlug,
} from "./pv-entities";
import { listPvEntities } from "./pv-entities.server";
import { publishedLimitPercent } from "./pv-limits.server";
import { replaceSettings } from "./store.server";

const FORMAT = "elias-ems-settings";
const VERSION = 1;
export const BACKUP_MAX_BYTES = 256 * 1024;

const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value;
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const optionalNumber = (value: unknown) => value === null || number(value);
const boolean = (value: unknown) => typeof value === "boolean";
const id = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);

type Shape<T> = { [K in keyof T]-?: (value: unknown) => boolean };

const batteryShape: Shape<Battery> = {
  id,
  title: text,
  controlModes: (value) =>
    Array.isArray(value) &&
    value.every(isBatteryMode) &&
    value.includes("balance") &&
    new Set(value).size === value.length,
  commandContract: (value) => value === BATTERY_COMMAND_SCHEMA_VERSION,
  dischargeLimitSupported: boolean,
  powerStepW: number,
  chargeLimitPlanning: boolean,
  chargeEfficiencyPercent: number,
  capacityKwh: number,
  minChargePercent: number,
  maxChargePercent: number,
  energyEntityId: text,
  powerEntityId: text,
  socEntityId: text,
  steered: boolean,
  maxChargePowerW: optionalNumber,
  maxDischargePowerW: optionalNumber,
};

const pvShape: Shape<PvEntity> = {
  id,
  title: text,
  powerEntityId: text,
  energyEntityId: text,
  ratedPowerW: optionalNumber,
  curtailable: boolean,
  controlMode: isPvControlMode,
  stepLimitPercent: optionalNumber,
};

const bandShape: Shape<CurtailmentBand> = {
  abovePerKwh: number,
  ceilingPercent: number,
  exportPercent: number,
};

const curtailmentShape: Shape<CurtailmentConfig> = {
  enabled: boolean,
  strategy: isCurtailmentStrategyId,
  bands: (value) =>
    Array.isArray(value) && value.length === CURTAILMENT_BAND_COUNT,
  priceThresholdPerKwh: number,
  gridTargetW: number,
  deadbandW: number,
  minLimitPercent: number,
  settleSeconds: number,
  carChargingEntityId: text,
  chargerPowerW: number,
};

const gridShape: Shape<Grid> = { powerEntityId: text };
const controlShape: Shape<ControlConfig> = {
  enabled: boolean,
  strategy: isStrategyId,
};
const priceShape: Shape<PriceConfig> = {
  source: isPriceSourceKind,
  forecastEntityId: text,
  consumptionFormula: text,
  productionFormula: text,
};

export class SettingsBackupError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsBackupError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function fields<T>(
  value: unknown,
  shape: Shape<T>,
  label: string,
  strict: boolean,
): T {
  const record = object(value, label);
  return Object.fromEntries(
    Object.keys(shape).map((key) => {
      const field = record[key];
      if (strict && !shape[key as keyof T](field)) {
        throw new SettingsBackupError(`${label}: invalid or missing ${key}.`);
      }
      return [key, field];
    }),
  ) as T;
}

function rows<T>(
  value: unknown,
  shape: Shape<T>,
  label: string,
  strict: boolean,
): T[] {
  if (!Array.isArray(value))
    throw new SettingsBackupError(`${label} must be a list.`);
  return value.map((row, index) =>
    fields(row, shape, `${label} ${index + 1}`, strict),
  );
}

function settingsFields(value: unknown, strict: boolean) {
  const raw = object(value, "Settings");
  const curtailment = fields(
    raw.curtailment,
    curtailmentShape,
    "PV curtailment",
    strict,
  );
  return {
    batteries: rows(raw.batteries, batteryShape, "Battery", strict),
    pvEntities: rows(raw.pvEntities, pvShape, "PV array", strict),
    grid: fields(raw.grid, gridShape, "Grid", strict),
    prices: fields(raw.prices, priceShape, "Prices", strict),
    control: fields(raw.control, controlShape, "Battery control", strict),
    curtailment: {
      ...curtailment,
      bands: rows(curtailment.bands, bandShape, "Price band", strict),
    },
  };
}

type Settings = ReturnType<typeof settingsFields>;

export async function readSettings(): Promise<Settings> {
  const [batteries, pvEntities, grid, prices, control, curtailment] =
    await Promise.all([
      listBatteries(),
      listPvEntities(),
      readGrid(),
      readPriceConfig(),
      readControlConfig({ migrate: false }),
      readCurtailmentConfig(),
    ]);
  return settingsFields(
    { batteries, pvEntities, grid, prices, control, curtailment },
    false,
  );
}

export function serializeSettings(settings: Settings, space = 2): string {
  return JSON.stringify(
    { format: FORMAT, version: VERSION, settings },
    null,
    space,
  );
}

function formFor(record: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number")
      form.set(key, String(value));
    if (value === true) form.set(key, "on");
  }
  return form;
}

function validateForm(
  label: string,
  result: { ok: true } | { ok: false; errors: object },
) {
  if (result.ok) return;
  const messages = Object.values(result.errors).flatMap((value) =>
    Array.isArray(value) ? value.flatMap((row) => Object.values(row)) : [value],
  );
  throw new SettingsBackupError(`${label}: ${messages.join(" ")}`);
}

function validateUnique<T extends { id: string; title: string }>(
  records: T[],
  slug: (record: T) => string,
  label: string,
) {
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new SettingsBackupError(`${label} have duplicate IDs.`);
  }
  if (new Set(records.map(slug)).size !== records.length) {
    throw new SettingsBackupError(
      `${label} have names that use the same Home Assistant event.`,
    );
  }
}

export function parseSettingsBackup(payload: string): Settings {
  if (Buffer.byteLength(payload) > BACKUP_MAX_BYTES) {
    throw new SettingsBackupError("Choose a backup smaller than 256 KiB.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new SettingsBackupError("This file is not valid JSON.");
  }
  const backup = object(decoded, "Backup");
  if (backup.format !== FORMAT || backup.version !== VERSION) {
    throw new SettingsBackupError(
      "This is not a supported Elias ems settings backup.",
    );
  }
  const settings = settingsFields(backup.settings, true);
  const { batteries, pvEntities, control, curtailment, prices } = settings;

  batteries.forEach((battery, index) => {
    const form = formFor(battery);
    for (const mode of battery.controlModes) form.append("controlModes", mode);
    validateForm(`Battery ${index + 1}`, parseBattery(form));
  });
  pvEntities.forEach((array, index) => {
    validateForm(`PV array ${index + 1}`, parsePvEntity(formFor(array)));
  });
  validateUnique(batteries, batterySlug, "Batteries");
  validateUnique(pvEntities, pvSlug, "PV arrays");
  validateForm("Prices", parsePriceConfig(formFor(prices)));
  // The form skips hidden formulas when the source is off.
  if (prices.source === "none") {
    for (const formula of [
      prices.consumptionFormula,
      prices.productionFormula,
    ]) {
      const parsed = parseFormula(formula);
      if (!parsed.ok) throw new SettingsBackupError(`Prices: ${parsed.error}`);
    }
  }

  const curtailmentForm = formFor(curtailment);
  curtailment.bands.forEach((band, index) => {
    for (const key of [
      "abovePerKwh",
      "ceilingPercent",
      "exportPercent",
    ] as const) {
      curtailmentForm.set(bandFieldName(index, key), String(band[key]));
    }
  });
  validateForm("PV curtailment", parseCurtailmentConfig(curtailmentForm));

  if (
    control.enabled &&
    (batteries.length !== 1 || !steerableBy(batteries[0], control.strategy))
  ) {
    throw new SettingsBackupError(
      `Battery control: ${CHARGE_LIMIT_BATTERY_ERROR}`,
    );
  }
  if (curtailment.enabled && !pvEntities.some(isCurtailable)) {
    throw new SettingsBackupError(
      `PV curtailment: ${NO_CURTAILABLE_ARRAY_ERROR}`,
    );
  }
  if (curtailment.enabled && !isPriceConfigured(prices)) {
    throw new SettingsBackupError(`PV curtailment: ${NO_PRICES_ERROR}`);
  }
  return settings;
}

export function previewRevision(current: Settings, incoming: Settings): string {
  return createHash("sha256")
    .update(JSON.stringify([current, incoming]))
    .digest("hex");
}

export async function restoreSettings(incoming: Settings, revision: string) {
  interruptPlanning();
  return withChargeLimitLock(async () => {
    const current = await readSettings();
    if (revision !== previewRevision(current, incoming)) {
      throw new SettingsBackupError(
        "Settings or the backup changed. Preview the file again before applying it.",
      );
    }
    if (JSON.stringify(incoming) === JSON.stringify(current)) {
      return { restartFailed: false };
    }

    stopControlLoop();
    let restartFailed = false;
    try {
      await pendingControlTick();
      const releases: Promise<boolean>[] = [];

      for (const old of current.batteries.filter(isSteerable)) {
        if (!current.control.enabled && !commandOwner(old.id)) continue;
        const replacement = incoming.batteries.find(
          (battery) => battery.id === old.id,
        );
        if (
          !incoming.control.enabled ||
          incoming.control.strategy !== current.control.strategy ||
          JSON.stringify(old) !== JSON.stringify(replacement)
        ) {
          releases.push(releaseBattery(old));
        }
      }
      for (const old of current.pvEntities.filter(isCurtailable)) {
        if (
          !current.curtailment.enabled &&
          (publishedLimitPercent(old.id) ?? 100) === 100
        )
          continue;
        const replacement = incoming.pvEntities.find(
          (array) => array.id === old.id,
        );
        if (
          !incoming.curtailment.enabled ||
          JSON.stringify(old) !== JSON.stringify(replacement)
        ) {
          releases.push(releasePvArray(old));
        }
      }

      const outcomes = await Promise.allSettled(releases);
      if (
        outcomes.some((result) => result.status === "rejected" || !result.value)
      ) {
        throw new SettingsBackupError(
          "Home Assistant could not release one or more devices. Settings are unchanged. Some devices may already have been released. Check Diagnostics before retrying.",
        );
      }

      await replaceSettings({
        "batteries.json": incoming.batteries,
        "pv-entities.json": incoming.pvEntities,
        "grid.json": incoming.grid,
        "prices.json": incoming.prices,
        "control.json": incoming.control,
        "curtailment.json": incoming.curtailment,
      });
      appendDiagnostic("battery-control", "info", "Settings backup restored.");
    } finally {
      invalidateChargePlans();
      try {
        await syncControlLoop();
      } catch (error) {
        restartFailed = true;
        appendDiagnostic(
          "pv-curtailment",
          "error",
          `Could not restart control after settings restore: ${error}`,
        );
      }
    }
    return { restartFailed };
  });
}
