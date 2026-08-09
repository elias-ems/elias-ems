/**
 * The only tests here that a browser is genuinely needed for: whether the page
 * *hydrates* behind the ingress prefix. When the asset URLs are wrong the HTML
 * still server-renders perfectly — the page looks completely normal and is
 * simply inert. No amount of fetching and parsing HTML can tell those apart;
 * clicking something that only React can answer, can.
 *
 * The whole stack (mock Home Assistant, built server, ingress proxy) is started
 * by test/stack.js via `webServer` in playwright.config.ts.
 */
import { expect, test as base } from "@playwright/test";

/**
 * A 404 on a script is the signature of the asset-prefix bug. Without this it
 * would surface only indirectly, as a click that mysteriously does nothing, so
 * every test watches for it whether it asks to or not.
 */
const test = base.extend<{ noFailedRequests: void }>({
  noFailedRequests: [
    async ({ page }, use) => {
      const missing: string[] = [];
      page.on("response", (response) => {
        if (response.status() === 404) missing.push(response.url());
      });

      await use();

      expect(missing, "nothing the page requests should 404").toEqual([]);
    },
    { auto: true },
  ],
});

test("the page hydrates behind the ingress prefix", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("./settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Toggling the form is React state and nothing else — it cannot work unless
  // the client bundle loaded and took over.
  await expect(page.getByLabel("Current power (W)")).toBeHidden();
  await page.getByRole("button", { name: "Add PV entity" }).click();
  await expect(page.getByLabel("Current power (W)")).toBeVisible();

  expect(errors, "hydration must not throw").toEqual([]);
});

test("links keep working across a client navigation and a reload", async ({
  page,
}) => {
  await page.goto("./");

  // Scoped to the nav: the dashboard's empty state links to Settings too.
  const nav = page.getByRole("navigation");

  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await nav.getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { name: "Solar" })).toBeVisible();

  // The reload is the point: a Home link without the trailing slash renders and
  // navigates fine, then 404s at Home Assistant the moment someone refreshes.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Solar" })).toBeVisible();
});

test("a PV entity can be added, appears on the dashboard, and removed", async ({
  page,
}) => {
  await page.goto("./settings");

  await page.getByRole("button", { name: "Add PV entity" }).click();

  // The autocomplete is a fetcher.load() against /api/entities — it exercises
  // the resource route through the prefix, and the Supervisor token behind it.
  await page.getByLabel("Title").fill("Roof array");

  // Each suggestion carries role="option", as a listbox's children must. Its
  // accessible name is the friendly name plus "<id> · <unit>", so match on the
  // id rather than on exact text.
  const suggestion = (id: string) =>
    page.getByRole("option", { name: new RegExp(id) });

  await page.getByLabel("Current power (W)").fill("inverter_power");
  await suggestion("sensor\\.inverter_power\\b").click();

  await page.getByLabel("Total energy generated (kWh)").fill("inverter_energy");
  await suggestion("sensor\\.inverter_energy_total\\b").click();

  await page.getByRole("button", { name: "Add", exact: true }).click();

  const entry = page.locator("li", { hasText: "sensor.inverter_power" });
  await expect(entry).toBeVisible();

  const nav = page.getByRole("navigation");

  await nav.getByRole("link", { name: "Home" }).click();
  await expect(page.getByText("Roof array")).toBeVisible();
  // 1234.5 W from the fixture, with whatever separators the server's locale uses.
  await expect(page.getByText(/1\D?234\D5 W/)).toBeVisible();

  await nav.getByRole("link", { name: "Settings" }).click();
  await page
    .locator("li", { hasText: "sensor.inverter_power" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByText("No PV entities yet.")).toBeVisible();
});
