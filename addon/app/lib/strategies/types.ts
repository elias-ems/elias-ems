/**
 * The battery control strategy contract, shared by the add-on's planning loop,
 * the documentation site's Planner sandbox and the offline gym.
 *
 * A strategy is a pure function of a planning snapshot and a context: no Home
 * Assistant, no clock, no disk. Everything platform-specific — where the HiGHS
 * solver runs, how long it may take, which modes the battery's automation can
 * carry out — arrives through the context. That is what lets the same module
 * plan for a real battery, replay a downloaded export in a browser worker, and
 * be called thousands of times by a training loop with identical results.
 */
import type { solve } from "../../../../engine/src/solve.ts";
import type { Command, Input, Mode } from "../../../../engine/src/types.ts";
import type { EveningSettings } from "../charge-evening.ts";
import type {
  ChargeInterval,
  ChargeModel,
  ChargePlan,
} from "../charge-plan.ts";

/**
 * What every strategy plans from: the core of a planner export (snapshot
 * version 1), which `preparePlannerInputs` builds live and the sandbox parses
 * from a file. `settings` is Evening target's parameter block; its
 * `solarHaircut` is the reduced-solar scenario every strategy is scored on.
 */
export type PlanningSnapshot = {
  model: ChargeModel;
  slots: ChargeInterval[];
  terminalReserveKwh: number;
  settings: EveningSettings;
};

export type Capabilities = Input["capabilities"];

/** HiGHS's own result, as `engine/src/solve.ts` returns it. */
export type HighsSolveResult = Awaited<ReturnType<typeof solve>>;

export type StrategyContext = {
  /** What the battery can carry out; a strategy never plans beyond it. */
  capabilities: Capabilities;
  /** Solver budget for strategies that use one, in seconds. */
  timeLimitSeconds: number;
  /**
   * Runs HiGHS somewhere that is not the caller's thread: a browser worker in
   * the sandbox, a worker thread in the add-on and the gym.
   */
  solveHighs: (input: Input) => Promise<HighsSolveResult>;
  /**
   * Aborted when the plan is no longer wanted, such as a settings save. A
   * strategy that does its own work, rather than handing it to `solveHighs`,
   * checks it and rejects with "Planning cancelled".
   */
  signal?: AbortSignal;
};

export type StrategyResult = {
  /** One command per snapshot slot: what would be published each interval. */
  commands: Command[];
  /** The same plan in the shape the dashboard's plan card draws. */
  plan: ChargePlan;
  /** One-line outcome, e.g. "Optimal for modeled objective". */
  status: string;
  /** Lines worth showing beside the plan. */
  notes: string[];
  /** Strategy-specific extras for the sandbox and exports. */
  details?: unknown;
};

export type Strategy<Id extends string = string> = {
  /** Stored in control.json and sent as the command event's `strategy`. */
  id: Id;
  label: string;
  /** Shown under the strategy select in Settings. */
  description: string;
  /** Modes this strategy can ever issue; capabilities may narrow them. */
  supportedModes: Mode[];
  /** Whether it needs a slot ending at the evening deadline to plan. */
  needsDeadline: boolean;
  plan: (
    snapshot: PlanningSnapshot,
    context: StrategyContext,
  ) => Promise<StrategyResult>;
};
