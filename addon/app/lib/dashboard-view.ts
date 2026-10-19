/**
 * Turning the dashboard's readings into what the two strategy rows say.
 *
 * Pure, and separate from the components that render it, for the same reason
 * `curtail.ts` is separate from the loop: deciding that a strategy is
 * *curtailing* rather than merely *armed* is a rule with edge cases — nothing
 * published yet, an array released at 100%, several batteries disagreeing about
 * their direction — and a rule with edge cases wants tests rather than a
 * careful read of some JSX.
 *
 * Nothing here touches a clock, a locale or a timezone. Both the server render
 * and the browser's hydration run these functions and they have to agree.
 */
import type { DashboardArray } from "./dashboard";

/**
 * How prominently a state is drawn: in the feature's own colour when it is
 * acting, outlined when it is armed with nothing to do, amber when the loop
 * that should be deciding is not running, grey when it is switched off.
 */
export type StrategyTone = "pv" | "battery" | "idle" | "warn" | "off";

export type StrategySummary = {
  tone: StrategyTone;
  /** The word in the pill. */
  state: string;
  /** The headline number, already grouped and signed. Null when there is none. */
  value: string | null;
  unit: string;
  /** 0–100 for the bar, or null when there is nothing to draw. */
  percent: number | null;
  /** What that bar is a share of. Never omitted — see `FillBar`. */
  caption: string;
};

/**
 * `2100` → `"2,100"`, `-1980` → `"-1,980"`.
 *
 * Written out rather than `toLocaleString`, which every other formatter in this
 * codebase reaches for, because those all run on the server. This one runs in
 * both places, and a browser in a locale that groups differently from the
 * container would render different markup from the one it is hydrating.
 */
export function groupThousands(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  return (
    sign +
    Math.abs(rounded)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  );
}

/** The same with an explicit `+`, for a number whose sign is the whole point. */
export function signedWatts(value: number): string {
  return value > 0 ? `+${groupThousands(value)}` : groupThousands(value);
}

/** An array is only ever held back when it is both ticked and rated. */
function isSteerable(array: DashboardArray): boolean {
  return array.curtailable && (array.ratedPowerW ?? 0) > 0;
}

export function curtailmentSummary(
  arrays: DashboardArray[],
  loop: { enabled: boolean; running: boolean },
): StrategySummary {
  if (!loop.enabled) {
    return {
      tone: "off",
      state: "Disabled",
      value: null,
      unit: "",
      percent: null,
      caption: "no limit is being published for any array",
    };
  }

  if (!loop.running) {
    return {
      tone: "warn",
      state: "Loop stopped",
      value: null,
      unit: "",
      percent: null,
      caption: "enabled, but nothing is deciding",
    };
  }

  const steerable = arrays.filter(isSteerable);

  if (steerable.length === 0) {
    return {
      tone: "idle",
      state: "Nothing to steer",
      value: null,
      unit: "",
      percent: null,
      caption: "no array is both curtailable and rated",
    };
  }

  // A limit of 100 is a decision — "generate freely" — and so is not being held
  // back. Null is the third state: this array has not been told anything since
  // the add-on started.
  const held = steerable.filter(
    (array) => array.limitPercent !== null && array.limitPercent < 100,
  );

  if (held.length === 0) {
    // "Released at 100%" and "never told anything" are both armed, but only the
    // first is a decision. Claiming an array is released when nothing has gone
    // out to it would be the page inventing a fact about the hardware — and it
    // would contradict the device table, which reports the two separately.
    const released = steerable.some((array) => array.limitPercent !== null);

    return {
      tone: "idle",
      state: "Armed",
      value: released ? "100" : null,
      unit: released ? "%" : "",
      percent: released ? 100 : null,
      caption: released
        ? `${steerable.length === 1 ? "the array is" : "all arrays are"} released — generating freely`
        : "nothing published yet — no array has been given a limit",
    };
  }

  // The most limited one, because that is the array the reader wants named: a
  // mean across several would describe none of them.
  const lowest = held.reduce((worst, array) =>
    (array.limitPercent ?? 100) < (worst.limitPercent ?? 100) ? array : worst,
  );
  const percent = lowest.limitPercent ?? 0;
  const rated = lowest.ratedPowerW;
  const others = held.length - 1;

  return {
    tone: "pv",
    state: "Curtailing",
    value: String(percent),
    unit: "%",
    percent,
    caption: [
      rated
        ? `limit on ${lowest.title} · ${groupThousands((rated * percent) / 100)} W of ${groupThousands(rated)} W`
        : `limit on ${lowest.title}`,
      others > 0 ? `${others} more held back` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
