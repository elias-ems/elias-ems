/** A Home Assistant sensor entity as offered by the `/api/entities` route. */
export type EntityOption = {
  entityId: string;
  name: string;
  unit: string | null;
};
