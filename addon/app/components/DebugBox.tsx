import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { ControlLogData, ControlLogEntry } from "../lib/control";
import type { LiveHealth } from "../lib/readings";
import { hintStyle } from "./form";

/** Fast enough to watch a five-second loop without polling for its own sake. */
const POLL_INTERVAL = 2_000;

/** One label-and-value pair in the health list. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd style={{ margin: 0, color: "var(--color-text)" }}>{value}</dd>
    </>
  );
}

const LEVEL_COLOR: Record<ControlLogEntry["level"], string> = {
  info: "var(--color-text)",
  warn: "var(--color-warning)",
  error: "var(--color-danger)",
};

/**
 * The control loop's decisions, collapsed by default. Only polls while it is
 * open — a debug box nobody is looking at should cost nothing.
 */
export default function DebugBox({
  initial,
  health,
}: {
  initial: ControlLogData;
  /** The live path's health, as the readings stream last reported it. */
  health: LiveHealth;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<ControlLogData>();

  // useFetcher returns a new object every render, so depending on fetcher.load
  // would restart the interval on each render and refire immediately. Only
  // `open` should retrigger it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return undefined;

    const poll = () => {
      // The add-on panel usually sits in a background tab; there is no point
      // polling one nobody can see.
      if (document.visibilityState === "visible") {
        fetcher.load("/api/control-log");
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [open]);

  const { status, entries } = fetcher.data ?? initial;

  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      style={{
        marginTop: "1rem",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        padding: "0.5rem 0.75rem",
      }}
    >
      <summary style={{ cursor: "pointer", fontSize: "0.875rem" }}>
        Debug log{" "}
        <span style={{ color: "var(--color-text-muted)" }}>
          ({status.running ? "loop running" : "loop stopped"})
        </span>
      </summary>

      <p style={{ ...hintStyle, margin: "0.5rem 0" }}>
        {status.strategy} · on change, at most every {status.intervalSeconds}s ·{" "}
        {entries.length === 0
          ? "nothing logged yet"
          : `${entries.length} entries`}
      </p>

      <dl
        style={{
          ...hintStyle,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.15rem 0.75rem",
          margin: "0 0 0.75rem",
        }}
      >
        <Fact
          label="Home Assistant"
          value={health.connected ? "subscribed" : "not connected"}
        />
        <Fact
          label="Last change seen"
          value={health.lastEventAt ?? "none yet"}
        />
        <Fact
          label="Readings from"
          value={health.source ?? "nothing read yet"}
        />
        {/* Only worth the line once it has happened: a stable connection
            should not spend space telling you it is stable. */}
        {health.reconnects > 0 && (
          <Fact label="Reconnects" value={String(health.reconnects)} />
        )}
        {health.lastError && (
          <Fact label="Last error" value={health.lastError} />
        )}
      </dl>

      {entries.length > 0 && (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            maxHeight: 260,
            overflowY: "auto",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.75rem",
            lineHeight: 1.6,
          }}
        >
          {entries.map((entry) => (
            <li
              key={entry.seq}
              style={{
                color: LEVEL_COLOR[entry.level],
                // One entry covers a whole tick — a summary line plus one line
                // per battery — so its newlines have to survive.
                whiteSpace: "pre-wrap",
                marginTop: "0.4rem",
              }}
            >
              <span style={{ color: "var(--color-text-muted)" }}>
                {entry.time}
              </span>{" "}
              {entry.message}
              {entry.repeat > 1 && (
                <span style={{ color: "var(--color-text-muted)" }}>
                  {" "}
                  ×{entry.repeat}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
