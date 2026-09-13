import { optimizeCharge } from "../../addon/app/lib/charge-plan.ts";
import { evening } from "./evening.mjs";

export const algorithms = {
  "cost-optimized": {
    run: (data) =>
      optimizeCharge(data.slots, data.model, data.terminalReserveKwh),
    source: new URL("../../addon/app/lib/charge-plan.ts", import.meta.url),
  },
  "evening-target": {
    run: evening,
    source: new URL("../../addon/app/lib/charge-evening.ts", import.meta.url),
  },
};
