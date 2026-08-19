/**
 * A stand-in for the Home Assistant Core API that the Supervisor proxies at
 * `http://supervisor/core/api` — a hostname that only resolves inside a real
 * add-on container, which is why the app renders nothing useful outside Home
 * Assistant. Point `SUPERVISOR_API` at this server's `/core/api` instead.
 *
 * It serves the same path shape as the real thing rather than a bare `/states`
 * so that a URL built for one works against the other unchanged, and it checks
 * the bearer token because sending the wrong one (or none) is exactly the
 * failure this is meant to catch before it reaches Home Assistant.
 *
 * Both halves of that proxy are here: the REST API under `/core/api`, and the
 * WebSocket at `/core/websocket` that the add-on subscribes to for live
 * readings. They share one state list, and one way to change it — a `POST` to
 * `/core/api/states/<id>`, which is also how the real API does it. A test moves
 * a sensor once and both transports see it.
 *
 * The third thing the REST half serves is `POST /core/api/events/<type>`, the
 * one endpoint the add-on uses to ask for something rather than to read it.
 *
 * `ws` is a devDependency because node ships a WebSocket *client* and no
 * server; the add-on itself needs no such thing, since the client is the half
 * it uses.
 *
 * Plain JavaScript for the same reason as server.js: it is spawned directly by
 * node, with no build step in front of it.
 */

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { listen } from "./listen.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SUPERVISOR_TOKEN = "test-supervisor-token";

/** Reported in the handshake, as the real server does. Nothing reads it yet. */
const HA_VERSION = "2026.8.0";

/**
 * A day-ahead price sensor in the shape Energi Data Service publishes, covering
 * today and tomorrow in quarter hours from local midnight.
 *
 * Generated rather than written into the fixture, and that is the whole reason
 * it lives here: a price series is only meaningful relative to now, so a
 * captured one would be permanently in the past and the development stack would
 * show "these prices don't cover right now" forever — the one state you least
 * want to be stuck in while building the thing.
 *
 * The prices are a smooth double hump, cheap overnight and around midday, dear
 * at the two peaks, dipping below zero in the middle of the day. That last part
 * is deliberate: a negative price is the case the two formulas exist to tell
 * apart, and it is the one nobody can reproduce on demand from a real feed.
 */
function priceStates() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const entry = (index) => {
    const at = new Date(midnight.getTime() + index * 15 * 60_000);
    const hour = (index % 96) / 4;
    const price =
      0.09 +
      0.075 * Math.sin(((hour - 9) * Math.PI) / 12) +
      0.06 * Math.sin(((hour - 3) * Math.PI) / 6);
    return { hour: at.toISOString(), price: Number(price.toFixed(4)) };
  };

  const today = Array.from({ length: 96 }, (_, index) => entry(index));
  const tomorrow = Array.from({ length: 96 }, (_, index) => entry(index + 96));
  const nowIndex = Math.floor(
    (Date.now() - midnight.getTime()) / (15 * 60_000),
  );

  return {
    entity_id: "sensor.energi_epex_spot",
    state: String(today[Math.min(nowIndex, 95)].price),
    attributes: {
      friendly_name: "Energi Epex Spot",
      unit_of_measurement: "EUR/kWh",
      device_class: "monetary",
      currency: "EUR",
      region: "Belgium",
      region_code: "BE",
      use_cent: false,
      tomorrow_valid: true,
      attribution: "Data sourced from Nord Pool",
      raw_today: today,
      raw_tomorrow: tomorrow,
    },
  };
}

/** The fixture the mock serves when a caller doesn't supply its own states. */
export async function defaultStates() {
  const contents = await readFile(
    path.join(here, "fixtures", "ha-states.json"),
    "utf-8",
  );
  return [...JSON.parse(contents), priceStates()];
}

/** @returns {Promise<object|null>} the parsed body, or null when there isn't one. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 (the default) picks a free port.
 * @param {string} [options.token] Bearer token the mock will accept.
 * @param {Array<object>} [options.states] Overrides the fixture.
 */
