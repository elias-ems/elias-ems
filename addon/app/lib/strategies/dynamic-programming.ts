import { numeric } from "../../../../engine/src/algebra.ts";
import { evaluate, step } from "../../../../engine/src/physics.ts";
import type {
  ChargeInterval,
  Command,
  Input,
} from "../../../../engine/src/types.ts";
import { deviceLimit } from "../charge-plan.ts";
import { engineInput, planFromReplay, widestBalance } from "./score.ts";
import type { Strategy } from "./types.ts";

/** Energy states the value function is tabulated at, between floor and ceiling. */
const STATES = 160;
/** Boundary and setpoint levels tried per direction, before deduplication. */
const LEVELS = 8;
/** A cost difference below this is a tie, and a tie keeps the earlier action. */
const TIE = 1e-9;

/** A command without its interval: what a menu offers for any slot. */
type Action = Command extends infer C
  ? C extends Command
    ? Omit<C, "start" | "end">
    : never
  : never;

/** `LEVELS + 1` evenly spaced values from `from` to `to`, snapped and deduplicated. */
function ladder(from: number, to: number, snap: (w: number) => number) {
  return [
    ...new Set(
      Array.from({ length: LEVELS + 1 }, (_, i) =>
        snap(from + ((to - from) * i) / LEVELS),
      ),
    ),
  ];
}

/**
 * The commands worth trying in one interval, cheapest-to-explain first, so a
 * tie settles on balance at the device's widest boundaries.
 *
 * Without PV curtailment, balance's charge boundary can only matter where
 * solar exceeds load in some scenario and its discharge boundary only where
 * load exceeds solar, so the other one stays at its maximum. Curtailment
 * couples the two through the grid target, and gets every combination.
 */
function actions(input: Input, slot: ChargeInterval): Action[] {
  const m = input.model;
  const caps = input.capabilities;
  const { chargeLimitW: chargeMax, dischargeLimitW: dischargeMax } =
    widestBalance(m);
  const dischargeSnap = (w: number) =>
    m.dischargeStepW === undefined
      ? m.dischargeW
      : deviceLimit(w, {
          minW: m.dischargeMinW ?? 0,
          maxW: m.dischargeW,
          stepW: m.dischargeStepW,
        });
  const chargeLevels = ladder(m.maxW, m.minW, (w) => deviceLimit(w, m));
  const dischargeLevels = ladder(
    m.dischargeW,
    m.dischargeMinW ?? 0,
    dischargeSnap,
  );
  const reduced = slot.solarW * (1 - input.solarHaircut);
  const coupled = slot.curtailment !== undefined;
  const surplus = coupled || slot.solarW > slot.loadW;
  const deficit = coupled || reduced < slot.loadW;
  const result: Action[] = [];
  if (caps.modes.includes("balance"))
    for (const chargeLimitW of surplus ? chargeLevels : [chargeMax])
      for (const dischargeLimitW of deficit ? dischargeLevels : [dischargeMax])
        result.push({ mode: "balance", chargeLimitW, dischargeLimitW });
  const setpoints = (max: number) => {
    const stepW = caps.setpointStepW ?? max;
    return ladder(max, stepW, (w) =>
      Math.max(stepW, Math.floor((w + 1e-7) / stepW) * stepW),
    ).filter((w) => w <= max + 1e-7);
  };
  if (caps.modes.includes("hold"))
    result.push({
      mode: "hold",
      setpointW: 0,
      chargeLimitW: chargeMax,
      dischargeLimitW: dischargeMax,
    });
  if (caps.modes.includes("charge"))
    for (const w of setpoints(chargeMax))
      result.push({
        mode: "charge",
        setpointW: w,
        chargeLimitW: chargeMax,
        dischargeLimitW: dischargeMax,
      });
  if (caps.modes.includes("discharge"))
    for (const w of setpoints(dischargeMax))
      result.push({
        mode: "discharge",
        setpointW: -w,
        chargeLimitW: chargeMax,
        dischargeLimitW: dischargeMax,
      });
  return result;
}

function controls(u: Action) {
  return {
    balance: Number(u.mode === "balance"),
    charge: Number(u.mode === "charge"),
    discharge: Number(u.mode === "discharge"),
    chargeLimit: u.chargeLimitW / 1000,
    dischargeLimit: u.dischargeLimitW / 1000,
    chargeRequest: Math.max(0, u.setpointW ?? 0) / 1000,
    dischargeRequest: Math.max(0, -(u.setpointW ?? 0)) / 1000,
  };
}

/**
 * Backward dynamic programming over the battery's stored energy, with the
 * engine's own `step` as the transition, so what it plans is what the shared
 * replay scores.
 *
 * Each interval charges the mean of its nominal and reduced-solar cost from
 * the same state, and the state moves along the nominal forecast: the two
 * scenarios share one trajectory here, where HiGHS keeps one each. Unlike
 * HiGHS it values energy left at the end, the same way the add-on's other
 * planners do: what the terminal reserve still lacks costs the horizon's
 * lowest import price.
 */
