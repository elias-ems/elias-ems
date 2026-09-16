import {
  type EveningData,
  type EveningSettings,
  evening,
} from "./charge-evening.ts";
import { optimizeCharge } from "./charge-plan.ts";

// Shared by the in-app benchmark and the command-line gym.
export const benchmarkAlgorithms = {
  "cost-optimized": {
    label: "Cost optimized",
    sourceFile: "charge-plan.ts",
    run: (data: EveningData, _settings: EveningSettings) =>
      optimizeCharge(data.slots, data.model, data.terminalReserveKwh),
  },
  "evening-target": {
    label: "Evening target",
    sourceFile: "charge-evening.ts",
    run: evening,
  },
};
