// Run after docs:build with docs:preview listening on port 4173 (or PLANNER_PORT).

import assert from "node:assert/strict";
import {
  chromium,
  firefox,
  webkit,
} from "../../addon/node_modules/@playwright/test/index.mjs";

const browserName = process.env.PLANNER_BROWSER ?? "chromium";
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, `Unknown PLANNER_BROWSER: ${browserName}`);
const browser = await browserType.launch({
  headless: true,
  executablePath:
    browserName === "chromium" ? process.env.CHROMIUM_PATH : undefined,
});
try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const responses = [];
  page.on("response", (r) => {
    if (r.url().includes(".wasm")) responses.push(r.status());
  });
  await page.goto(
    `http://127.0.0.1:${process.env.PLANNER_PORT ?? 4173}/elias-ems/planner`,
  );
  const start = Date.parse("2026-10-18T12:00:00Z");
  const data = {
    schemaVersion: 1,
    kind: "forecast-snapshot",
    id: "Browser test",
    currency: "EUR",
    timeZone: "Europe/Brussels",
    assumptions: [],
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
      start: start + i * 3600000,
      end: start + (i + 1) * 3600000,
      solarW: i === 1 ? 3000 : 0,
      loadW: 500,
      buy: i === 0 ? -0.2 : 0.4,
      sell: 0.1,
      estimatedPrice: false,
    })),
    settings: {
      deadline: new Date(start + 7200000).toISOString(),
      targetSoc: 100,
      solarHaircut: 0.2,
      switchCost: 0.002,
      passes: 1,
      spikeBufferKwh: 0,
    },
    terminalReserveKwh: 0,
  };
  await page.getByLabel("Import planner export").setInputFiles({
    name: "fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  assert.equal(
    await page
      .getByLabel("Comparison capabilities", { exact: true })
      .inputValue(),
    "true",
  );
  assert.equal(await page.getByLabel("Permit grid charging").count(), 0);
  assert.equal(await page.getByLabel("Permit battery export").count(), 0);
  await page
    .getByLabel("Comparison capabilities", { exact: true })
    .selectOption({ label: "Equivalent: balance + existing boundaries" });
  await page.getByRole("button", { name: "Compare planners" }).click();
  await page
    .getByText("Optimal for modeled objective", { exact: false })
    .waitFor({ timeout: 15000 })
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  await page
    .getByLabel("Comparison capabilities", { exact: true })
    .selectOption({ label: "Expanded: assume all four modes" });
  await page.getByRole("button", { name: "Compare planners" }).click();
  await page
    .getByText("Optimal for modeled objective", { exact: false })
    .waitFor({ timeout: 15000 })
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  await page
    .getByText("Side-by-side interval controls and predictions (nominal)")
    .click();
  assert.ok(
    (await page
      .getByRole("cell")
      .filter({ hasText: /^charge$/ })
      .count()) > 0,
  );
  for (const name of ["Expected load W", "Expected solar W"])
    await page.getByRole("columnheader", { name }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download inputs and calculated plan" })
      .click(),
  ]);
  const stream = await download.createReadStream();
  let content = "";
  for await (const chunk of stream) content += chunk.toString();
  const exported = JSON.parse(content);
  assert.equal(exported.dataset.schemaVersion, 1);
  assert.equal(exported.algorithm, "evening-target");
  assert.equal(exported.plan.points.length, data.slots.length);
  assert.equal(exported.comparison.input.capabilities.gridCharging, true);
  assert.equal(exported.comparison.input.capabilities.batteryExport, true);
  assert.equal(exported.comparison.engine.commands.length, data.slots.length);
  for (const field of ["deadline", "objective", "terminalReserveKwh"]) {
    assert.equal(field in exported.comparison.input, false);
  }
  assert.equal(exported.comparison.engine.statuses.length, 2);
  assert.equal(
    exported.comparison.engine.balancePreference,
    "Maximum balance time at optimal cost",
  );
  assert.equal(
    "shortfallKwh" in exported.comparison.engine.scenarios[0],
    false,
  );
  assert.equal(await page.getByLabel("Objective", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  assert.ok(responses.length >= 1);
  assert.ok(responses.every((s) => s === 200));
  // A preset loads like an import: its name replaces the filename, and the
  // equivalent comparison (the fast, provable one) completes.
  await page.getByRole("button", { name: "Marginal autumn surplus" }).click();
  await page.getByText("Marginal autumn surplus · 96 intervals").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Marginal autumn surplus" })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page
    .getByLabel("Comparison capabilities", { exact: true })
    .selectOption({ label: "Equivalent: balance + existing boundaries" });
  await page.getByRole("button", { name: "Compare planners" }).click();
  await page
    .getByText("Optimal for modeled objective", { exact: false })
    .waitFor({ timeout: 30000 })
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  console.log(
    `Production ${browserName}: both capability comparisons, preset, WASM 200, direct charge, downloads, mobile width, no page errors`,
  );
} finally {
  await browser.close();
}
