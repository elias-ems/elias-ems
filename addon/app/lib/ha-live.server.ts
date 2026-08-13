/**
 * The live half of talking to Home Assistant: one WebSocket per add-on process,
 * subscribed to every state change, keeping a cache of the entities as they are
 * right now.
 *
 * This is what makes a reading on the dashboard current rather than as fresh as
 * the last time someone asked. The REST calls in `ha.server.ts` answer "what is
 * it now?" one entity at a time and cost a round trip each; this answers the
 * same question from memory, and Home Assistant is the one who says when the
 * answer changed.
 *
 * Module-level state for the same reason as `control-loop.server.ts`: the
 * server build is loaded once per process, so "one subscription per add-on" and
 * "one module instance" are the same statement. Every connected browser shares
 * this one socket.
 *
 * It is deliberately not authoritative. Nothing here throws at a caller, and
 * every reader is expected to cope with `null` — outside Home Assistant the
 * socket never connects at all, and that has to stay a degraded page rather
 * than a broken one.
 */
import type { HaState } from "./ha.server";

const DEFAULT_SUPERVISOR_WS = "ws://supervisor/core/websocket";

/**
 * Read per call, like `supervisorApi()`, so tests can point it at the mock
 * after ESM has hoisted the imports.
 */
function supervisorWs(): string {
  return process.env.SUPERVISOR_WS || DEFAULT_SUPERVISOR_WS;
}

/** The entity that changed, or null when the whole cache was replaced. */
export type HaChange = string | null;

export type HaLiveStatus = {
  connected: boolean;
  /** How many entities the cache is holding — 0 until the first seed lands. */
  entities: number;
  /** Why the last attempt ended, kept while reconnecting so it can be shown. */
  lastError: string | null;
  connectedSince: string | null;
  /**
   * When Home Assistant last told us anything moved, and when it last answered
   * a ping. Between them they are the honest answer to "is our picture of the
   * house current?" — which no entity's own timestamp can give, because a quiet
   * house produces no events at all.
   */
  lastEventAt: string | null;
  lastPongAt: string | null;
  /** How many times the connection has had to be rebuilt this process. */
  reconnects: number;
};

/** A cached state, with when we heard it — our clock, not Home Assistant's. */
type Cached = {
  state: HaState;
  receivedAt: number;
};

type Live = {
  socket: WebSocket | null;
  /** True only between a successful seed and the socket closing. */
  ready: boolean;
  states: Map<string, Cached>;
  listeners: Set<(changed: HaChange) => void>;
  /** Message ids are per connection and must ascend; both sides rely on it. */
  nextId: number;
  seedId: number | null;
  subscriptionId: number | null;
  pingId: number | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** Runs out if a pong doesn't come back, which is the only sign of a mute socket. */
  pongDeadline: ReturnType<typeof setTimeout> | null;
  /** The same, for a connection that opens and then says nothing at all. */
  handshakeDeadline: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  attempts: number;
  reconnects: number;
  lastError: string | null;
  connectedSince: string | null;
  lastEventAt: number | null;
  lastPongAt: number | null;
};

const live: Live = {
  socket: null,
  ready: false,
  states: new Map(),
  listeners: new Set(),
  nextId: 1,
  seedId: null,
  subscriptionId: null,
  pingId: null,
  heartbeat: null,
  pongDeadline: null,
  handshakeDeadline: null,
  retry: null,
  attempts: 0,
  reconnects: 0,
  lastError: null,
  connectedSince: null,
  lastEventAt: null,
  lastPongAt: null,
};

/** Backoff bounds. A restarting Home Assistant is back in seconds; a missing one never is. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * How often to ask Home Assistant whether it is still there, and how long to
 * wait for the answer.
 *
 * The reconnect logic below hangs off the socket's `close` event, which covers
 * a Home Assistant that goes away politely. It does not cover a connection that
 * dies without either end noticing — a dropped route, a NAT table that forgot
 * us — because a half-open TCP socket never closes and never errors. Since Home
 * Assistant sends nothing at all when nothing changes, silence on a healthy
 * connection and silence on a dead one are the same silence. The ping is what
 * tells them apart.
 */
const HEARTBEAT_MS = 30_000;

/**
 * One knob for the whole liveness clock, in milliseconds — the ping period,
 * with the two deadlines derived from it: 10s to answer a ping and 15s to
 * finish a handshake, at the default 30s period.
 *
 * Derived rather than three separate settings so they cannot drift into a
 * combination that makes no sense, and overridable for the same reason as
 * `HA_TIMEOUT_MS` in `ha.server.ts`: a test has to be able to reach these
 * deadlines in milliseconds instead of in half a minute.
 */
function heartbeatMs(): number {
  return Number(process.env.HA_HEARTBEAT_MS) || HEARTBEAT_MS;
}

/** How long Home Assistant has to answer a ping before the socket is written off. */
const pongTimeoutMs = () => heartbeatMs() / 3;

