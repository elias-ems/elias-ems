import { withChargeLimitLock } from "../lib/charge-limit-loop.server";
import { readPvOnboarding } from "../lib/pv-onboarding-api.server";
import { apiResponse } from "../lib/settings-api.server";

export function loader() {
  return withChargeLimitLock(readPvOnboarding);
}

export function action() {
  return apiResponse({ error: "Use GET." }, 405, "GET");
}
