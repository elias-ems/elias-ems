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
import { test as base, expect, type Page } from "@playwright/test";
import { HA_MOCK_PORT } from "../../playwright.config";
import { DEFAULT_SUPERVISOR_TOKEN } from "../ha-mock.js";

/**
 * The dashboard renders its devices twice — a table once there is room for four
 * columns, a list of rows below that — with CSS showing one at a time. Both are
 * in the DOM, so a bare `getByText` for a reading is two matches and a strict
 * mode violation; this asks for the copy that is actually on screen at whatever
 * viewport the test is running at.
 */
const onScreen = (page: Page, text: string | RegExp) =>
  page.getByText(text).filter({ visible: true });

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
  await expect(
    page.getByRole("heading", { name: "Solar & batteries" }),
  ).toBeVisible();

  // The reload is the point: a Home link without the trailing slash renders and
  // navigates fine, then 404s at Home Assistant the moment someone refreshes.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Solar & batteries" }),
  ).toBeVisible();
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
  await expect(onScreen(page, "Roof array")).toBeVisible();
  // 1234.5 W from the fixture, with whatever separators the server's locale uses.
  await expect(onScreen(page, /1\D?234\D5 W/)).toBeVisible();

  await nav.getByRole("link", { name: "Settings" }).click();
  await page
    .locator("li", { hasText: "sensor.inverter_power" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByText("No PV entities yet.")).toBeVisible();
});

/**
 * The one field that picks a state rather than a reading, and the only place the
 * component and the route can be caught disagreeing about which domain to offer
 * — a mismatch leaves the field suggesting entities it cannot accept, which
 * looks from the browser exactly like a Home Assistant with nothing in it.
 */
test("the car sensor suggests binary sensors and the readings do not", async ({
  page,
}) => {
  await page.goto("./settings");

  const carSensor = page.getByLabel("A car wants to charge (binary sensor)");
  await carSensor.click();
  await carSensor.fill("grid");
  await expect(
    page.getByRole("option", { name: /binary_sensor\.grid_connected/ }),
  ).toBeVisible();

  // The same query in a reading field offers the sensor and not the state.
  // Clicked rather than merely filled, so the suggestions above close on the
  // mousedown — two open listboxes would leave the assertion below matching the
  // other field's options.
  const gridPower = page.getByLabel(/^Power — net grid/);
  await gridPower.click();
  await gridPower.fill("grid");
  await expect(
    page.getByRole("option", { name: /sensor\.grid_power/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /binary_sensor\.grid_connected/ }),
  ).toHaveCount(0);
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
  // Anchored on the em dash as well as the word, for the same reason the two
  // above are anchored at all: "Charger power (W)" in the curtailment card is
  // also a label beginning "Charge", and a locator that matches two fields
  // fails strictly rather than picking one.
  await page.getByLabel(/^Charge —/).fill("state_of_charge");
  await suggestion("sensor\\.battery_state_of_charge\\b").click();
  // Control cannot be switched on unless something is steered. The event this
  // battery's targets go out on is named after the title typed above, and
  // the form says so while it is being typed.
  await expect(
    page.getByText("elias_ems_home_battery_target_power"),
  ).toBeVisible();
  await page.getByLabel("Steer this battery").check();
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
  await expect(onScreen(page, "10–90% of 10 kWh")).toBeVisible();
  await expect(onScreen(page, "76 %")).toBeVisible();

  // The decision feed is open and polling on its own — there is no box to
  // expand any more — and it carries the summary line of each tick. The fixture
  // imports 842 W with the battery idle, so net zero means discharging exactly
  // that much, and the loop inside server.js is what has to say so.
  await expect(page.getByText(/Grid net \+842 W/).first()).toBeVisible({
    timeout: 15_000,
  });

  // The per-battery detail is the tick's second line, which the feed trims and
  // the Tools page keeps — the next test is where that is checked.
  await expect(
    page.getByRole("link", { name: "Full diagnostics" }),
  ).toBeVisible();
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
  // `?snapshot` is the polling fallback and nothing else asks for it, so one
  // of these requests means the stream stopped delivering. The decision feed's
  // own two-second poll is a different route and is supposed to be there.
  const polls: string[] = [];
  page.on("request", (event) => {
    if (event.url().includes("snapshot")) polls.push(event.url());
  });

  await page.goto("./");
  await expect(onScreen(page, "76 %")).toBeVisible();

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

  await expect(onScreen(page, "41 %")).toBeVisible({ timeout: 20_000 });

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

/**
 * The failure that put an "Application Error" page in front of anyone whose
 * connection blinked: every background request on this page used to go through
 * React Router's data layer, where a `fetch` that never comes back is a route
 * error, and a route error replaces the page with the nearest error boundary.
 * A dashboard left open in a tab died on the first dropped request and stayed
 * dead until somebody reloaded it.
 *
 * Aborted requests, not error responses: a 500 is an answer, and the loops
 * already survive those. This is the connection itself going away.
 */
test("a dropped background request doesn't take the dashboard down", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Solar & batteries" }),
  ).toBeVisible();

  await page.route("**/api/diagnostics*", (route) => route.abort());
  await page.route("**/api/readings*", (route) => route.abort());

  // Both captions are the page still rendering, from state that changed after
  // the requests started failing — so they prove it is alive, not just that it
  // hasn't been replaced yet.
  await expect(page.getByText("not updating").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Offline", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await expect(page.getByText("Application Error")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Solar & batteries" }),
  ).toBeVisible();
});

