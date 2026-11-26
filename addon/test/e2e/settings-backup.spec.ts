import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("downloads, previews and restores a settings backup through ingress", async ({
  page,
}) => {
  const readBackup = async () => {
    const response = await page.request.get("./api/settings-backup.json");
    expect(response.ok()).toBe(true);
    return response.json();
  };

  await page.goto("./settings");
  await page.getByRole("link", { name: "Back up or restore settings" }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download settings backup" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^elias-ems-settings-.*\.json$/);
  const originalText = await readFile(await download.path(), "utf8");
  const original = JSON.parse(originalText);
  expect(Object.keys(original.settings).sort()).toEqual([
    "batteries",
    "control",
    "curtailment",
    "grid",
    "prices",
    "pvEntities",
  ]);

  const preview = async (json: string) => {
    await page.getByLabel("Settings backup file").setInputFiles({
      name: "settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });
    await page.getByRole("button", { name: "Preview backup" }).click();
  };

  const experiment = structuredClone(original);
  experiment.settings.grid.powerEntityId = "sensor.backup_test_grid";
  await preview(JSON.stringify(experiment));
  await expect(
    page.getByRole("heading", { name: "Restore preview" }),
  ).toBeVisible();
  expect(await readBackup()).toEqual(original);
  await page.getByRole("button", { name: "Apply backup" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings restored.");
  expect(await readBackup()).toEqual(experiment);

  const invalid = structuredClone(original);
  invalid.settings.curtailment.deadbandW = -1;
  await preview(JSON.stringify(invalid));
  await expect(page.getByRole("alert")).toContainText("Deadband");
  await expect(page.getByRole("button", { name: "Apply backup" })).toHaveCount(
    0,
  );
  expect(await readBackup()).toEqual(experiment);

  await preview(originalText);
  await expect(
    page.getByRole("heading", { name: "Restore preview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply backup" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings restored.");
  expect(await readBackup()).toEqual(original);

  await preview(originalText);
  await expect(
    page.getByText("This backup matches your current settings."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply backup" })).toHaveCount(
    0,
  );
});