export async function startHaMock({
  port = 0,
  token = DEFAULT_SUPERVISOR_TOKEN,
  states,
} = {}) {
  /**
   * Home Assistant stamps every state; the fixtures and hand-written states in
   * tests don't. Filling them in at startup rather than writing them into the
   * fixture keeps the ages realistic — a checked-in timestamp is permanently
   * hours old — while leaving an explicit one alone, which is how a test asks
   * for a deliberately stale reading.
   */
  const stamped = (state, when = new Date().toISOString()) => ({
    last_changed: when,
    last_updated: when,
    ...state,
  });

  let current = (states ?? (await defaultStates())).map((state) =>
    stamped(state),
  );

  /** Set by `goSilent()`: the socket stays open and stops saying anything. */
  let silent = false;

  /**
   * Every request seen, so tests can assert the app actually called out.
   * @type {Array<{ method: string, path: string }>}
   */
  const requests = [];

  /**
   * Every event fired on the bus, in order, so a test can assert what the
   * add-on asked for rather than only what the house ended up doing. The
   * difference matters, and an event is the only trace there is: unlike a
   * service call it changes no entity, so a loop that publishes the same
   * target forty times a minute and one that publishes it once are
   * indistinguishable from the states alone.
   * @type {Array<{ eventType: string, data: object }>}
   */
  const events = [];

  /**
   * Sockets that have authenticated, against the id of their `state_changed`
   * subscription — null until they ask for one. A connection that never
   * subscribes is still a connection, and must not be sent events.
   * @type {Map<import("ws").WebSocket, number|null>}
   */
  const sockets = new Map();

  /**
   * Applies a state and tells every subscriber, the way Home Assistant would.
   * A null `next` is a removal — the event carries `new_state: null`, which is
   * how HA says an entity is gone rather than merely quiet.
   */
  function applyState(entityId, next) {
    const old = current.find((entity) => entity.entity_id === entityId) ?? null;

    if (next) {
      const now = new Date().toISOString();
      // `last_changed` only moves when the value does — the distinction the
      // whole freshness story rests on, so the mock has to honour it.
      next = {
        ...next,
        last_updated: now,
        last_changed: old && old.state === next.state ? old.last_changed : now,
      };
    }

    current = [
      ...current.filter((entity) => entity.entity_id !== entityId),
      ...(next ? [next] : []),
    ];

    for (const [socket, subscriptionId] of sockets) {
      if (subscriptionId === null || silent) continue;
      socket.send(
        JSON.stringify({
          id: subscriptionId,
          type: "event",
          event: {
            event_type: "state_changed",
            data: { entity_id: entityId, old_state: old, new_state: next },
            time_fired: new Date().toISOString(),
            origin: "LOCAL",
          },
        }),
      );
    }

    return old;
  }

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: pathname });

    if (req.headers.authorization !== `Bearer ${token}`) {
      return sendJson(res, 401, { message: "Unauthorized" });
    }

    if (pathname === "/core/api/states") {
      return sendJson(res, 200, current);
    }

    // Firing an event is how the add-on asks for anything to happen. Home
    // Assistant accepts any type with any JSON body, puts it on the bus and
    // answers with a message — it changes no state and leaves no history,
    // which is the whole reason the target goes out this way. Recorded here
    // because the bus is otherwise unobservable from a test.
    const eventMatch = pathname.match(/^\/core\/api\/events\/(.+)$/);
    if (eventMatch && req.method === "POST") {
      const eventType = decodeURIComponent(eventMatch[1]);
      return readJson(req).then(
        (body) => {
          events.push({ eventType, data: body ?? {} });
          return sendJson(res, 200, { message: `Event ${eventType} fired.` });
        },
        () => sendJson(res, 400, { message: "Invalid JSON specified." }),
      );
    }

    const match = pathname.match(/^\/core\/api\/states\/(.+)$/);
    if (match) {
      const entityId = decodeURIComponent(match[1]);

      // Home Assistant's own API sets a state with a POST to the same path, and
      // that is how a test moves a reading while a page is watching it. Copied
      // rather than mutated in place so a `states` array a caller handed in
      // stays theirs.
      if (req.method === "POST") {
        return readJson(req).then(
          (body) => {
            const existing = current.find(
              (entity) => entity.entity_id === entityId,
            );
            const next = {
              ...existing,
              entity_id: entityId,
              state: String(body?.state ?? ""),
              attributes: body?.attributes ?? existing?.attributes,
            };
            applyState(entityId, next);
            return sendJson(res, existing ? 200 : 201, next);
          },
          () => sendJson(res, 400, { message: "Invalid JSON specified." }),
        );
      }

      const state = current.find((entity) => entity.entity_id === entityId);
      return state
        ? sendJson(res, 200, state)
        : sendJson(res, 404, { message: "Entity not found." });
    }

    return sendJson(res, 404, { message: "Not found" });
  });

  /**
   * The WebSocket half, on the same port under `/core/websocket` — the path the
   * Supervisor proxies. The handshake is Home Assistant's: the server asks
   * first, and nothing but `auth` is answered until it is satisfied.
   */
  const wss = new WebSocketServer({ server, path: "/core/websocket" });

  wss.on("connection", (socket) => {
    let authenticated = false;
    // A silent mock doesn't even greet: a connection that is accepted and then
    // never spoken on is exactly what a dead route looks like, and the client
    // has to get itself out of that too.
    if (!silent) {
      socket.send(
        JSON.stringify({ type: "auth_required", ha_version: HA_VERSION }),
      );
    }

    socket.on("close", () => sockets.delete(socket));

    socket.on("message", (raw) => {
      // A silent mock answers nothing at all while holding the socket open —
      // what a half-open connection looks like from the client's side, and the
      // only failure a `close` handler cannot catch.
      if (silent) return;

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return socket.send(
          JSON.stringify({ type: "invalid_format", message: "not JSON" }),
        );
      }

      if (!authenticated) {
        if (message.type !== "auth") return;
        if (message.access_token !== token) {
          // Home Assistant says why and then hangs up, which is what makes a
          // wrong token distinguishable from an unreachable one.
          socket.send(
            JSON.stringify({
              type: "auth_invalid",
              message: "Invalid access token",
            }),
          );
          return socket.close();
        }
        authenticated = true;
        sockets.set(socket, null);
        return socket.send(
          JSON.stringify({ type: "auth_ok", ha_version: HA_VERSION }),
        );
      }

      const reply = (body) =>
        socket.send(JSON.stringify({ id: message.id, ...body }));

      if (message.type === "ping") {
        return reply({ type: "pong" });
      }

      if (message.type === "get_states") {
        return reply({ type: "result", success: true, result: current });
      }

      if (
        message.type === "subscribe_events" &&
        (message.event_type ?? "state_changed") === "state_changed"
      ) {
        sockets.set(socket, message.id);
        return reply({ type: "result", success: true, result: null });
      }

      return reply({
        type: "result",
        success: false,
        error: { code: "unknown_command", message: message.type },
      });
    });
  });

  const boundPort = await listen(server, port, "The mock Home Assistant API");

  return {
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}`,
    /** What SUPERVISOR_API should be set to. */
    apiUrl: `http://127.0.0.1:${boundPort}/core/api`,
    /** What SUPERVISOR_WS should be set to. */
    wsUrl: `ws://127.0.0.1:${boundPort}/core/websocket`,
    requests,
    events,
    /** How many clients are subscribed right now — one per add-on process. */
    subscriberCount: () =>
      [...sockets.values()].filter((id) => id !== null).length,
    /** Swap the whole state list — for testing unavailable or missing entities. */
    setStates(next) {
      current = next.map((state) => stamped(state));
    },
    /**
     * Stop answering — no pongs, no events — without closing anything.
     *
     * This is the failure the reconnect logic cannot see by itself: a
     * half-open connection never fires `close` and never errors, and since Home
     * Assistant says nothing when nothing changes, a dead socket and a quiet
     * house produce identical silence. Only the ping tells them apart, so this
     * is the only way to prove the watchdog works.
     */
    goSilent() {
      silent = true;
    },
    /** Start answering again, without the client having had to reconnect. */
    stopSilent() {
      silent = false;
    },
    /**
     * Set one state and push it to subscribers, as `POST /states/<id>` does.
     * For tests that would rather not go through HTTP to move a sensor.
     */
    setState(entityId, state, attributes) {
      applyState(entityId, {
        ...current.find((entity) => entity.entity_id === entityId),
        entity_id: entityId,
        state: String(state),
        attributes,
      });
    },
    /** Delete an entity and push the removal, as an integration being removed does. */
    removeState(entityId) {
      applyState(entityId, null);
    },
    /**
     * Push a state exactly as given, timestamps included, without touching the
     * stored list.
     *
     * For the cases a well-behaved Home Assistant will not produce — an event
     * that arrives out of order, say. `setState` stamps the current time, which
     * is precisely what such a test needs to avoid.
     */
    pushState(state) {
      for (const [socket, subscriptionId] of sockets) {
        if (subscriptionId === null || silent) continue;
        socket.send(
          JSON.stringify({
            id: subscriptionId,
            type: "event",
            event: {
              event_type: "state_changed",
              data: {
                entity_id: state.entity_id,
                old_state: null,
                new_state: state,
              },
              time_fired: new Date().toISOString(),
              origin: "LOCAL",
            },
          }),
        );
      }
    },
    /**
     * Hang up on every subscriber without closing the server — how a Home
     * Assistant restart looks from the add-on, and the only way to test that
     * the subscription reconnects and re-reads the states it missed.
     */
    dropSockets() {
      for (const socket of sockets.keys()) socket.terminate();
      sockets.clear();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets.keys()) socket.terminate();
        sockets.clear();
        wss.close(() => {
          // Anything still connected — an add-on mid-reconnect, a request in
          // flight — would otherwise hold `server.close` open indefinitely.
          server.closeAllConnections();
          server.close(resolve);
        });
      }),
  };
}
