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

export type HaState = {
  entity_id: string;
  state: string;
  attributes?: {
    friendly_name?: string;
    unit_of_measurement?: string;
    [key: string]: unknown;
  };
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

async function haFetch(path: string): Promise<Response> {
  return fetch(`${supervisorApi()}${path}`, {
    headers: {
      Authorization: `Bearer ${supervisorToken()}`,
      "Content-Type": "application/json",
    },
  });
}

export async function fetchHaStates(): Promise<HaState[]> {
  const response = await haFetch("/states");

  if (!response.ok) {
    throw new Error(`Home Assistant API request failed: ${response.status}`);
  }

  return response.json() as Promise<HaState[]>;
}

/**
 * One entity's current state, or null when Home Assistant doesn't know it —
 * an entity id can go stale after it's been picked and saved here.
 */
export async function fetchHaState(entityId: string): Promise<HaState | null> {
  const response = await haFetch(`/states/${encodeURIComponent(entityId)}`);

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Home Assistant API request failed: ${response.status}`);
  }

  return response.json() as Promise<HaState>;
}
