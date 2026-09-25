import type { Battery } from "./batteries";
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
  reportedW: number | null;
  requestedW: number | null;
  reportedDischargeW?: number | null;
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
  state: "enabled" | "disabled" | "blocked" | "paused";
  message: string;
  settingsHref: string | null;
  action: string | null;
};

/** Saved authorization is independent of forecasts and plan execution. */
export function chargeLimitControl(
  control: ControlConfig,
  battery: Battery,
  batteryCount: number,
  paused: boolean,
): ChargeLimitControl {
  if (!control.enabled || control.strategy !== "charge-limit")
    return {
      state: "disabled",
      message:
        "Enable the Optimize charge limits strategy in Settings to apply plans automatically.",
      settingsHref: "/settings#battery-control",
      action: "Configure battery control",
    };
  if (batteryCount !== 1 || !battery.chargeLimitEntityId || battery.steered)
    return {
      state: "blocked",
      message:
        "Configure one battery with a maximum charge limit entity and turn off its target-power steering.",
      settingsHref: "/settings#batteries",
      action: "Edit battery",
    };
  if (paused)
    return {
      state: "paused",
      message:
        "Control paused after an external limit change. Re-save the battery settings to resume.",
      settingsHref: "/settings#batteries",
      action: "Save battery settings",
    };
  return {
    state: "enabled",
    message:
      "Battery limit control is enabled. Limits will apply once a valid plan is ready; no settings need to be saved.",
    settingsHref: null,
    action: null,
  };
}

export type ChargeLimitsData = {
  batteries: (ChargeLimitStatus & { control: ChargeLimitControl })[];
};
