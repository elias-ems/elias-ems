import {
  type EveningData,
  type EveningSettings,
  evening,
} from "./charge-evening.ts";
import { optimizeCharge } from "./charge-plan.ts";

// The algorithm table the command-line gym replays (`gym/algorithms/`).
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
