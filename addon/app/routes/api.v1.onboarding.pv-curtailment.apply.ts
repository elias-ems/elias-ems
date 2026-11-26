import { pvOnboardingAction } from "../lib/pv-onboarding-api.server";
import { apiResponse } from "../lib/settings-api.server";

export function loader() {
  return apiResponse({ error: "Use POST." }, 405, "POST");
}

export function action({ request }: { request: Request }) {
  return pvOnboardingAction(request, true);
}
