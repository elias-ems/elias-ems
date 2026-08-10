/** One live value as the UI shows it. Produced by `readings.server.ts`. */
export type Reading = {
  display: string;
  /** False when the number shown isn't a real current value. */
  ok: boolean;
};
