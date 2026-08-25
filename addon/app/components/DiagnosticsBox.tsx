import type { ReactNode } from "react";
import { useState } from "react";
import {
  type DiagnosticEntry,
  type DiagnosticsData,
  type DiagnosticsOrigin,
  diagnosticsOriginLabel,
} from "../lib/diagnostics";
import { usePolledJson } from "../lib/json-fetch";
import { hintStyle } from "./form";

/** Fast enough to watch a five-second loop without polling for its own sake. */
const POLL_INTERVAL = 2_000;

/** The same, while the browser says the page is hidden. */
const HIDDEN_POLL_INTERVAL = 60_000;

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

  const href = origin
    ? `/api/diagnostics?origin=${origin}`
    : "/api/diagnostics";

  // Not `useFetcher`: a failed poll there is a route error, which would take
  // the whole page down over a log nobody had to be able to read. See
  // `lib/json-fetch.ts`.
  const { data, failing } = usePolledJson<DiagnosticsData>(href, {
    enabled: open,
    intervalMs: POLL_INTERVAL,
    hiddenIntervalMs: HIDDEN_POLL_INTERVAL,
  });

  const entries = data?.entries ?? initialEntries;

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
        {failing && " · not updating"}
      </p>

      {children}

      {entries.length > 0 && (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            // Grows with the window rather than sitting at a fixed 260px:
            // this box is the whole of the Tools page, and a log that stops a
            // third of the way down a 1400px-tall panel wastes the room the
            // one thing on the page could be using. Floored so a short window
            // still shows a few lines, capped so a very tall one does not
            // scroll the page instead of the list.
            maxHeight: "clamp(14rem, 62vh, 46rem)",
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
