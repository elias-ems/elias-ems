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
import { test as base, expect } from "@playwright/test";
import { HA_MOCK_PORT } from "../../playwright.config";
import { DEFAULT_SUPERVISOR_TOKEN } from "../ha-mock.js";

/**
 * A 404 on a script is the signature of the asset-prefix bug. Without this it
 * would surface only indirectly, as a click that mysteriously does nothing, so
 * every test watches for it whether it asks to or not.
 */
// Playwright types a fixture that exposes no value as `void`; this is the
// documented signature, not a mistaken use of void as a value type.
// biome-ignore lint/suspicious/noConfusingVoidType: see above
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

/**
 * The whole feature end to end: configure it the way a user would, switch it on,
 * and check that the loop running inside server.js actually says something. Put
 * last, because it leaves a control loop running for the rest of the run.
 */
test("battery control can be configured, enabled, and watched deciding", async ({
  page,
}) => {
  await page.goto("./settings");

  const suggestion = (id: string) =>
    page.getByRole("option", { name: new RegExp(id) });

  // Grid: one signed sensor, which is the net exchange as it stands.
  await page.getByLabel(/^Power/).fill("grid_power");
  await suggestion("sensor\\.grid_power\\b").click();
  await page.getByRole("button", { name: "Save grid" }).click();

  await page.getByRole("button", { name: "Add battery" }).click();
  await page.getByLabel("Title").fill("Home battery");
  await page.getByLabel("Capacity (kWh)").fill("10");
  // Set explicitly rather than leaning on the prefilled defaults, so the card
  // asserted on the dashboard below is showing what this test chose.
  await page.getByLabel("Minimum charge (%)").fill("10");
  await page.getByLabel("Maximum charge (%)").fill("90");
  await page.getByLabel(/^Energy \(kWh\)/).fill("battery_energy");
  await suggestion("sensor\\.battery_energy_total\\b").click();
  await page.getByLabel(/^Power \(W\)/).fill("battery_power");
  await suggestion("sensor\\.battery_power\\b").click();
  await page.getByLabel(/^Charge/).fill("state_of_charge");
  await suggestion("sensor\\.battery_state_of_charge\\b").click();
  // Control cannot be switched on without one: it is the name this battery's
  // setpoints go out under, and an automation listening for that name is what
  // turns them into something the hardware hears.
  await page.getByLabel(/^Control key/).fill("home_battery");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(
    page.locator("li", { hasText: "sensor.battery_state_of_charge" }),
  ).toBeVisible();

  // A one-second interval so the log fills while the test is watching.
  await page.getByLabel("Enable battery control").check();
  await page.getByLabel("Loop interval (seconds)").fill("1");
  await page.getByRole("button", { name: "Save battery control" }).click();

  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Home" })
    .click();

  // The battery's readings reached the dashboard.
  await expect(page.getByText("10–90% of 10 kWh")).toBeVisible();
  await expect(page.getByText("76 %")).toBeVisible();

  // A diagnostics box only polls while it is open, so this both expands it and
  // is the thing that makes the log appear at all.
  await page.getByText("Diagnostics").click();

  // The fixture imports 842 W with the battery idle, so net zero means
  // discharging exactly that much.
  await expect(page.getByText(/Home battery: discharge at 842 W/)).toBeVisible({
    timeout: 15_000,
  });
});

/**
 * Runs after the test above, which is what puts anything in the log to show and
 * to download.
 */
test("the Tools page shows the log and downloads it", async ({ page }) => {
  await page.goto("./");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Tools" })
    .click();

  // Open by default here — this page is the log, not a detail tucked under a
  // feature — and every entry says which feature it came from.
  await expect(
    page.getByText(/\[Battery control\] Grid net \+842 W/).first(),
  ).toBeVisible({ timeout: 15_000 });

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download" }).click(),
  ]).then(([event]) => event);

  expect(download.suggestedFilename()).toMatch(
    /^elias-ems-diagnostics-.+\.txt$/,
  );

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString("utf-8")).toContain(
    "Home battery: discharge at 842 W",
  );
});

/**
 * The dashboard's whole point is that its numbers are current. Nothing else in
 * the suite would notice if the updates stopped: every other assertion is happy
 * with the values the page was server-rendered with.
 *
 * Runs after the test above, which is what configures the battery this watches.
 */
test("readings keep updating without the page being reloaded", async ({
  page,
  request,
}) => {
  // Revalidations of the home loader — the polling fallback's signature. The
  // stream is supposed to make all of them unnecessary.
  const polls: string[] = [];
  page.on("request", (event) => {
    if (event.url().includes(".data")) polls.push(event.url());
  });

  await page.goto("./");
  await expect(page.getByText("76 %")).toBeVisible();

  // The health chip. With the policy this app runs under, an old reading is
  // shown rather than refused, so this line is the only thing standing between
  // a stuck sensor and a number that looks perfectly current.
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  // Survives a client-side refresh and not a page load, so the assertion at the
  // end can tell the two apart.
  await page.evaluate(() => {
    (window as unknown as { neverReloaded?: boolean }).neverReloaded = true;
  });

  // Straight at the mock, the way Home Assistant's own API sets a state — the
  // add-on has no way to move a sensor, and the point is that it notices when
  // something else does.
  const response = await request.post(
    `http://127.0.0.1:${HA_MOCK_PORT}/core/api/states/sensor.battery_state_of_charge`,
    {
      headers: { Authorization: `Bearer ${DEFAULT_SUPERVISOR_TOKEN}` },
      data: {
        state: "41",
        attributes: { unit_of_measurement: "%" },
      },
    },
  );
  expect(response.ok()).toBe(true);

  await expect(page.getByText("41 %")).toBeVisible({ timeout: 20_000 });

  // And the chip now has a change to date it by. Before this it had none —
  // which is the honest answer on a house where nothing has moved yet, not a
  // gap in the display.
  await expect(page.getByText(/last change \d+s ago/)).toBeVisible();

  expect(
    await page.evaluate(
      () => (window as unknown as { neverReloaded?: boolean }).neverReloaded,
    ),
    "the new reading must arrive without a page load",
  ).toBe(true);

  // Home Assistant pushed it. Had the page asked, this would be non-empty —
  // which is what the assertion is for: the fallback exists, and a stream that
  // silently stopped delivering would otherwise look exactly like success.
  expect(polls, "a working stream leaves nothing to poll for").toEqual([]);
});