/**
 * How long a connection has to get all the way to a seeded cache.
 *
 * A socket that opens and is then never spoken on — a dead route, a proxy that
 * accepts and forwards nowhere — would otherwise sit there forever: the
 * heartbeat only starts once the handshake finishes, so nothing else would ever
 * notice. This is the watchdog for the part before the watchdog.
 */
const handshakeTimeoutMs = () => heartbeatMs() / 2;

function announce(changed: HaChange): void {
  for (const listener of live.listeners) {
    try {
      listener(changed);
    } catch {
      // A listener that throws is a bug in that listener. It must not take
      // down the socket everything else is reading from.
    }
  }
}

function send(message: Record<string, unknown>): number {
  const id = live.nextId++;
  live.socket?.send(JSON.stringify({ id, ...message }));
  return id;
}

/**
 * Home Assistant speaks first (`auth_required`), and answers nothing else until
 * the token satisfies it. After that: read everything once, then subscribe.
 *
 * The seed is not an optimisation. Events only ever say what *changed*, so a
 * cache that started empty would stay empty for every entity that happens not
 * to move — and it has to be redone on every reconnect, because whatever
 * changed while the socket was down was never delivered to anyone.
 */
function handle(raw: string): void {
  let message: {
    type?: string;
    id?: number;
    message?: string;
    result?: HaState[];
    event?: { data?: { entity_id?: string; new_state?: HaState | null } };
  };

  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "auth_required") {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) {
      live.lastError = "SUPERVISOR_TOKEN is not set";
      live.socket?.close();
      return;
    }
    live.socket?.send(JSON.stringify({ type: "auth", access_token: token }));
    return;
  }

  if (message.type === "auth_invalid") {
    // Worth naming precisely: a rejected token looks exactly like an
    // unreachable Home Assistant from the outside, and is fixed differently.
    live.lastError = `Home Assistant rejected the token: ${message.message}`;
    live.socket?.close();
    return;
  }

  if (message.type === "auth_ok") {
    live.seedId = send({ type: "get_states" });
    live.subscriptionId = send({
      type: "subscribe_events",
      event_type: "state_changed",
    });
    return;
  }

  if (message.type === "pong" && message.id === live.pingId) {
    live.lastPongAt = Date.now();
    if (live.pongDeadline) clearTimeout(live.pongDeadline);
    live.pongDeadline = null;
    return;
  }

  if (message.type === "result" && message.id === live.seedId) {
    const receivedAt = Date.now();
    live.states = new Map(
      (message.result ?? []).map((state) => [
        state.entity_id,
        { state, receivedAt },
      ]),
    );
    live.ready = true;
    live.attempts = 0;
    live.lastError = null;
    live.connectedSince = new Date().toISOString();
    if (live.handshakeDeadline) clearTimeout(live.handshakeDeadline);
    live.handshakeDeadline = null;
    startHeartbeat();
    announce(null);
    return;
  }

  if (message.type === "event" && message.id === live.subscriptionId) {
    const entityId = message.event?.data?.entity_id;
    if (!entityId) return;

    live.lastEventAt = Date.now();

    const next = message.event?.data?.new_state ?? null;
    // A null new_state is an entity being removed, not one going quiet. Drop it
    // so readers report it missing rather than serving its last known value
    // forever.
    if (!next) {
      live.states.delete(entityId);
      announce(entityId);
      return;
    }

    // Ordering makes an out-of-order event impossible today — `get_states` is
    // sent before `subscribe_events` and Home Assistant answers in order — and
    // that is exactly why it is worth enforcing rather than relying on. A seed
    // landing on top of a newer event would put the cache quietly in the past.
    if (isOlderThanCached(entityId, next)) return;

    live.states.set(entityId, { state: next, receivedAt: Date.now() });
    announce(entityId);
  }
}

function isOlderThanCached(entityId: string, next: HaState): boolean {
  const held = live.states.get(entityId)?.state.last_updated;
  if (!held || !next.last_updated) return false;
  return Date.parse(next.last_updated) < Date.parse(held);
}

/**
 * Ask, periodically, whether the connection is still there — and hang up on it
 * when the answer doesn't come. Closing is what puts it back on the reconnect
 * path; there is nothing else to be done with a socket that has stopped
 * answering, and holding it open would look like health forever.
 */
function startHeartbeat(): void {
  stopHeartbeat();

  live.heartbeat = setInterval(() => {
    if (!live.socket || live.pongDeadline) return;

    live.pingId = send({ type: "ping" });
    live.pongDeadline = setTimeout(() => {
      live.pongDeadline = null;
      live.lastError = "Home Assistant stopped answering pings";
      live.socket?.close();
    }, pongTimeoutMs());
    live.pongDeadline.unref?.();
  }, heartbeatMs());
  live.heartbeat.unref?.();
}

function stopHeartbeat(): void {
  if (live.heartbeat) clearInterval(live.heartbeat);
  if (live.pongDeadline) clearTimeout(live.pongDeadline);
  if (live.handshakeDeadline) clearTimeout(live.handshakeDeadline);
  live.heartbeat = null;
  live.pongDeadline = null;
  live.handshakeDeadline = null;
  live.pingId = null;
}

