import { withChargeLimitLock } from "../lib/charge-limit-loop.server";
import { apiResponse, readSettingsApi } from "../lib/settings-api.server";

export function loader() {
  return withChargeLimitLock(async () => apiResponse(await readSettingsApi()));
}

export function action() {
  return apiResponse({ error: "Use GET." }, 405, "GET");
}
