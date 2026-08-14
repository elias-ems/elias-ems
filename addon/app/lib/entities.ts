/** A Home Assistant sensor entity as offered by the `/api/entities` route. */
export type EntityOption = {
  entityId: string;
  name: string;
  unit: string | null;
};

/**
 * What `/api/entities` answers with, and what the autocomplete renders.
 * Declared here rather than in the route or the component for the reason
 * `DiagnosticsData` is: both ends of that request need it and neither may
 * import the other.
 *
 * `error` is a string rather than a thrown response on purpose — an empty
 * dropdown looks exactly like a Home Assistant with no sensors, so an outage
 * has to arrive as something the field can say out loud.
 */
export type EntitiesData = {
  entities: EntityOption[];
  error: string | null;
};