/**
 * The other half of the same fix: when something *does* reach the error
 * boundary, what renders is the app's own page inside the app's own document —
 * top bar, stylesheet, scripts — rather than the framework's bare fallback
 * with a minified stack trace on it.
 *
 * Deliberately the un-extended `test`: the response here really is a 404,
 * which is the one thing the fixture at the top of this file exists to fail on.
 */
base(
  "an unknown page gets the app's own error page, with a way out",
  async ({ page }) => {
    const response = await page.goto("./nope");
    expect(response?.status()).toBe(404);

    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    // The bar is only there if the boundary rendered inside the root Layout, and
    // the link only works if the page hydrated — the two things the framework's
    // fallback would not have.
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Home" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Solar & batteries" }),
    ).toBeVisible();
  },
);

/**
 * The playground is the one page whose whole content is client-rendered
 * components fed made-up data, and the one page nothing else in this suite
 * visits. Two things can only fail there: a fixture that drives a component
 * into a state the real pages never reach and crashes it, and a settings form
 * posting to a route with no action.
 */
test("the playground renders every specimen and swallows what its forms post", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("./tools");
  await page.getByRole("link", { name: "Component playground" }).click();

  await expect(
    page.getByRole("heading", { name: "Component playground" }),
  ).toBeVisible();

  // One specimen from each end of the catalogue, so a component that throws
  // half way down cannot pass by rendering everything above it.
  await expect(
    page.getByRole("heading", { name: "Field", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "CurtailmentSection" }),
  ).toBeVisible();

  // A rejected form — a state the real Settings page cannot be put into
  // without breaking the installation, which is the reason this page exists.
  await expect(
    onScreen(page, "Capacity has to be more than zero.").first(),
  ).toBeVisible();

  // The index is anchors into this same page, so following one must not
  // navigate away from it.
  await page.getByRole("link", { name: "GridCard" }).click();
  await expect(page.getByRole("heading", { name: "GridCard" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Component playground" }),
  ).toBeVisible();

  // Saving has to reach this route's own action rather than 405ing, and has to
  // report the post rather than storing it.
  await page.getByRole("button", { name: "Save grid" }).first().click();
  await expect(onScreen(page, "intent=grid-save")).toBeVisible();

  expect(errors, "no specimen may throw").toEqual([]);
});

/**
 * A developer's page, so it is reachable from the Debug section of Tools and
 * from nothing else. If it ever appears in the top bar, every user of the
 * add-on has a fourth tab full of fixtures.
 */
test("the playground is not in the top bar", async ({ page }) => {
  await page.goto("./playground");

  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Playground" }),
  ).toHaveCount(0);
});

/**
 * How wide the document actually wants to be, against how much room it has.
 * Anything wider is a page that scrolls sideways on a phone.
 */
const documentWidth = (page: Page) =>
  page.evaluate(() => ({
    wants: document.documentElement.scrollWidth,
    has: document.documentElement.clientWidth,
  }));

/**
 * The bar's spacing lives in app.css because it changes at 480px, and every one
 * of those declarations is one an inline style in AppHeader.tsx would silently
 * beat. Four of the five did exactly that — three overridden inline, one naming
 * a class no element carried — so this asserts the *computed* values rather
 * than that the rules exist.
 */
test("the top bar tightens on a phone and not before", async ({ page }) => {
  const bar = page.locator(".app-header");
  const title = page.locator(".app-header-title");
  const tab = page.getByRole("navigation").getByRole("link", { name: "Home" });

  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto("./");

  await expect(bar).toHaveCSS("padding-left", "16px");
  await expect(title).toHaveCSS("font-size", "20px");
  await expect(tab).toHaveCSS("padding-left", "16px");
  await expect(tab).toHaveCSS("font-size", "16px");

  await page.setViewportSize({ width: 400, height: 800 });

  await expect(bar).toHaveCSS("padding-left", "8px");
  await expect(title).toHaveCSS("font-size", "17px");
  await expect(tab).toHaveCSS("padding-left", "8px");
  await expect(tab).toHaveCSS("font-size", "14px");

  // 320px is the width the tightening exists for: the name and three tabs need
  // more than that at full size, and fit with room to spare once tightened.
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await documentWidth(page)).toEqual({ wants: 320, has: 320 });
});

/**
 * Runs after the battery is configured, which is what puts a row on the page to
 * measure. A saved row is mostly entity ids, and an id is one long token a
 * browser will not break on its own — so the row used to be wider than a phone
 * and took the whole document's horizontal scroll with it.
 */
test("a saved settings row fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("./settings");

  await expect(
    page.locator("li", { hasText: "sensor.battery_state_of_charge" }),
  ).toBeVisible();

  expect(
    await documentWidth(page),
    "the settings page must not scroll sideways",
  ).toEqual({ wants: 375, has: 375 });
});
