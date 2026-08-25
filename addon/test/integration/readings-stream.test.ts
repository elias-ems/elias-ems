/**
 * The readings stream, end to end through the ingress proxy: the built server,
 * a real WebSocket subscription to the mock Home Assistant, and an SSE
 * connection opened the way a browser opens one.
 *
 * The proxy is the point. Server-sent events die quietly when something in the
 * middle decides to buffer the response until it is complete — the connection
 * looks healthy and simply never delivers — and that middle is exactly what
 * Home Assistant puts in front of an add-on. This is the closest that failure
 * can be reproduced without a Home Assistant to install into.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack } from "../stack.js";

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "elias-ems-stream-"));
  // Configured up front: the stream only pushes for entities that are on the
  // page, so a blank installation would correctly send nothing.
  await writeFile(
    path.join(dataDir, "grid.json"),
    JSON.stringify({ powerEntityId: "sensor.grid_power" }),
  );

  stack = await startStack({ dataDir });
}, 60_000);

afterAll(async () => {
  if (!stack) return;
  await stack.close();
  await rm(stack.dataDir, { recursive: true, force: true });
});

/**
 * Reads SSE `data:` payloads off a live response, one at a time.
 *
 * Deliberately not "read the whole body and split it": the body never ends, so
 * anything that waits for completion waits forever. Reading chunk by chunk is
 * also what makes a buffering proxy fail this test rather than pass it slowly.
 */
async function* messages(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("the stream has no body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (data) yield JSON.parse(data);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
}

describe("GET /api/readings behind ingress", () => {
  it("streams the readings, and pushes again when Home Assistant says one moved", async () => {
    const response = await fetch(`${stack.baseUrl}api/readings`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const stream = messages(response);

    // The first message arrives without anything having changed, which is what
    // lets the page stand its polling down.
    const first = await stream.next();
    expect(first.value.grid.power.display).toBe("842 W");

    // Straight at Home Assistant, the way anything else in the house would.
    // Nothing asks the add-on to look.
    stack.ha.setState("sensor.grid_power", "-1500", {
      unit_of_measurement: "W",
    });

    const second = await stream.next();
    expect(second.value.grid.power.display).toMatch(/^-1\D?500 W$/);

    await stream.return(undefined);
  });

  /**
   * The page's fallback when the stream isn't delivering. It is a plain
   * request rather than a revalidation on purpose — see `lib/json-fetch.ts` —
   * so it has to answer a plain `fetch`, JSON, no event stream in sight.
   */
  it("answers ?snapshot with the same readings as JSON, once", async () => {
    const response = await fetch(`${stack.baseUrl}api/readings?snapshot=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    // The body ends, which is the entire difference: awaiting .json() on the
    // stream would never return.
    const readings = await response.json();
    expect(readings.grid).toMatchObject({ configured: true });
    expect(readings.grid.power.ok).toBe(true);
    expect(readings.health).toMatchObject({ connected: true });
  });

  it("holds one subscription to Home Assistant however many browsers are watching", async () => {
    const streams = await Promise.all(
      [1, 2].map(async () =>
        messages(await fetch(`${stack.baseUrl}api/readings`)),
      ),
    );

    // Both delivering before the count is checked — the socket to Home
    // Assistant is opened on first use, not at boot.
    for (const stream of streams)
      expect((await stream.next()).value).toBeTruthy();

    expect(stack.ha.subscriberCount()).toBe(1);

    for (const stream of streams) await stream.return(undefined);
  });

  /**
   * Last, because it takes the subscription down: anything after it would be
   * racing the reconnect.
   */
  it("carries the health of the connection the readings arrived through", async () => {
    const response = await fetch(`${stack.baseUrl}api/readings`);
    const stream = messages(response);

    const first = await stream.next();
    expect(first.value.health).toMatchObject({
      connected: true,
      source: "live",
    });

    // Home Assistant restarts. The readings keep coming — over REST now — and
    // the page has to be able to say which, or a degraded connection is
    // indistinguishable from a healthy one.
    stack.ha.dropSockets();

    const degraded = await stream.next();
    expect(degraded.value.health).toMatchObject({
      connected: false,
      source: "rest",
    });
    expect(degraded.value.grid.power.ok).toBe(true);

    await stream.return(undefined);
  });
});
