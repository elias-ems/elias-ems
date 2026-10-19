import type { ChargeInterval } from "../../addon/app/lib/charge-plan.ts";
import type { PlannerDataset } from "./planner.ts";

/**
 * Synthetic forecast snapshots for one-click testing in the Planner sandbox.
 * Every number is generated here from fixed timestamps and smooth curves: none
 * comes from a household export, because this site is public.
 */
export type PlannerPreset = {
  key: string;
  name: string;
  description: string;
  dataset: PlannerDataset;
};

const QUARTER = 900_000;
const round = (value: number, digits = 0) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/** Hourly values at local hours 0–23, interpolated to `hour` (fractional). */
function hourly(values: number[], hour: number) {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  return values[i] + (values[(i + 1) % 24] - values[i]) * (h - i);
}
/** Clear-sky-shaped generation between sunrise and sunset, local hours. */
function sun(hour: number, sunrise: number, sunset: number, peakW: number) {
  const h = hour % 24;
  if (h <= sunrise || h >= sunset) return 0;
  return peakW * Math.sin((Math.PI * (h - sunrise)) / (sunset - sunrise)) ** 2;
}
/** Belgian-style dynamic tariff: spot plus supplier, grid fees and taxes. */
const buy = (spot: number) => round(spot * 1.06 + 0.12, 4);
const sell = (spot: number) => round(spot * 0.92 - 0.012, 4);

function slots(
  startIso: string,
  count: number,
  offsetHours: number,
  at: (localHour: number, day: number) => Omit<ChargeInterval, "start" | "end">,
): ChargeInterval[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => {
    const s = start + i * QUARTER;
    // Interval midpoint, in hours since local midnight of the first day.
    const local =
      (s + QUARTER / 2) / 3_600_000 +
      offsetHours -
      Math.floor((start / 3_600_000 + offsetHours) / 24) * 24;
    return {
      start: s,
      end: s + QUARTER,
      ...at(local % 24, Math.floor(local / 24)),
    };
  });
}

function dataset(
  id: string,
  model: PlannerDataset["model"],
  intervals: ChargeInterval[],
  deadlineIso: string,
  assumptions: string[],
  terminalReserveKwh = 0.5,
): PlannerDataset {
  return {
    schemaVersion: 1,
    kind: "forecast-snapshot",
    id,
    timeZone: "Europe/Brussels",
    currency: "EUR",
    model,
    slots: intervals,
    terminalReserveKwh,
    settings: {
      deadline: new Date(Date.parse(deadlineIso)).toISOString(),
      targetSoc: model.maxSoc,
      solarHaircut: 0.2,
      switchCost: 0.002,
      passes: 4,
      spikeBufferKwh: 0.54,
    },
    assumptions: [
      "Synthetic preset generated for the Planner sandbox; not measured data.",
      ...assumptions,
    ],
    context: { preset: id },
  };
}

// Autumn: solar peaks only 2–12 W above a flat midday load for five intervals.
const marginal = dataset(
  "Preset: marginal autumn surplus",
  {
    capacityKwh: 5,
    minSoc: 10,
    maxSoc: 100,
    soc: 35,
    minW: 0,
    maxW: 2500,
    stepW: 100,
    dischargeW: 2500,
    dischargeMinW: 0,
    dischargeStepW: 100,
    efficiency: 0.95,
    wearPerKwh: 0.03,
  },
  slots("2026-10-07T04:00:00Z", 96, 2, (h) => {
    const spot = hourly(
      [
        0.082, 0.078, 0.075, 0.074, 0.076, 0.084, 0.11, 0.142, 0.151, 0.128,
        0.104, 0.093, 0.088, 0.086, 0.091, 0.102, 0.125, 0.168, 0.196, 0.184,
        0.152, 0.121, 0.101, 0.09,
      ],
      h,
    );
    const solarW = round(sun(h, 7.9, 18.6, 632));
    const flat = h >= 11 && h < 15.5 ? 620 : 0;
    const loadW = Math.max(
      flat,
      round(
        330 +
          (h >= 6.5 && h < 8.5 ? 520 : 0) +
          (h >= 17.5 && h < 21.5 ? 780 : 0) +
          solarW * (flat ? 0 : 1.1),
      ),
    );
    return {
      solarW,
      loadW,
      buy: buy(spot),
      sell: sell(spot),
      estimatedPrice: false,
    };
  }),
  "2026-10-07T19:00:00Z",
  [
    "Solar exceeds load by at most 12 W, around 13:00 local time.",
    "Moderate day-ahead spread; no curtailment control.",
  ],
);

// Summer: midday spot goes negative and a curtailable inverter carries 70 % of PV.
const summer = dataset(
  "Preset: sunny summer with curtailment",
  {
    capacityKwh: 7.5,
    minSoc: 5,
    maxSoc: 100,
    soc: 20,
    minW: 0,
    maxW: 3000,
    stepW: 100,
    dischargeW: 3000,
    dischargeMinW: 0,
    dischargeStepW: 100,
    efficiency: 0.95,
    wearPerKwh: 0.03,
  },
  slots("2026-06-20T03:00:00Z", 96, 2, (h) => {
    const spot = hourly(
      [
        0.088, 0.081, 0.078, 0.076, 0.079, 0.085, 0.096, 0.104, 0.072, 0.031,
        -0.008, -0.046, -0.082, -0.104, -0.097, -0.061, -0.012, 0.045, 0.109,
        0.168, 0.214, 0.192, 0.132, 0.101,
      ],
      h,
    );
    const solarW = round(sun(h, 5.6, 22, 6200));
    const loadW = round(
      280 +
        (h >= 7 && h < 8.5 ? 450 : 0) +
        (h >= 12 && h < 12.75 ? 1600 : 0) +
        (h >= 18 && h < 21 ? 950 : 0),
    );
    const s = sell(spot);
    const fixedW = round(solarW * 0.3);
    return {
      solarW,
      loadW,
      buy: buy(spot),
      sell: s,
      estimatedPrice: h < 5,
      ...(s < 0 && solarW > 0
        ? {
            curtailment: {
              fixedW,
              availableW: solarW - fixedW,
              floorW: 0,
              // Aim for a trickle of import rather than exporting at a loss.
              gridTargetW: 30,
              exportAllowanceW: 0,
            },
          }
        : {}),
    };
  }),
  "2026-06-20T19:00:00Z",
  [
    "A non-curtailable microinverter array supplies 30 % of PV.",
    "The other 70 % follows load and battery charging, targeting 30 W of import, whenever the export price is negative.",
    "Prices after midnight local time are estimates.",
  ],
);

