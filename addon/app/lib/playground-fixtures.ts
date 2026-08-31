/**
 * The data the component playground draws with.
 *
 * Made up rather than read: the point of the playground is to see every
 * component in every state it has, including the ones a healthy installation
 * never reaches — an unreadable sensor, a price feed that failed, a loop that
 * is enabled but not running. Those cannot be produced by configuring anything,
 * so they have to be written down.
 *
 * Two rules hold this file together.
 *
 * Everything takes `now` rather than reading a clock. The playground renders on
 * the server and hydrates in the browser, and any value derived from
 * `Date.now()` here would be computed twice — once per side, a few milliseconds
 * apart — which is exactly the mismatch React warns about. The route's loader
 * stamps one `now`, it crosses the wire with the rest of the loader's data, and
 * both renders build from that same number.
 *
 * And nothing here is locale-dependent. Every string a component would have
 * received already formatted from a `.server` module arrives already formatted
 * here too, for the same reason: `toLocaleString` in the browser and
 * `toLocaleString` in an Alpine container do not agree about separators.
 */
import type { Battery } from "./batteries";
import type { ControlConfig } from "./control";
import type { CurtailmentConfig } from "./curtailment";
import {
  CHARGER_POWER_REQUIRED_ERROR,
  DEFAULT_CURTAILMENT_CONFIG,
} from "./curtailment";
import type {
  DashboardArray,
  DashboardBattery,
  DashboardGrid,
  DashboardPrices,
  PriceCurvePoint,
} from "./dashboard";
import type { DiagnosticEntry } from "./diagnostics";
import type { Grid } from "./grid";
import type { PriceConfig, PriceSourceSummary } from "./prices";
import type { PvEntity } from "./pv-entities";
import type { LiveHealth, Reading } from "./readings";
import type { SettingsActionData } from "./settings-form";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A reading that is current: what the sensor says, and when it last moved. */
function live(display: string, agoMs: number, now: number): Reading {
  return { display, ok: true, updatedAt: now - agoMs };
}

/** One that isn't — unavailable, unknown, or pointing at nothing. */
function broken(display: string, updatedAt: number | null): Reading {
  return { display, ok: false, updatedAt };
}

/**
 * `14:32:07` for a moment, in UTC.
 *
 * The real entries carry the server's timezone, formatted where the buffer
 * lives. Here the string only has to be stable between the two renders, and UTC
 * is the one timezone both sides agree on without being told.
 */
function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function entry(
  seq: number,
  agoMs: number,
  now: number,
  origin: DiagnosticEntry["origin"],
  level: DiagnosticEntry["level"],
  message: string,
  repeat = 1,
): DiagnosticEntry {
  const at = now - agoMs;
  return {
    seq,
    at: new Date(at).toISOString(),
    time: clockTime(at),
    origin,
    level,
    message,
    repeat,
  };
}

/**
 * A day with a solar glut in it: the selling price goes negative either side of
 * noon and peaks in the evening.
 *
 * Shaped that way on purpose. A flat curve would draw the same chart whatever
 * the threshold is, and the whole point of the threshold line is the band of
 * hours it cuts off — which only exists on a day where exporting is sometimes
 * worth money and sometimes isn't.
 */
const PRICE_CURVE: PriceCurvePoint[] = [
  0.081, 0.074, 0.07, 0.068, 0.072, 0.089, 0.112, 0.128, 0.101, 0.062, 0.021,
  -0.004, -0.018, -0.021, -0.009, 0.014, 0.048, 0.087, 0.134, 0.161, 0.152,
  0.128, 0.104, 0.092,
].map((sellingPerKwh, hour) => ({
  startMinutes: hour * 60,
  sellingPerKwh,
}));

/** 13:00, which sits in the negative band above — where curtailment acts. */
const NOW_MINUTES = 13 * 60;

export type PlaygroundFixtures = ReturnType<typeof playgroundFixtures>;

