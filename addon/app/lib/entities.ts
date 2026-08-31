/**
 * Which Home Assistant domain a field is picking from.
 *
 * `sensor` covers every field that picks a **reading**, which is nearly all of
 * them — a target leaves as an event rather than as a value written to an
 * entity, so there is no writable field for other domains to serve.
 * `binary_sensor` exists for the one field that picks a **state** instead:
 * curtailment's "a car wants to charge".
 *
 * An allowlist rather than whatever the query string says. The route is reached
 * by URL, so an unbounded domain parameter would turn a reading picker into a
 * way to enumerate everything in the house — the person, device_tracker and
 * lock entities included. An unrecognised value falls back to the default
 * rather than widening.
 */
export const OFFERABLE_DOMAINS = ["sensor", "binary_sensor"] as const;

export type OfferableDomain = (typeof OFFERABLE_DOMAINS)[number];

export const DEFAULT_OFFERABLE_DOMAIN: OfferableDomain = "sensor";

export function parseOfferableDomain(value: string | null): OfferableDomain {
  return OFFERABLE_DOMAINS.includes(value as OfferableDomain)
    ? (value as OfferableDomain)
    : DEFAULT_OFFERABLE_DOMAIN;
}

/**
 * A Home Assistant entity as offered by the `/api/entities` route, from
 * whichever of `OFFERABLE_DOMAINS` the asking field wanted.
 */
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