function scheduleReconnect(): void {
  if (live.retry) return;

  // Jittered, so several add-on restarts in a row don't line up their retries.
  const backoff = Math.min(
    MAX_RETRY_MS,
    FIRST_RETRY_MS * 2 ** Math.min(live.attempts, 5),
  );
  const delay = backoff * (0.8 + Math.random() * 0.4);
  live.attempts += 1;

  live.retry = setTimeout(() => {
    live.retry = null;
    connect();
  }, delay);
  // Nothing here should be what keeps node alive; the HTTP server is.
  live.retry.unref?.();
}

function connect(): void {
  if (live.socket) return;

  let socket: WebSocket;
  try {
    socket = new WebSocket(supervisorWs());
  } catch (error) {
    // A malformed URL fails here rather than on the wire, and would otherwise
    // throw straight into whichever request happened to start the connection.
    live.lastError = error instanceof Error ? error.message : String(error);
    return;
  }

  live.socket = socket;

  live.handshakeDeadline = setTimeout(() => {
    live.handshakeDeadline = null;
    live.lastError = "Home Assistant accepted the connection but never spoke";
    socket.close();
  }, handshakeTimeoutMs());
  live.handshakeDeadline.unref?.();

  socket.addEventListener("message", (event) => {
    handle(String(event.data));
  });

  socket.addEventListener("error", () => {
    // The event carries nothing useful about the cause; `close` follows it and
    // is where the reconnect is decided. Leave whatever `handle` recorded.
    live.lastError ??= `Cannot reach Home Assistant at ${supervisorWs()}`;
  });

  socket.addEventListener("close", () => {
    // Already detached means `stopHaLive` closed this one deliberately.
    // Reconnecting a subscription that was just shut down would resurrect it.
    if (live.socket !== socket) return;

    live.socket = null;
    live.subscriptionId = null;
    live.seedId = null;
    live.connectedSince = null;
    stopHeartbeat();

    if (live.ready) {
      live.ready = false;
      live.reconnects += 1;
      // The cache is now a set of claims about the past. Readers fall back to
      // REST while it is in this state, so it can be kept for the reconnect to
      // overwrite rather than blanking the page in the meantime.
      announce(null);
    }

    scheduleReconnect();
  });
}

/**
 * Bring the subscription up if it isn't already. Idempotent, and safe to call
 * on every read — which is how it gets started, rather than at boot: outside
 * Home Assistant neither the hostname nor the token exists, and an add-on that
 * is only ever run locally should stay quiet instead of retrying forever.
 */
export function startHaLive(): void {
  if (live.socket || live.retry) return;
  if (!process.env.SUPERVISOR_TOKEN) {
    live.lastError = "SUPERVISOR_TOKEN is not set";
    return;
  }
  connect();
}

/**
 * The current states for `ids`, or null when the subscription can't answer —
 * not connected, or connected but not yet seeded. Null means "ask Home
 * Assistant yourself"; it is never a claim about the entities.
 *
 * An id the cache doesn't hold while it *is* seeded is a different thing: Home
 * Assistant genuinely has no such entity, which is the same answer REST gives
 * as a 404, so it maps to null inside the map.
 */
export function liveStates(ids: string[]): Map<string, HaState | null> | null {
  startHaLive();
  if (!live.ready) return null;

  return new Map(ids.map((id) => [id, live.states.get(id)?.state ?? null]));
}

/**
 * Called whenever an entity changes, with its id — or with null when the whole
 * cache was replaced or invalidated, which a reader should treat as "anything
 * may have changed".
 *
 * @returns the unsubscribe function. A caller that forgets it leaks a listener
 * per connection, which for the SSE route means one per browser tab ever opened.
 */
export function onHaChange(listener: (changed: HaChange) => void): () => void {
  live.listeners.add(listener);
  return () => {
    live.listeners.delete(listener);
  };
}

const iso = (at: number | null) =>
  at === null ? null : new Date(at).toISOString();

export function haLiveStatus(): HaLiveStatus {
  return {
    connected: live.ready,
    entities: live.states.size,
    lastError: live.lastError,
    connectedSince: live.connectedSince,
    lastEventAt: iso(live.lastEventAt),
    lastPongAt: iso(live.lastPongAt),
    reconnects: live.reconnects,
  };
}

/**
 * Close the subscription and forget everything it knows.
 *
 * Test-only in spirit, but not only in effect: an open socket keeps node's
 * event loop alive, so a test file that starts one and doesn't call this hangs
 * the whole run.
 */
export function stopHaLive(): void {
  if (live.retry) clearTimeout(live.retry);
  live.retry = null;
  stopHeartbeat();

  const socket = live.socket;
  live.socket = null;
  // Detached first: the close handler would otherwise schedule a reconnect for
  // the very socket being shut down.
  socket?.close();

  live.ready = false;
  live.states = new Map();
  live.listeners.clear();
  live.nextId = 1;
  live.seedId = null;
  live.subscriptionId = null;
  live.attempts = 0;
  live.reconnects = 0;
  live.lastError = null;
  live.connectedSince = null;
  live.lastEventAt = null;
  live.lastPongAt = null;
}
