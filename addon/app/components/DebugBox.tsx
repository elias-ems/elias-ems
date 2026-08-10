import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { ControlLogEntry, ControlLoopStatus } from "../lib/control";
import { hintStyle } from "./form";

type ControlLogData = {
  status: ControlLoopStatus;
  entries: ControlLogEntry[];
};

/** Fast enough to watch a five-second loop without polling for its own sake. */
const POLL_INTERVAL = 2_000;

const LEVEL_COLOR: Record<ControlLogEntry["level"], string> = {
  info: "var(--color-text)",
  warn: "var(--color-warning)",
  error: "var(--color-danger)",
};

/**
 * The control loop's decisions, collapsed by default. Only polls while it is
 * open — a debug box nobody is looking at should cost nothing.
 */
export default function DebugBox({ initial }: { initial: ControlLogData }) {
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
        {status.strategy} · every {status.intervalSeconds}s ·{" "}
        {entries.length === 0
          ? "nothing logged yet"
          : `${entries.length} entries`}
      </p>

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
