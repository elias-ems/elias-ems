/** One live value as the UI shows it. Produced by `readings.server.ts`. */
export type Reading = {
  display: string;
  /** False when the number shown isn't a real current value. */
  ok: boolean;
  /**
   * When the value last changed, in epoch milliseconds, or null when Home
   * Assistant gave no timestamp for it.
   *
   * A number, not a formatted string, and never a relative one: "3s ago"
   * rendered on the server would be wrong by the time it reached the browser
   * and would not survive hydration. The UI formats it, client-side.
   *
   * An old timestamp does not mean a broken sensor. Home Assistant emits
   * nothing when a value is reported unchanged, so a battery sitting at 0 W
   * overnight legitimately looks hours old. Whether the *connection* is healthy
   * is a separate question — see [[LiveHealth]].
   */
  updatedAt: number | null;
};

/**
 * How well the add-on is hearing from Home Assistant, as the page shows it.
 *
 * Rides along with the readings rather than being fetched separately: it
 * describes the same pipe those readings arrived through, and a health
 * indicator that had to be polled would go stale in exactly the situation it
 * exists to report.
 */
export type LiveHealth = {
  /** Whether the WebSocket subscription is up and seeded. */
  connected: boolean;
  /** When Home Assistant last said something moved, ISO, or null. */
  lastEventAt: string | null;
  /**
   * When the current subscription was established, ISO, or null.
   *
   * The fallback for how fresh the picture is: a connection that has been up
   * for a minute without a single event is a perfectly normal quiet house, and
   * "Live" with nothing beside it would leave a reader wondering.
   */
  connectedSince: string | null;
  /** Why the connection last failed, kept while reconnecting. */
  lastError: string | null;
  /** How many times the connection has been rebuilt this process. */
  reconnects: number;
  /** Where these particular readings came from. */
  source: "live" | "rest" | null;
};
