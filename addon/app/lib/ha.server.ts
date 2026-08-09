const SUPERVISOR_API = "http://supervisor/core/api";

export type HaState = {
  entity_id: string;
  state: string;
  attributes?: {
    friendly_name?: string;
    unit_of_measurement?: string;
    [key: string]: unknown;
  };
};

export async function fetchHaStates(): Promise<HaState[]> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    throw new Error(
      "SUPERVISOR_TOKEN is not set (only available when running inside Home Assistant)",
    );
  }

  const response = await fetch(`${SUPERVISOR_API}/states`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Home Assistant API request failed: ${response.status}`);
  }

  return response.json() as Promise<HaState[]>;
}
