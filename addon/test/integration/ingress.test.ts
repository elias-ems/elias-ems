/**
 * Runs the built server behind a proxy that behaves like Home Assistant's
 * ingress, and pins down the three things CLAUDE.md records as separately
 * observed production failures. Each of them looked fine on a direct
 * `localhost:3000` — that is the whole reason this suite exists.
 *
 * These are HTTP-level assertions. Whether the page then hydrates is checked in
 * test/e2e, which needs a real browser to tell "inert" from "working".
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack } from "../stack.js";

let stack: Awaited<ReturnType<typeof startStack>>;
let html: string;

/** Every URL the browser would go on to request from the served HTML. */
function assetUrls(document: string): string[] {
  return [
    ...document.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g),
  ].map((match) => match[1]);
}

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-ingress-"));
  stack = await startStack({ dataDir });

  const response = await fetch(stack.baseUrl);
  expect(response.status).toBe(200);
  html = await response.text();
}, 60_000);

afterAll(async () => {
  if (!stack) return;
  await stack.close();
  await rm(stack.dataDir, { recursive: true, force: true });
});

describe("the ingress prefix", () => {
  it("serves the app under the prefix", () => {
    expect(html).toContain("<h1>Home</h1>");
  });

  it("serves nothing outside the prefix", async () => {
    const response = await fetch(`${stack.origin}/`);
    expect(response.status).toBe(404);
  });

  it("refuses the prefix without its trailing slash, exactly as HA does", async () => {
    // Not our behaviour to fix — it is the constraint the trailing slash on
    // `basename` exists to satisfy, so the test below has something to prove.
    const response = await fetch(stack.origin + stack.prefix, {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });
});

describe("client assets", () => {
  it("references them under the prefix, not at the Home Assistant root", () => {
    const urls = assetUrls(html);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      if (!url.startsWith("/")) continue;
      expect(
        url.startsWith(`${stack.prefix}/`),
        `${url} would be requested from the Home Assistant origin, where nothing serves it`,
      ).toBe(true);
    }
  });

  it("actually serves every one of them", async () => {
    // The failure this catches is silent: the page server-renders correctly and
    // looks right, but every script 404s and nothing is ever interactive.
    const urls = assetUrls(html).filter((url) => url.startsWith("/"));

    const results = await Promise.all(
      urls.map(async (url) => ({
        url,
        status: (await fetch(stack.origin + url)).status,
      })),
    );

    expect(results.filter((result) => result.status !== 200)).toEqual([]);
  });

  it("embeds a basename the browser can hydrate against", () => {
    // A mismatch between this and the browser's real URL is what makes React
    // Router throw during hydration.
    expect(html).toContain(`${stack.prefix}/`);
  });
});

describe("navigation links", () => {
  it("points Home at the prefix with its trailing slash, so a reload survives", async () => {
    const homeHref = html.match(/<a[^>]+href="([^"]*)"[^>]*>Home<\/a>/)?.[1];

    expect(homeHref).toBe(`${stack.prefix}/`);

    const reloaded = await fetch(stack.origin + homeHref);
    expect(reloaded.status).toBe(200);
  });

  it("points Settings under the prefix too", async () => {
    const settingsHref = html.match(
      /<a[^>]+href="([^"]*)"[^>]*>Settings<\/a>/,
    )?.[1];

    expect(settingsHref).toBe(`${stack.prefix}/settings`);
    expect((await fetch(stack.origin + settingsHref)).status).toBe(200);
  });
});

describe("Home Assistant data", () => {
  it("reaches the Core API through the Supervisor token", async () => {
    const response = await fetch(`${stack.baseUrl}api/entities?q=inverter`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entities: Array<{ entityId: string }>;
      error: string | null;
    };

    expect(body.error).toBeNull();
    expect(body.entities.map((entity) => entity.entityId)).toContain(
      "sensor.inverter_power",
    );
  });
});

describe("battery control", () => {
  /** Posts one of the settings forms the way the browser would. */
  async function post(fields: Record<string, string>) {
    const response = await fetch(`${stack.baseUrl}settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: stack.origin,
      },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    expect(response.status).toBeLessThan(400);
  }

  async function controlLog(): Promise<{
    status: { running: boolean };
    entries: Array<{ message: string }>;
  }> {
    const response = await fetch(`${stack.baseUrl}api/control-log`);
    expect(response.status).toBe(200);
    return response.json();
  }

  it("runs in the real server process once it is switched on", async () => {
    // The loop lives in module state inside server.js, which the unit tests
    // reach by importing it directly. This is the one place it is exercised
    // where "the add-on" and "the process holding the interval" are the same
    // thing, reached over HTTP through the ingress proxy.
    await post({
      intent: "grid-save",
      powerEntityId: "sensor.grid_power",
    });
    await post({
      intent: "battery-add",
      title: "Home battery",
      capacityKwh: "10",
      minChargePercent: "10",
      maxChargePercent: "90",
      energyEntityId: "sensor.battery_energy_total",
      powerEntityId: "sensor.battery_power",
      socEntityId: "sensor.battery_state_of_charge",
    });

    expect((await controlLog()).status.running).toBe(false);

    await post({
      intent: "control-save",
      enabled: "on",
      strategy: "net-zero-energy",
      intervalSeconds: "1",
    });

    // Enabling ticks once straight away, but that tick is fire-and-forget and
    // has its own round trip to Home Assistant to make first.
    await expect
      .poll(async () => (await controlLog()).entries.map((e) => e.message), {
        timeout: 5_000,
      })
      .toContainEqual(expect.stringContaining("Home battery: discharge at"));

    expect((await controlLog()).status.running).toBe(true);
  });
});

describe("action origin checking", () => {
  /** Posts a complete, valid form, so the origin is the only thing under test. */
  async function submit(origin: string, title: string) {
    const body = new URLSearchParams({
      intent: "pv-add",
      title,
      powerEntityId: "sensor.inverter_power",
      energyEntityId: "sensor.inverter_energy_total",
    });

    return fetch(`${stack.baseUrl}settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
      },
      body,
      redirect: "manual",
    });
  }

  async function storedTitles(): Promise<string[]> {
    const contents = await readFile(
      path.join(stack.dataDir, "pv-entities.json"),
      "utf-8",
    ).catch(() => "[]");
    return (JSON.parse(contents) as Array<{ title?: string }>).map(
      (entity) => entity.title ?? "",
    );
  }

  it("accepts a form posted from the page's own origin", async () => {
    // HA forwards the browser's Host untouched and sets no X-Forwarded-*, which
    // is why `trust proxy` must stay off in server.js: this check compares
    // Origin against Host, and a spoofable Host would make it meaningless.
    const response = await submit(stack.origin, "Posted from the page");

    expect(response.status).toBeLessThan(400);
    expect(await storedTitles()).toContain("Posted from the page");
  });

  it("rejects a form posted from somewhere else", async () => {
    // React Router answers a failed origin check with 400, which is also what a
    // validation failure looks like — so the status alone proves nothing. What
    // makes this a rejection is that the action never ran.
    const response = await submit(
      "http://evil.example",
      "Posted from elsewhere",
    );

    expect(response.status).toBe(400);
    expect(await storedTitles()).not.toContain("Posted from elsewhere");
  });
});
