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

test("charge plan hydrates, fits mobile and offers the charge-limit entity", async ({
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
      JSON.stringify({ enabled: true, strategy: "soft-ceiling" }),
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
      page.getByRole("img", {
        name: "Charge ceiling and Expected charging over time, W",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Preview only — the battery's settings are unchanged."),
    ).toBeVisible();
    await expect(
      page
        .getByRole("paragraph")
        .filter({ hasText: /Hypothetical preview: assumes uncurtailed solar/ }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("img", {
        name: "Charge ceiling and Expected charging over time, W",
      }),
    ).toHaveAttribute("viewBox", "0 0 320 155");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.goto(`${stack.baseUrl}settings`);
    await expect(page.locator('select[name="chargeLimitMode"]')).toHaveCount(0);
    await expect(
      page.getByRole("option", { name: "Optimize charge limit", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByLabel("Physical grid import counters", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Edit/ }).first().click();
    const entity = page.getByLabel("Maximum charge limit (W)", { exact: true });
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
