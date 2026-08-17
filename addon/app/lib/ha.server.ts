const DEFAULT_SUPERVISOR_API = "http://supervisor/core/api";

/**
 * The `supervisor` host only resolves inside Home Assistant. SUPERVISOR_API
 * lets local development point at the stub in `test/ha-mock.js` instead;
 * unset, behaviour is unchanged.
 *
 * Read per call rather than at module load because the stub listens on an
 * ephemeral port under test, and ESM hoists imports above the setup code that
 * would otherwise have assigned the variable first.
 */
function supervisorApi(): string {
  return process.env.SUPERVISOR_API || DEFAULT_SUPERVISOR_API;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How long a single request may take before it is abandoned.
 *
 * `fetch` has no deadline of its own, and a request Home Assistant accepts but
 * never answers — a restart caught mid-flight, a socket that dies without a
 * FIN — would otherwise hang forever. That is not a slow page: it is a promise
 * that never settles, so the home page's refresh loop stops scheduling and the
 * control loop's overlap guard skips every tick from then on. Both look exactly
 * like a frozen add-on.
 *
 * Long enough not to fire on a busy Raspberry Pi, short enough to recover
 * within a tick or two. Read per call, and overridable, for the same reason as
 * `SUPERVISOR_API` above: a test needs to reach the deadline in milliseconds.
 */
function requestTimeoutMs(): number {
  return Number(process.env.HA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

/**
 * The `TimeoutError` an abandoned request raises, restated in terms that mean
 * something on the page — "signal timed out" names the mechanism, not the fault.
 */
function describe(error: unknown, timeout: number): unknown {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? new Error(`Home Assistant did not respond within ${timeout / 1000}s`)
    : error;
}

export type HaState = {
  entity_id: string;
  state: string;
  attributes?: {
    friendly_name?: string;
    unit_of_measurement?: string;
    [key: string]: unknown;
  };
  /**
   * When the value itself last changed, and when the state object last changed
   * at all — the latter also moves when only an attribute did. ISO strings on
   * Home Assistant's clock, present on everything the REST and WebSocket APIs
   * return, and optional here only because a hand-written state in a test isn't
   * obliged to carry them.
   *
   * Worth being precise about what these can and cannot tell you: neither moves
   * when a sensor reports the same value again, so an old timestamp on a
   * quiet sensor is normal rather than a symptom. Whether the connection is
   * healthy is a separate question, answered in `ha-live.server.ts`.
   */
  last_changed?: string;
  last_updated?: string;
};

function supervisorToken(): string {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    throw new Error(
      "SUPERVISOR_TOKEN is not set (only available when running inside Home Assistant)",
    );
  }
  return token;
}

/**
 * The body is read here rather than by the callers so that the timeout covers
 * the whole exchange: the signal keeps running once the headers are in, and a
 * response whose body stalls half way is just as unanswered as one that never
 * arrived.
 */
async function haFetch<T>(
  path: string,
  init?: { method: string; body: unknown },
): Promise<{ ok: boolean; status: number; body: () => Promise<T> }> {
  const timeout = requestTimeoutMs();

  try {
    const response = await fetch(`${supervisorApi()}${path}`, {
      method: init?.method,
      body: init ? JSON.stringify(init.body) : undefined,
      headers: {
        Authorization: `Bearer ${supervisorToken()}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeout),
    });

    return {
      ok: response.ok,
      status: response.status,
      body: async () => {
        try {
          return (await response.json()) as T;
        } catch (error) {
          throw describe(error, timeout);
        }
      },
    };
  } catch (error) {
    throw describe(error, timeout);
  }
}

export async function fetchHaStates(): Promise<HaState[]> {
  const response = await haFetch<HaState[]>("/states");

  if (!response.ok) {
    throw new Error(`Home Assistant API request failed: ${response.status}`);
  }

  return response.body();
}

/**
 * One entity's current state, or null when Home Assistant doesn't know it —
 * an entity id can go stale after it's been picked and saved here.
 */
export async function fetchHaState(entityId: string): Promise<HaState | null> {
  const response = await haFetch<HaState>(
    `/states/${encodeURIComponent(entityId)}`,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Home Assistant API request failed: ${response.status}`);
  }

  return response.body();
}

/**
 * Fires an event on Home Assistant's bus — how this add-on asks for anything
 * to change.
 *
 * The alternative is calling a service, which writes to one entity and leaves a
 * state change, a logbook line and a recorder row behind it for every target.
 * A control loop that ticks every few seconds would fill a day's activity feed
 * with its own arithmetic. An event carries the same instruction and none of
 * that residue: nothing stores it, and an automation is what turns it into
 * whichever service the hardware actually wants.
 *
 * Throws on anything but success, and the caller is expected to catch: a
 * target that fails to go out is one battery not hearing what it was told,
 * which is worth a log line and another attempt on the next tick, not the end
 * of the control loop.
 *
 * Fire-and-forget in the way that matters: a 200 means Home Assistant put the
 * event on the bus, not that any automation was listening, let alone that the
 * hardware obeyed. Nothing here can tell those apart — see
 * `targets.server.ts` for what is done about it.
 */
export async function fireHaEvent(
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const response = await haFetch<unknown>(
    `/events/${encodeURIComponent(eventType)}`,
    { method: "POST", body: data },
  );

  if (!response.ok) {
    throw new Error(
      `Home Assistant rejected the ${eventType} event: ${response.status}`,
    );
  }
}