export function playgroundFixtures(now: number) {
  const arrays: DashboardArray[] = [
    {
      id: "roof",
      title: "Roof",
      power: live("2,140 W", 4 * SECOND, now),
      energy: live("8,421.33 kWh", 4 * SECOND, now),
      powerW: 2140,
      ratedPowerW: 5000,
      curtailable: true,
      // Held back: the price is below the threshold, which is the state the
      // dashboard exists to make visible.
      limitPercent: 45,
    },
    {
      id: "shed",
      title: "Shed",
      power: live("980 W", 11 * SECOND, now),
      energy: live("3,104.80 kWh", 11 * SECOND, now),
      powerW: 980,
      ratedPowerW: 2500,
      // Released rather than never told, which the table reports separately.
      limitPercent: 100,
      curtailable: true,
    },
    {
      id: "carport",
      title: "Carport",
      // Watched but not steerable, and its sensor is down — two independent
      // states that happen to be worth seeing on one row.
      power: broken("unavailable", now - 6 * MINUTE),
      energy: null,
      powerW: null,
      ratedPowerW: null,
      curtailable: false,
      limitPercent: null,
    },
  ];

  const batteries: DashboardBattery[] = [
    {
      id: "home",
      title: "Home battery",
      window: "10–90% of 10 kWh",
      charge: live("76 %", 9 * SECOND, now),
      power: live("-1,980 W", 2 * SECOND, now),
      energy: live("2,450.75 kWh", 2 * SECOND, now),
      chargePercent: 76,
      targetW: -1980,
    },
    {
      id: "garage",
      title: "Garage battery",
      window: "15–95% of 5 kWh",
      charge: live("41 %", 40 * SECOND, now),
      power: live("0 W", 3 * MINUTE, now),
      energy: live("612.40 kWh", 3 * MINUTE, now),
      chargePercent: 41,
      // Nothing published for this one, which is not the same as a target of 0.
      targetW: null,
    },
  ];

  const grid: DashboardGrid = {
    configured: true,
    power: live("842 W", SECOND, now),
    powerW: 842,
  };

  const prices: DashboardPrices = {
    configured: true,
    consumption: "0.2841 EUR/kWh",
    production: "-0.0210 EUR/kWh",
    spot: "-0.0180 EUR/kWh",
    productionPerKwh: -0.021,
    slot: "13:00–13:15",
    coverage: "through tomorrow 23:45",
    currency: "EUR",
    curve: PRICE_CURVE,
    nowMinutes: NOW_MINUTES,
    error: null,
  };

  const health: LiveHealth = {
    connected: true,
    lastEventAt: new Date(now - 3 * SECOND).toISOString(),
    connectedSince: new Date(now - 47 * MINUTE).toISOString(),
    lastError: null,
    reconnects: 0,
    source: "live",
  };

  /**
   * Both loops' entries interleaved, newest first — the order
   * `readDiagnostics` returns and the feed renders.
   *
   * One of them is multi-line, because a control tick is a summary plus a line
   * per battery and the boxes have to keep those newlines.
   */
  const decisions: DiagnosticEntry[] = [
    entry(
      812,
      4 * SECOND,
      now,
      "battery-control",
      "info",
      [
        "Grid net +842 W (importing) → discharge 842 W across 1 battery. (live)",
        "  Home battery: -1,980 W → -1,980 W (unchanged, within 50 W)",
      ].join("\n"),
      6,
    ),
    entry(
      811,
      6 * SECOND,
      now,
      "pv-curtailment",
      "info",
      "Selling at -0.0210 EUR/kWh, below the 0.0000 EUR/kWh threshold. Grid net +842 W — target within the 50 W deadband, holding.",
    ),
    entry(
      809,
      52 * SECOND,
      now,
      "pv-curtailment",
      "warn",
      [
        "Selling at -0.0210 EUR/kWh, below the 0.0000 EUR/kWh threshold. Grid net -1,420 W (exporting), arrays at 3,120 W → allow 1,700 W total.",
        "! Carport is unavailable — decided without it",
        "  Roof: 62% → 45%",
      ].join("\n"),
    ),
    entry(
      804,
      4 * MINUTE,
      now,
      "battery-control",
      "error",
      "Released the batteries, but Garage battery (no automation listening) did not go out — check it is not still being driven.",
    ),
    entry(
      801,
      12 * MINUTE,
      now,
      "pv-curtailment",
      "info",
      "Released the arrays to 100%.",
    ),
  ];

  /** The prices origin logs parse failures rather than decisions. */
  const priceLog: DiagnosticEntry[] = [
    entry(
      798,
      31 * MINUTE,
      now,
      "prices",
      "info",
      "sensor.energi_epex_spot: 96 slots today, 96 tomorrow, in EUR/kWh.",
    ),
    entry(
      795,
      2 * 60 * MINUTE,
      now,
      "prices",
      "warn",
      "sensor.energi_epex_spot published no forecast for tomorrow yet — today only.",
    ),
  ];

  return {
    now,
    arrays,
    batteries,
    grid,
    prices,
    health,
    decisions,
    priceLog,

    /** The states of one reading, for `Measurement`. */
    readings: {
      live: live("2,140 W", 4 * SECOND, now),
      stale: live("0 W", 6 * 60 * MINUTE, now),
      unavailable: broken("unavailable", now - 6 * MINUTE),
      missing: broken("no such entity", null),
      never: null,
    },

    /** The states of the live path, for `LiveStatus` and `LiveHealthFacts`. */
    healths: {
      live: health,
      quiet: {
        ...health,
        lastEventAt: null,
        connectedSince: new Date(now - 90 * SECOND).toISOString(),
      },
      reconnecting: {
        connected: false,
        lastEventAt: new Date(now - 4 * MINUTE).toISOString(),
        connectedSince: null,
        lastError: "socket hang up",
        reconnects: 3,
        source: "rest",
      },
    } satisfies Record<string, LiveHealth>,

    /** The variants of the two cards that have a "nothing configured" state. */
    gridStates: {
      importing: grid,
      exporting: {
        configured: true,
        power: live("-1,420 W", 2 * SECOND, now),
        powerW: -1420,
      },
      unreadable: {
        configured: true,
        power: broken("unavailable", now - 8 * MINUTE),
        powerW: null,
      },
      unconfigured: { configured: false, power: null, powerW: null },
    } satisfies Record<string, DashboardGrid>,

    priceStates: {
      negative: prices,
      positive: {
        ...prices,
        consumption: "0.3104 EUR/kWh",
        production: "0.1340 EUR/kWh",
        spot: "0.1520 EUR/kWh",
        productionPerKwh: 0.134,
        slot: "19:00–19:15",
        nowMinutes: 19 * 60,
      },
      failed: {
        ...prices,
        consumption: null,
        production: null,
        spot: null,
        productionPerKwh: null,
        slot: null,
        coverage: null,
        curve: [],
        nowMinutes: null,
        error: "sensor.energi_epex_spot has no forecast attribute.",
      },
      unconfigured: {
        configured: false,
        consumption: null,
        production: null,
        spot: null,
        productionPerKwh: null,
        slot: null,
        coverage: null,
        currency: "EUR",
        curve: [],
        nowMinutes: null,
        error: null,
      },
    } satisfies Record<string, DashboardPrices>,

    /** What settings holds, for the section components. */
    settings: {
      grid: { powerEntityId: "sensor.grid_power" } satisfies Grid,
      emptyGrid: { powerEntityId: "" } satisfies Grid,
      pvEntities: [
        {
          id: "roof",
          title: "Roof",
          powerEntityId: "sensor.inverter_power",
          energyEntityId: "sensor.inverter_energy_total",
          ratedPowerW: 5000,
          curtailable: true,
          controlMode: "modulating",
          stepLimitPercent: null,
        },
        {
          id: "carport",
          title: "Carport",
          powerEntityId: "sensor.carport_power",
          energyEntityId: "sensor.carport_energy_total",
          // Watched but not steerable, which the summary line spells out.
          ratedPowerW: null,
          curtailable: false,
          controlMode: "modulating",
          stepLimitPercent: null,
        },
      ] satisfies PvEntity[],
      batteries: [
        {
          id: "home",
          title: "Home battery",
          capacityKwh: 10,
          minChargePercent: 10,
          maxChargePercent: 90,
          energyEntityId: "sensor.battery_energy_total",
          powerEntityId: "sensor.battery_power",
          socEntityId: "sensor.battery_state_of_charge",
          steered: true,
          maxChargePowerW: 3600,
          maxDischargePowerW: 3600,
        },
        {
          id: "garage",
          title: "Garage battery",
          capacityKwh: 5,
          minChargePercent: 15,
          maxChargePercent: 95,
          energyEntityId: "sensor.garage_battery_energy_total",
          powerEntityId: "sensor.garage_battery_power",
          socEntityId: "sensor.garage_battery_soc",
          steered: false,
          maxChargePowerW: null,
          maxDischargePowerW: null,
        },
      ] satisfies Battery[],
      control: {
        enabled: true,
        strategy: "net-zero-energy",
        intervalSeconds: 5,
      } satisfies ControlConfig,
      curtailment: {
        ...DEFAULT_CURTAILMENT_CONFIG,
        enabled: true,
        strategy: "graded-export",
        // Filled in, so the specimen shows the state a working installation is
        // actually in rather than an empty pair of fields.
        carChargingEntityId: "binary_sensor.evcc_charging",
        chargerPowerW: 11000,
      } satisfies CurtailmentConfig,
      prices: {
        source: "home-assistant",
        forecastEntityId: "sensor.energi_epex_spot",
        consumptionFormula: "((price * 1.02) + 0.1272) * 1.06",
        productionFormula: "max(price * 0.98 - 0.015, 0)",
      } satisfies PriceConfig,
      priceSummary: {
        ok: true,
        detail: "96 slots today, 96 tomorrow, in EUR/kWh.",
        spot: "-0.0180 EUR/kWh",
        consumption: "0.1153 EUR/kWh",
        production: "0.0000 EUR/kWh",
        spotPerKwh: -0.018,
        currency: "EUR",
      } satisfies PriceSourceSummary,
      failedPriceSummary: {
        ok: false,
        detail: "sensor.energi_epex_spot has no forecast attribute.",
        spot: null,
        consumption: null,
        production: null,
        spotPerKwh: null,
        currency: "EUR",
      } satisfies PriceSourceSummary,
      /**
       * What the section is handed while no source is picked. The prop is
       * required even then — the section hides everything that reads it rather
       * than making it optional, so there is exactly one shape to reason about.
       */
      noPriceSummary: {
        ok: false,
        detail: "No price source picked.",
        spot: null,
        consumption: null,
        production: null,
        spotPerKwh: null,
        currency: "EUR",
      } satisfies PriceSourceSummary,
    },

    /**
     * A rejected submission per section, so each one can be shown with its
     * fields lit up. The real thing comes back from the settings action; here
     * it is handed straight in as a prop.
     */
    failures: {
      grid: {
        section: "grid",
        recordId: null,
        errors: { powerEntityId: "Pick the grid power sensor." },
      },
      pv: {
        section: "pv",
        recordId: null,
        errors: {
          title: "Another array already makes the same event type.",
          ratedPowerW: "Give the inverter's rated output in W.",
        },
      },
      battery: {
        section: "battery",
        recordId: null,
        errors: {
          capacityKwh: "Capacity has to be more than zero.",
          maxChargePercent: "The top of the window has to be above the bottom.",
        },
      },
      control: {
        section: "control",
        recordId: null,
        errors: { intervalSeconds: "Pick something between 1 and 3600 s." },
      },
      curtailment: {
        section: "curtailment",
        recordId: null,
        errors: {
          settleSeconds: "Pick something between 5 and 600 s.",
          chargerPowerW: CHARGER_POWER_REQUIRED_ERROR,
        },
      },
      prices: {
        section: "prices",
        recordId: null,
        errors: {
          productionFormula: "Unknown name: spot. Only price is available.",
        },
      },
    } satisfies Record<string, SettingsActionData>,
  };
}