// Early spring: a windy night drives the buy price negative before a dear evening.
const windyNight = dataset(
  "Preset: negative night, expensive evening",
  {
    capacityKwh: 10,
    minSoc: 10,
    maxSoc: 95,
    soc: 15,
    minW: 0,
    maxW: 3500,
    stepW: 100,
    dischargeW: 3500,
    dischargeMinW: 0,
    dischargeStepW: 100,
    efficiency: 0.95,
    wearPerKwh: 0.04,
  },
  slots("2026-03-08T11:00:00Z", 144, 1, (h, day) => {
    const spot =
      day === 0
        ? hourly(
            [
              0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09,
              0.09, 0.098, 0.091, 0.087, 0.096, 0.131, 0.214, 0.262, 0.241,
              0.168, 0.071, 0.012, -0.044,
            ],
            h,
          )
        : hourly(
            [
              -0.094, -0.142, -0.161, -0.155, -0.118, -0.062, 0.024, 0.118,
              0.147, 0.121, 0.098, 0.084, 0.079, 0.083, 0.097, 0.128, 0.172,
              0.248, 0.315, 0.296, 0.231, 0.164, 0.122, 0.104,
            ],
            h,
          );
    const solarW = round(sun(h, 7.1, 18.4, 1900));
    const loadW = round(
      360 +
        (h >= 6.5 && h < 8.5 ? 700 : 0) +
        (h >= 17 && h < 21.5 ? 1200 : 0) +
        (h >= 18 && h < 18.75 ? 1800 : 0),
    );
    return {
      solarW,
      loadW,
      buy: buy(spot),
      sell: sell(spot),
      estimatedPrice: false,
    };
  }),
  "2026-03-09T20:00:00Z",
  [
    "Buy price is negative from 00:00 to 04:30 local on the second day.",
    "Evening peaks reach roughly 0.45 EUR/kWh to buy.",
  ],
);

// Winter: almost no solar; day one's spread pays for a cycle, day two's does not.
const winter = dataset(
  "Preset: cloudy winter spread",
  {
    capacityKwh: 3.6,
    minSoc: 5,
    maxSoc: 100,
    soc: 40,
    minW: 0,
    maxW: 2000,
    stepW: 100,
    dischargeW: 2000,
    dischargeMinW: 0,
    dischargeStepW: 100,
    efficiency: 0.93,
    wearPerKwh: 0.06,
  },
  slots("2026-01-13T23:00:00Z", 192, 1, (h, day) => {
    const spot =
      day === 0
        ? hourly(
            [
              0.071, 0.068, 0.066, 0.065, 0.067, 0.076, 0.112, 0.158, 0.164,
              0.139, 0.121, 0.112, 0.108, 0.109, 0.116, 0.131, 0.162, 0.204,
              0.212, 0.198, 0.161, 0.124, 0.098, 0.082,
            ],
            h,
          )
        : hourly(
            [
              0.079, 0.077, 0.076, 0.075, 0.076, 0.081, 0.093, 0.111, 0.116,
              0.108, 0.101, 0.097, 0.095, 0.096, 0.099, 0.104, 0.115, 0.128,
              0.131, 0.126, 0.114, 0.102, 0.093, 0.087,
            ],
            h,
          );
    const solarW = round(sun(h, 8.7, 16.9, 260));
    const loadW = round(
      340 +
        (h >= 6.5 && h < 8.25 ? 620 : 0) +
        (h >= 17 && h < 21.5 ? 1050 : 0) +
        (h >= 12 && h < 12.5 ? 900 : 0),
    );
    return {
      solarW,
      loadW,
      buy: buy(spot),
      sell: sell(spot),
      estimatedPrice: day > 0,
    };
  }),
  "2026-01-14T20:00:00Z",
  [
    "Overcast: solar never exceeds 260 W.",
    "Second-day prices are estimates with a narrower spread.",
  ],
);

export const presets: PlannerPreset[] = [
  {
    key: "marginal-surplus",
    name: "Marginal autumn surplus",
    description:
      "Solar beats load by only a few watts around noon. HiGHS should widen its charge boundaries to the maximum rather than match the tiny forecast surplus.",
    dataset: marginal,
  },
  {
    key: "summer-curtailment",
    name: "Sunny summer, curtailment",
    description:
      "A large midday surplus at negative export prices, with a curtailable inverter. The battery fills and PV is held back instead of exported at a loss.",
    dataset: summer,
  },
  {
    key: "negative-night",
    name: "Negative night, dear evening",
    description:
      "A windy night drives buy prices below zero before an expensive evening peak. Expanded capabilities can grid-charge overnight and discharge into the peak.",
    dataset: windyNight,
  },
  {
    key: "winter-spread",
    name: "Cloudy winter spread",
    description:
      "Almost no solar, so only the price spread matters. The first day's spread covers losses and wear; the second day's narrower one should not.",
    dataset: winter,
  },
];
