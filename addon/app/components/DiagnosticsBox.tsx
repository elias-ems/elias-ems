import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  type DiagnosticEntry,
  type DiagnosticsData,
  type DiagnosticsOrigin,
  diagnosticsOriginLabel,
} from "../lib/diagnostics";
import { hintStyle } from "./form";

/** Fast enough to watch a five-second loop without polling for its own sake. */
const POLL_INTERVAL = 2_000;

const LEVEL_COLOR: Record<DiagnosticEntry["level"], string> = {
  info: "var(--color-text)",
  warn: "var(--color-warning)",
  error: "var(--color-danger)",
};

/**
 * A feature's diagnostics, or every feature's. Only polls while it is open — a
 * log nobody is looking at should cost nothing.
 *
 * `origin` is both the filter and the switch for whether each line says where it
 * came from: inside a feature's own section that would be the same word every
 * time, and on the Tools page it is the only way to tell the entries apart.
 */
export default function DiagnosticsBox({
  origin,
  initialEntries,
  label = "Diagnostics",
  subtitle,
  defaultOpen = false,
  children,
}: {
  origin?: DiagnosticsOrigin;
  /** What the page's loader read, shown until the first poll comes back. */
  initialEntries: DiagnosticEntry[];
  /**
   * What the disclosure calls itself. The default is right under a feature's
   * own heading; a page that already says "Diagnostics" above the box wants
   * something that isn't the same word twice.
   */
  label?: string;
  /** Feature-specific context for the summary line, e.g. whether a loop is running. */
  subtitle?: string;
  defaultOpen?: boolean;
  /**
   * Feature-specific detail to show above the entries — the live path's health,
   * on the home page. It belongs *with* the log rather than in it: the same
   * person opening the box to read what happened wants to know whether the
   * numbers behind it were arriving. Anything origin-specific goes here rather
   * than in this component, which has to stay true for every feature.
   */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const fetcher = useFetcher<DiagnosticsData>();

  const href = origin
    ? `/api/diagnostics?origin=${origin}`
    : "/api/diagnostics";

  // useFetcher returns a new object every render, so depending on fetcher.load
  // would restart the interval on each render and refire immediately. Only
  // `open` and the URL should retrigger it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return undefined;

    const poll = () => {
      // The add-on panel usually sits in a background tab; there is no point
      // polling one nobody can see.
      if (document.visibilityState === "visible") {
        fetcher.load(href);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [open, href]);

  const entries = fetcher.data?.entries ?? initialEntries;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      style={{
        marginTop: "1rem",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        padding: "0.5rem 0.75rem",
      }}
    >
      <summary style={{ cursor: "pointer", fontSize: "0.875rem" }}>
        {label}
      </summary>

      <p style={{ ...hintStyle, margin: "0.5rem 0" }}>
        {subtitle ? `${subtitle} · ` : ""}
        {entries.length === 0
          ? "nothing logged yet"
          : `${entries.length} entries`}
      </p>

      {children}

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
                // One control tick is a whole entry — a summary line plus one
                // line per battery — so its newlines have to survive.
                whiteSpace: "pre-wrap",
                marginTop: "0.4rem",
              }}
            >
              <span style={{ color: "var(--color-text-muted)" }}>
                {entry.time}
              </span>{" "}
              {!origin && (
                <span style={{ color: "var(--color-text-muted)" }}>
                  [{diagnosticsOriginLabel(entry.origin)}]{" "}
                </span>
              )}
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
