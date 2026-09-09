import type { ChargePlan } from "./charge-plan";

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
export type ChargeLimitsData = { batteries: ChargeLimitStatus[] };
