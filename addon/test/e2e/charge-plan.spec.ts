import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  chargeBatteryFixture,
  chargeEntityFixture,
  chargeForecastFixture,
} from "../charge-forecast-fixture.js";
import { defaultStates } from "../ha-mock.js";
import { startStack } from "../stack.js";

for (const modeled of [false, true]) {
  test(`charge plan hydrates and fits mobile with curtailment modeled=${modeled}`, async ({
    page,
  }) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "elias-charge-browser-"),
    );
    let stack: Awaited<ReturnType<typeof startStack>> | undefined;
    try {
      await writeFile(
        path.join(directory, "batteries.json"),
        JSON.stringify([{ ...chargeBatteryFixture, chargeLimitMode: "off" }]),
      );
      await writeFile(
        path.join(directory, "curtailment.json"),
        JSON.stringify({
          enabled: true,
          strategy: "soft-ceiling",
          priceThresholdPerKwh: -1,
          bands: [{ abovePerKwh: 10, ceilingPercent: 20, exportPercent: 0 }],
        }),
      );
      if (modeled)
        await writeFile(
          path.join(directory, "pv-entities.json"),
          JSON.stringify([
            {
              id: "pv-test",
              title: "Roof",
              energyEntityId: "pv",
              powerEntityId: "sensor.pv_power",
              curtailable: true,
              ratedPowerW: 4000,
              controlMode: "modulating",
              stepLimitPercent: null,
            },
          ]),
        );
      await writeFile(
        path.join(directory, "prices.json"),
        JSON.stringify({
          source: "home-assistant",
          forecastEntityId: "sensor.energi_epex_spot",
          consumptionFormula: "price + 0.15",
          productionFormula: "price",
        }),
      );
      stack = await startStack({
        dataDir: directory,
        haStates: [...(await defaultStates()), chargeEntityFixture],
        haCommandResults: chargeForecastFixture(),
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const baseUrl = stack.baseUrl;
      await expect
        .poll(
          async () => {
            const response = await page.request.get(
              `${baseUrl}api/charge-limits`,
            );
            const status = await response.json();
            return status.batteries[0].state;
          },
          { timeout: 15_000 },
        )
        .toBe("preview");
      await page.goto(stack.baseUrl);
      await expect(
        page.getByRole("link", { name: "View full plan" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "View full plan" }).click();
      await expect(
        page.getByRole("heading", { name: "Energy plans" }),
      ).toBeVisible();
      await expect(
        page.getByRole("img", {
          name: "Charge ceiling and Expected charging over time, W",
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Preview only — the battery's settings are unchanged."),
      ).toBeVisible();
      if (!modeled)
        await expect(
          page.getByRole("paragraph").filter({
            hasText: /Hypothetical preview: assumes uncurtailed solar/,
          }),
        ).toBeVisible();
      if (modeled) {
        await expect(page.getByText(/Hypothetical preview/)).toHaveCount(0);
        await expect(page.getByText(/Expected PV generation:/)).toBeVisible();
        await page.getByText(/Forecast and schedule details/).click();
        await expect(
          page.getByRole("columnheader", {
            name: "Generated solar W",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("columnheader", { name: "Curtailed W", exact: true }),
        ).toBeVisible();
        const response = await page.request.get(`${baseUrl}api/charge-limits`);
        const status = await response.json();
        expect(
          status.batteries[0].plan.points.some(
            (p: { curtailedW: number }) => p.curtailedW > 0,
          ),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("img", {
          name: "Charge ceiling and Expected charging over time, W",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("img", {
          name: "Forecast solar and Generated solar over time, W",
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.goto(`${stack.baseUrl}settings`);
      await expect(page.locator('select[name="chargeLimitMode"]')).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("option", {
          name: "Optimize charge limit",
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(
        page.getByLabel("Physical grid import counters", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByLabel("Physical grid export counters", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("listitem")
        .filter({ hasText: "Home battery" })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      const entity = page.getByLabel("Maximum charge limit (W)", {
        exact: true,
      });
      await entity.fill("Battery maximum charge");
      await expect(
        page.getByRole("option", { name: /Battery maximum charge limit/ }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await stack?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
