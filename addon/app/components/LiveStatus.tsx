import { useEffect, useState } from "react";
import type { LiveHealth } from "../lib/readings";
import { hintStyle } from "./form";

/**
 * How the readings on this page are arriving, in one line.
 *
 * It exists because ages here are advisory: nothing refuses to act on an old
 * reading, so the only thing standing between a stuck sensor and a decision
 * made on its last known value is somebody noticing. A number nobody can see
 * guards nothing.
 *
 * Deliberately quiet when all is well — a dot and a word — and only wordy when
 * something is wrong, which is the state worth reading.
 */
export default function LiveStatus({
  health,
  streaming,
}: {
  health: LiveHealth;
  /** Whether the browser's own stream is delivering, which the server can't know. */
  streaming: boolean;
}) {
  const sinceEvent = useElapsedSince(health.lastEventAt);
  const sinceConnected = useElapsedSince(health.connectedSince);

  const { color, label, detail } = describe(health, streaming, {
    sinceEvent,
    sinceConnected,
  });

  return (
    <p
      style={{
        ...hintStyle,
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
      }}
      // The reason, when there is one, without spending a line on it.
      title={health.lastError ?? undefined}
    >
      <span
        aria-hidden="true"
        style={{
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "50%",
          background: color,
          flex: "none",
        }}
      />
      <span style={{ color, fontWeight: 600 }}>{label}</span>
      {detail && <span>· {detail}</span>}
    </p>
  );
}

function describe(
  health: LiveHealth,
  streaming: boolean,
  since: { sinceEvent: string | null; sinceConnected: string | null },
): { color: string; label: string; detail: string | null } {
  if (!health.connected) {
    return {
      color: "var(--color-warning)",
      label: "Reconnecting",
      // Readings still appear — they come over REST while the socket is down —
      // so without saying this the page would look perfectly healthy.
      detail: "showing values read on request",
    };
  }

  if (!streaming) {
    return {
      color: "var(--color-warning)",
      label: "Polling",
      detail: "live updates aren't getting through; refreshing instead",
    };
  }

  // A quiet house produces no events, so "nothing has changed lately" is not a
  // symptom — but a bare "Live" leaves a reader guessing how fresh any of this
  // is. When there has been no change to date, how long the link has been up
  // answers the same question.
  if (since.sinceEvent) {
    return {
      color: "var(--color-success)",
      label: "Live",
      detail: `last change ${since.sinceEvent}`,
    };
  }

  return {
    color: "var(--color-success)",
    label: "Live",
    detail: since.sinceConnected
      ? `connected ${since.sinceConnected}, nothing has changed since`
      : null,
  };
}

/**
 * "3s ago" for an ISO timestamp, or null until the browser has taken over.
 *
 * Null on the server on purpose. A relative time rendered there is already
 * wrong by the time it reaches the browser, and rendering a *different* string
 * on hydration is exactly the mismatch React warns about — so the first paint
 * simply doesn't have one.
 */
function useElapsedSince(iso: string | null): string | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (now === null || !iso) return null;

  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;

  // Clamped: Home Assistant stamps its own clock, and a container running a
  // second behind would otherwise report changes from the future.
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
