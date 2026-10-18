import { type Battery, steerableBy } from "./batteries";
import type { ChargePlan } from "./charge-plan";
import type { ControlConfig } from "./control";

export type ChargeLimitStatus = {
  batteryId: string;
  title: string;
  mode: string;
  state: "waiting" | "preview" | "active" | "error";
  message: string;
  calculatedAt: number | null;
  validUntil: number | null;
  /** The charge boundary of the command standing for this battery, in W. */
  requestedW: number | null;
  /** Its discharge boundary; null when native or nothing is standing. */
  requestedDischargeW?: number | null;
  plan: ChargePlan | null;
  currency: string;
  timeZone: string;
  times: Record<string, string>;
  forecastEnd: number | null;
  sources: number;
  historyHours: number;
  solarMarginPercent: number;
  checks?: Record<string, string>;
};
export type ChargeLimitControl = {
  state: "enabled" | "disabled" | "blocked" | "migrating";
  message: string;
  settingsHref: string | null;
  action: string | null;
};

export const CHARGE_LIMIT_BATTERY_ERROR =
  "Configure exactly one battery with Plan charge limits and Steer this battery enabled.";

/** Saved authorization is independent of forecasts and plan execution. */
export function chargeLimitControl(
  control: ControlConfig,
  battery: Battery,
  batteryCount: number,
  legacyPending: boolean,
): ChargeLimitControl {
  if (!control.enabled || control.strategy !== "charge-limit")
    return {
      state: "disabled",
      message:
        "Enable the Optimize charge limits strategy in Settings to apply plans automatically.",
      settingsHref: "/settings#battery-control",
      action: "Configure battery control",
    };
  if (batteryCount !== 1 || !steerableBy(battery, "charge-limit"))
    return {
      state: "blocked",
      message: CHARGE_LIMIT_BATTERY_ERROR,
      settingsHref: "/settings#batteries",
      action: "Edit battery",
    };
  if (legacyPending)
    return {
      state: "migrating",
      message:
        "Restoring the power limits an earlier version wrote directly. Commands start once they are back; check the add-on log if this persists.",
      settingsHref: null,
      action: null,
    };
  return {
    state: "enabled",
    message:
      "Battery limit control is enabled. Commands are published once a valid plan is ready; no settings need to be saved.",
    settingsHref: null,
    action: null,
  };
}

export type ChargeLimitsData = {
  batteries: (ChargeLimitStatus & { control: ChargeLimitControl })[];
};
