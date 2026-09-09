/** Deterministic Energy dashboard responses for end-to-end forecast plumbing. */
export function chargeForecastFixture(now = Date.now()) {
  const hour = 3_600_000;
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  const wh_hours = {};
  for (let i = 0; i < 7 * 24; i++) {
    wh_hours[new Date(today + i * hour).toISOString()] =
      Math.max(0, Math.sin((((i % 24) - 6) / 12) * Math.PI)) * 3500;
  }
  const counters = {
    pv: 1,
    imported: 0.4,
    exported: 0.3,
    discharged: 0.1,
    charged: 0.7,
  };
  const statistics = {};
  for (const [id, change] of Object.entries(counters)) {
    statistics[id] = Array.from({ length: 14 * 24 }, (_, i) => {
      const start = today - (14 * 24 - i) * hour;
      return { start, end: start + hour, change };
    });
  }
  return {
    get_config: { time_zone: "Europe/Brussels" },
    "energy/get_prefs": {
      energy_sources: [
        {
          type: "solar",
          stat_energy_from: "pv",
          config_entry_solar_forecast: ["helios-test"],
        },
        {
          type: "grid",
          stat_energy_from: "imported",
          stat_energy_to: "exported",
        },
        {
          type: "battery",
          stat_energy_from: "discharged",
          stat_energy_to: "charged",
        },
      ],
    },
    "energy/solar_forecast": { "helios-test": { wh_hours } },
    "recorder/statistics_during_period": statistics,
  };
}

export const chargeBatteryFixture = {
  id: "charge-test",
  title: "Home battery",
  capacityKwh: 5,
  minChargePercent: 10,
  maxChargePercent: 95,
  energyEntityId: "sensor.battery_energy_total",
  powerEntityId: "sensor.battery_power",
  socEntityId: "sensor.battery_state_of_charge",
  steered: false,
  maxChargePowerW: 2000,
  maxDischargePowerW: 2000,
  chargeLimitEntityId: "number.battery_charge_limit",
  chargeLimitMode: "preview",
  chargeEfficiencyPercent: 95,
  solarMarginPercent: 20,
  chargeWearPerKwh: 0,
};

export const chargeEntityFixture = {
  entity_id: "number.battery_charge_limit",
  state: "2000",
  attributes: {
    friendly_name: "Battery maximum charge limit",
    unit_of_measurement: "W",
    min: 0,
    max: 2000,
    step: 10,
  },
};