export const dynamicProgramming: Strategy<"dynamic-programming"> = {
  id: "dynamic-programming",
  label: "Dynamic programming",
  description:
    "Plan with solar forecasts and prices for the lowest expected cost by searching every battery level interval by interval, and keep enough charge at the end of the forecast to cover demand until solar recovers. Publishes balance commands with a maximum charge power and, where supported, an AC output limit — and, for a battery whose automation allows them, hold, charge and discharge setpoints.",
  supportedModes: ["balance", "hold", "charge", "discharge"],
  needsDeadline: false,
  async plan(snapshot, context) {
    const input = engineInput(
      snapshot,
      context.capabilities,
      context.timeLimitSeconds,
    );
    const m = input.model;
    const slots = input.slots;
    const floor = (m.capacityKwh * m.minSoc) / 100;
    const ceiling = (m.capacityKwh * m.maxSoc) / 100;
    const start = (m.capacityKwh * m.soc) / 100;
    // A live SoC outside the window is a state too, without inventing a move to it.
    const low = Math.min(floor, start);
    const high = Math.max(ceiling, start);
    const width = (high - low) / STATES;
    // Fixed arrays that drop to a step once triggered stay there: one more bit of state.
    const stepping = slots.some((s) =>
      s.curtailment?.fixedArrays?.some((a) => a.stepW !== undefined),
    );
    const flags = stepping ? [0, 1] : [0];
    const reserve = Math.min(ceiling - floor, snapshot.terminalReserveKwh);
    // Unknown future prices must not outbid known demand at peak prices.
    const reservePrice =
      Math.max(0, Math.min(...slots.map((s) => s.buy))) * m.efficiency;
    const terminal = Float64Array.from(
      { length: STATES + 1 },
      (_, j) => Math.max(0, floor + reserve - (low + j * width)) * reservePrice,
    );
    const values: Float64Array[][] = new Array(slots.length + 1);
    values[slots.length] = flags.map(() => terminal);
    const future = (row: Float64Array, energy: number) => {
      const position = Math.max(0, Math.min(STATES, (energy - low) / width));
      const j = Math.min(STATES - 1, Math.floor(position));
      return row[j] + (row[j + 1] - row[j]) * (position - j);
    };
    // Each entry's engine controls are built once, not at every state.
    const menus = slots.map((slot) =>
      actions(input, slot).map((action) => ({ action, u: controls(action) })),
    );
    if (menus.some((menu) => !menu.length))
      throw new Error(
        "Dynamic programming has no command to plan with under these capabilities.",
      );
    /** The cheapest entry from one state, and where it leads at nominal solar. */
    const choose = (i: number, energy: number, stepped: number) => {
      const menu = menus[i];
      let best = 0;
      let bestTotal = Number.POSITIVE_INFINITY;
      let bestNext = energy;
      let bestStepped = stepped;
      for (let k = 0; k < menu.length; k++) {
        const { u } = menu[k];
        const nominal = step(numeric, input, slots[i], energy, stepped, u, 0);
        const reduced = step(
          numeric,
          input,
          slots[i],
          energy,
          stepped,
          u,
          input.solarHaircut,
        );
        const total =
          (nominal.cost + reduced.cost) / 2 +
          future(values[i + 1][nominal.stepped], nominal.energy);
        if (total < bestTotal - TIE) {
          best = k;
          bestTotal = total;
          bestNext = nominal.energy;
          bestStepped = nominal.stepped;
        }
      }
      return {
        action: menu[best].action,
        total: bestTotal,
        energy: bestNext,
        stepped: bestStepped,
      };
    };
    // Its own budget, like HiGHS's: overrunning it is a planning failure.
    const deadline = performance.now() + context.timeLimitSeconds * 1000;
    for (let i = slots.length - 1; i >= 0; i--) {
      values[i] = flags.map((stepped) =>
        Float64Array.from(
          { length: STATES + 1 },
          (_, j) => choose(i, low + j * width, stepped).total,
        ),
      );
      // Yield between intervals so the add-on's event loop keeps running, and
      // so a settings save can cancel a plan nobody wants any more.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (context.signal?.aborted) throw new Error("Planning cancelled");
      if (performance.now() > deadline)
        throw new Error(
          `Dynamic programming exceeded its ${context.timeLimitSeconds} s budget.`,
        );
    }
    // Forward, from the exact energy: the grid only ever shapes the decisions.
    let energy = start;
    let stepped = 0;
    const commands: Command[] = slots.map((slot, i) => {
      const chosen = choose(i, energy, stepped);
      energy = chosen.energy;
      stepped = chosen.stepped;
      return { start: slot.start, end: slot.end, ...chosen.action };
    });
    const nominal = evaluate(input, commands);
    const shortfall = Math.max(0, floor + reserve - energy);
    const balance = commands.filter((u) => u.mode === "balance").length;
    return {
      commands,
      plan: planFromReplay(input, nominal, {
        terminalReserveKwh: reserve,
        reason: `Dynamic programming over ${STATES + 1} battery levels; ${balance} of ${commands.length} intervals in balance.`,
      }),
      status:
        shortfall > 1e-6
          ? `Planned; ${shortfall.toFixed(2)} kWh short of the terminal reserve`
          : "Planned; terminal reserve covered",
      notes: [
        `Values a ${reserve.toFixed(2)} kWh reserve at the end at ${reservePrice.toFixed(4)} per kWh.`,
      ],
      details: {
        states: STATES + 1,
        actionsPerInterval: Math.max(...menus.map((menu) => menu.length)),
        terminalReserveKwh: reserve,
        reservePrice,
        shortfallKwh: shortfall,
      },
    };
  },
};
