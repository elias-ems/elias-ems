import assert from "node:assert/strict";
import test from "node:test";
import { simulateCharge } from "../../addon/app/lib/charge-plan.ts";
import { plan } from "../node.mjs";
import { evaluate } from "../src/physics.ts";

function fixture() {
  return {
    model: {
      capacityKwh: 4,
      minSoc: 0,
      maxSoc: 100,
      soc: 25,
      minW: 0,
      maxW: 2000,
      stepW: 500,
      dischargeW: 2000,
      dischargeMinW: 0,
      dischargeStepW: 500,
      efficiency: 0.9,
      wearPerKwh: 0.01,
    },
    slots: [0, 1, 2].map((i) => ({
      start: i * 3600000,
      end: (i + 1) * 3600000,
      solarW: i === 1 ? 3000 : 0,
      loadW: 500,
      buy: i === 0 ? -0.2 : 0.4,
      sell: 0.1,
      estimatedPrice: false,
    })),
    solarHaircut: 0.2,
    capabilities: {
      modes: ["balance"],
      gridCharging: false,
      batteryExport: false,
    },
    timeLimitSeconds: 10,
  };
}
test("balance optimum conserves energy and reproduces native simulator", async () => {
  const input = fixture();
  const result = await plan(input);
  assert.ok(result.commands, JSON.stringify(result));
  assert.equal(result.optimal, true);
  let energy = 1;
  for (const [i, p] of result.scenarios[0].points.entries()) {
    const native = simulateCharge(
      input.slots[i],
      energy,
      p.chargeLimitW,
      input.model,
      false,
      p.dischargeLimitW,
    );
    energy = native.energy;
    assert.ok(Math.abs(p.soc * 0.04 - energy) < 1e-6);
    assert.ok(Math.abs(p.cost - native.cost) < 1e-6);
    assert.equal(p.mode, "balance");
    assert.ok(
      Math.abs(
        input.slots[i].solarW +
          p.importW +
          p.dischargeW -
          input.slots[i].loadW -
          p.chargeW -
          p.exportW,
      ) < 1e-6,
    );
  }
  assert.equal(result.scenarios[0].points[0].chargeW, 0);
});
test("expanded explicit permissions exploit negative import price without simultaneous flows", async () => {
  const input = fixture();
  input.capabilities = {
    modes: ["balance", "hold", "charge", "discharge"],
    gridCharging: true,
    batteryExport: true,
    setpointStepW: 500,
  };
  const result = await plan(input);
  assert.ok(result.commands, JSON.stringify(result));
  assert.equal(result.commands[0].mode, "charge");
  for (const s of result.scenarios)
    for (const p of s.points) {
      assert.ok(p.chargeW === 0 || p.dischargeW === 0);
      assert.ok(p.importW === 0 || p.exportW === 0);
      assert.ok(p.soc >= -1e-5 && p.soc <= 100.00001);
    }
});
test("hold is zero battery power, not a balanced meter", () => {
  const input = fixture();
  input.capabilities.modes.push("hold");
  const commands = input.slots.map((s) => ({
    ...s,
    mode: "hold",
    setpointW: 0,
    chargeLimitW: 2000,
    dischargeLimitW: 2000,
  }));
  const p = evaluate(input, commands).points[0];
  assert.equal(p.batteryW, 0);
  assert.equal(p.importW, 500);
});
test("explicit capability validation and time limit do not fabricate plans", async () => {
  const input = fixture();
  input.capabilities.modes = ["charge"];
  await assert.rejects(plan(input), /explicit setpoint/);
  input.capabilities.modes = ["balance"];
  input.timeLimitSeconds = 0.000001;
  const result = await plan(input);
  assert.equal(result.optimal, false);
  assert.equal(result.commands, undefined);
});
test("shared balance replay agrees with stateful PV simulator including reduced solar", () => {
  const input = fixture();
  input.slots = [0, 1, 2].map((i) => ({
    ...input.slots[i],
    solarW: 3000,
    curtailment: {
      fixedW: 1000,
      fixedArrays: [{ availableW: 1000, ceilingW: 1000, stepW: 200 }],
      availableW: 2000,
      floorW: 100,
      modulatingArrays: [{ availableW: 2000, floorW: 100 }],
      gridTargetW: 50,
      exportAllowanceW: 100,
      deadbandW: 100,
    },
  }));
  for (const haircut of [0, 0.2])
    for (const limit of [0, 500, 2000]) {
      const commands = input.slots.map((s) => ({
        ...s,
        mode: "balance",
        chargeLimitW: limit,
        dischargeLimitW: 2000,
      }));
      const actual = evaluate(input, commands, haircut);
      let energy = 1,
        stepped = false;
      for (const [i, p] of actual.points.entries()) {
        const s = structuredClone(input.slots[i]);
        s.solarW *= 1 - haircut;
        s.curtailment.fixedW *= 1 - haircut;
        s.curtailment.availableW *= 1 - haircut;
        for (const arr of [
          ...s.curtailment.fixedArrays,
          ...s.curtailment.modulatingArrays,
        ])
          arr.availableW *= 1 - haircut;
        const n = simulateCharge(s, energy, limit, input.model, stepped, 2000);
        energy = n.energy;
        stepped = n.stepped;
        assert.ok(Math.abs(p.soc * 0.04 - energy) < 1e-7);
        assert.ok(Math.abs(p.generatedSolarW - n.solarW) < 1e-7);
        assert.ok(Math.abs(p.cost - n.cost) < 1e-7);
      }
    }
});
test("exhaustive discrete balance schedules match the cost-only optimum", async () => {
  const input = fixture();
  input.model.maxW = 1000;
  input.model.dischargeW = 1000;
  input.solarHaircut = 0;
  const result = await plan(input);
  assert.equal(result.optimal, true);
  let bestCost = Infinity;
  for (let mask = 0; mask < 729; mask++) {
    let n = mask;
    const commands = input.slots.map((s) => {
      const chargeLimitW = (n % 3) * 500;
      n = Math.floor(n / 3);
      const dischargeLimitW = (n % 3) * 500;
      n = Math.floor(n / 3);
      return { ...s, mode: "balance", chargeLimitW, dischargeLimitW };
    });
    const run = evaluate(input, commands);
    bestCost = Math.min(bestCost, run.cost);
  }
  assert.ok(Math.abs(result.scenarios[0].cost - bestCost) < 1e-6);
});
test("PV solver schedule passes exact replay and cannot manufacture solar", async () => {
  const input = fixture();
  input.slots[1].curtailment = {
    fixedW: 0,
    availableW: 3000,
    floorW: 0,
    gridTargetW: 0,
    exportAllowanceW: 0,
  };
  input.slots[1].sell = -0.5;
  const r = await plan(input);
  assert.ok(r.commands, JSON.stringify(r));
  for (const p of r.scenarios[0].points)
    assert.ok(
      p.generatedSolarW <=
        input.slots[r.scenarios[0].points.indexOf(p)].solarW + 1e-6,
    );
  assert.ok(r.scenarios[0].points[1].curtailedW > 0);
});
test("cost-only leaves an empty battery empty when charging has no benefit", async () => {
  const input = fixture();
  input.model.soc = 0;
  input.slots.forEach((s) => {
    s.solarW = 0;
    s.buy = 1;
  });
  input.capabilities = {
    modes: ["hold", "charge"],
    gridCharging: true,
    batteryExport: false,
    setpointStepW: 500,
  };
  const r = await plan(input);
  assert.ok(r.commands);
  assert.equal(r.optimal, true);
  assert.equal(r.scenarios[0].finalSoc, 0);
  assert.ok(r.scenarios[0].points.every((p) => p.chargeW === 0));
  assert.equal(r.statuses.length, 1);
  assert.equal("targetProof" in r, false);
  assert.equal("targetStatus" in r, false);
  assert.equal("shortfallKwh" in r.scenarios[0], false);
});
test("infeasible direct-only configuration never supplies a schedule", async () => {
  const input = fixture();
  input.capabilities = {
    modes: ["charge"],
    gridCharging: true,
    batteryExport: false,
    setpointStepW: 3000,
  };
  const r = await plan(input);
  assert.equal(r.status, "Infeasible");
  assert.equal(r.commands, undefined);
  assert.equal(r.optimal, false);
});
test("direct permissions clip requests and preserve energy with losses", () => {
  const input = fixture();
  input.capabilities.modes.push("charge", "discharge");
  input.capabilities.setpointStepW = 500;
  const commands = input.slots.map((s, i) => ({
    ...s,
    mode: i === 1 ? "discharge" : "charge",
    setpointW: i === 1 ? -2000 : 2000,
    chargeLimitW: 2000,
    dischargeLimitW: 2000,
  }));
  const r = evaluate(input, commands);
  assert.equal(r.points[0].chargeW, 0);
  assert.equal(r.points[1].dischargeW, 0);
  input.capabilities.gridCharging = true;
  input.capabilities.batteryExport = true;
  const permitted = evaluate(input, commands);
  let energy = 1;
  for (const [i, p] of permitted.points.entries()) {
    energy += (p.chargeW / 1000) * 0.9 - p.dischargeW / 1000 / 0.9;
    assert.ok(Math.abs(p.soc * 0.04 - energy) < 1e-7);
    assert.ok(
      Math.abs(
        p.generatedSolarW +
          p.importW +
          p.dischargeW -
          input.slots[i].loadW -
          p.chargeW -
          p.exportW,
      ) < 1e-7,
    );
  }
});
test("native discharge without a writable output limit cannot be held in balance", async () => {
  const input = fixture();
  delete input.model.dischargeStepW;
  delete input.model.dischargeMinW;
  const result = await plan(input);
  assert.ok(result.commands);
  assert.equal(result.scenarios[0].points[0].dischargeW, 500);
  assert.ok(
    result.commands.every((p) => p.dischargeLimitW === input.model.dischargeW),
  );
});
test("worker keeps the Node event loop responsive and can be cancelled", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    await plan(fixture());
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
  }
  const controller = new AbortController();
  const pending = plan(fixture(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
test("fixed-step curtailment solver validates the persistent episode", async () => {
  const input = fixture();
  // Fix the boundaries: this test checks curtailment state across intervals;
  // the exhaustive schedule test separately establishes cost optimality.
  input.model.minW = input.model.maxW;
  input.model.dischargeMinW = input.model.dischargeW;
  for (const s of input.slots) {
    s.solarW = 3000;
    s.curtailment = {
      fixedW: 1000,
      fixedArrays: [{ availableW: 1000, ceilingW: 1000, stepW: 100 }],
      availableW: 2000,
      floorW: 0,
      gridTargetW: 0,
      exportAllowanceW: 0,
      deadbandW: 111,
    };
  }
  const result = await plan(input);
  assert.ok(result.commands, JSON.stringify(result));
  assert.equal(result.optimal, true);
});

test("invalid Node requests reject before starting a worker", async () => {
  for (const input of [
    null,
    {},
    { timeLimitSeconds: NaN },
    { timeLimitSeconds: -1 },
    { timeLimitSeconds: 121 },
  ]) {
    await assert.rejects(plan(input), /Invalid solve budget/);
  }
});
test("mode contracts reject missing, opposite-sign and inapplicable setpoints", () => {
  const input = fixture();
  input.capabilities.modes = ["balance", "hold", "charge", "discharge"];
  input.capabilities.setpointStepW = 500;
  const commands = input.slots.map((s) => ({
    start: s.start,
    end: s.end,
    mode: "balance",
    chargeLimitW: 2000,
    dischargeLimitW: 2000,
  }));
  for (const control of [
    { mode: "balance", setpointW: 0 },
    { mode: "hold" },
    { mode: "hold", setpointW: 500 },
    { mode: "charge" },
    { mode: "charge", setpointW: -500 },
    { mode: "charge", setpointW: 2500 },
    { mode: "discharge", setpointW: 500 },
    { mode: "charge", setpointW: 123 },
  ]) {
    assert.throws(
      () =>
        evaluate(input, [{ ...commands[0], ...control }, ...commands.slice(1)]),
      /Invalid mode setpoint/,
    );
  }
  assert.throws(() => evaluate(input, commands, 1), /scenario reduction/);
});

test("cost-only spends available energy without preserving an evening or terminal reserve", async () => {
  const input = fixture();
  input.model.soc = 50;
  input.model.efficiency = 1;
  input.slots = input.slots
    .slice(0, 2)
    .map((s) => ({ ...s, solarW: 0, loadW: 1000, buy: 0.5 }));
  const result = await plan(input);
  assert.equal(result.optimal, true);
  for (const scenario of result.scenarios) {
    assert.ok(Math.abs(scenario.cost) < 1e-7);
    assert.ok(Math.abs(scenario.finalSoc) < 1e-7);
    assert.ok(
      scenario.points.every((p) => Math.abs(p.dischargeW - 1000) < 1e-7),
    );
  }
});

test("equal-cost expanded plans prefer balance throughout the horizon", async () => {
  const input = fixture();
  input.solarHaircut = 0;
  input.capabilities = {
    modes: ["balance", "hold", "charge", "discharge"],
    gridCharging: true,
    batteryExport: true,
    setpointStepW: 500,
  };
  for (const slot of input.slots) {
    slot.solarW = 500;
    slot.loadW = 500;
    slot.buy = 0.3;
    slot.sell = 0;
  }
  const result = await plan(input);
  assert.equal(result.optimal, true);
  assert.equal(
    result.balancePreference,
    "Maximum balance time at optimal cost",
  );
  assert.equal(result.statuses.length, 2);
  assert.ok(result.commands.every((c) => c.mode === "balance"));
  for (const scenario of result.scenarios) {
    assert.equal(scenario.cost, 0);
    assert.equal(scenario.finalSoc, input.model.soc);
  }
});

test("balance preference cannot sacrifice profitable direct charging", async () => {
  const input = fixture();
  input.slots = [input.slots[0]];
  input.slots[0].loadW = 0;
  input.model.soc = 0;
  input.capabilities = {
    modes: ["balance", "hold", "charge", "discharge"],
    gridCharging: true,
    batteryExport: true,
    setpointStepW: 500,
  };
  const result = await plan(input);
  assert.equal(result.optimal, true);
  assert.equal(
    result.balancePreference,
    "Maximum balance time at optimal cost",
  );
  assert.equal(result.commands[0].mode, "charge");
  assert.equal(result.commands[0].setpointW, 2000);
  assert.ok(Math.abs(result.scenarios[0].cost - (-0.4 + 0.02)) < 1e-8);
});
