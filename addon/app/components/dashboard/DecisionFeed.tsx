/**
 * What both control loops have just decided, in one list.
 *
 * One feed rather than a collapsed box per strategy, which is what the page had
 * before. The two loops act on the same meter within milliseconds of each
 * other, and the thing worth seeing is usually the *pair* — a limit tightening
 * and a battery target moving in response to the same reading. Two separate
 * boxes, each closed by default, put those on opposite sides of the page and
 * made the reader open both and interleave the timestamps by eye.
 *
 * Only the two strategy origins. Passing no filter would fold in `prices`,
 * whose entries are parse failures rather than decisions — those belong on the
 * Tools page, which is where the link at the foot goes.
 */
import { Link } from "react-router";
import type {
  DiagnosticEntry,
  DiagnosticsData,
  DiagnosticsOrigin,
} from "../../lib/diagnostics";
import { usePolledJson } from "../../lib/json-fetch";
import { captionStyle, cardLinkStyle, eyebrowStyle, monoStyle } from "./chrome";

/** Fast enough to watch a five-second loop without polling for its own sake. */
const POLL_INTERVAL = 2_000;

/** The same, while the browser says the page is hidden. */
const HIDDEN_POLL_INTERVAL = 60_000;

const ORIGINS: DiagnosticsOrigin[] = ["pv-curtailment", "battery-control"];

const FEED_URL = `/api/diagnostics?${ORIGINS.map(
  (origin) => `origin=${origin}`,
).join("&")}`;

/** The short badge each line is tagged with, so two loops stay tellable apart. */
const BADGE: Record<
  string,
  { label: string; color: string; background: string }
> = {
  "pv-curtailment": {
    label: "PV",
    color: "var(--color-pv)",
    background: "var(--color-pv-soft)",
  },
  "battery-control": {
    label: "BATT",
    color: "var(--color-battery)",
    background: "var(--color-battery-soft)",
  },
};

const LEVEL_COLOR: Record<DiagnosticEntry["level"], string> = {
  info: "var(--color-text)",
  warn: "var(--color-warning)",
  error: "var(--color-danger)",
};

export default function DecisionFeed({
  initialEntries,
  limit = 8,
}: {
  /** What the page's loader read, shown until the first poll comes back. */
  initialEntries: DiagnosticEntry[];
  limit?: number;
}) {
  // Not `useFetcher`: a poll this fast is a request that will eventually fail,
  // and a fetcher's failure is a route error that would replace the whole
  // dashboard with an error page. See `lib/json-fetch.ts`.
  const { data, failing } = usePolledJson<DiagnosticsData>(FEED_URL, {
    intervalMs: POLL_INTERVAL,
    hiddenIntervalMs: HIDDEN_POLL_INTERVAL,
  });

  const entries = (data?.entries ?? initialEntries).slice(0, limit);

  return (
    <div
      style={{
        padding: "0.9375rem 1.125rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        minWidth: 0,
      }}
    >
      <h3 style={eyebrowStyle}>
        Decisions
        {/* The lines below are then whatever last arrived, which without
            saying so reads exactly like a loop that has gone quiet. */}
        {failing && (
          <span style={{ color: "var(--color-warning)" }}> · not updating</span>
        )}
      </h3>

      {entries.length === 0 ? (
        <p style={{ ...captionStyle, margin: 0 }}>
          Nothing decided yet. Lines appear here as the loops run.
        </p>
      ) : (
        <ol
          className="dash-feed"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {entries.map((entry) => (
            <Row key={entry.seq} entry={entry} />
          ))}
        </ol>
      )}

      <Link
        to="/tools"
        style={{ ...cardLinkStyle, fontSize: "0.71875rem", marginTop: "auto" }}
      >
        Full diagnostics
      </Link>
    </div>
  );
}

function Row({ entry }: { entry: DiagnosticEntry }) {
  const badge = BADGE[entry.origin];

  return (
    // `display: grid` is in app.css rather than here, alone among this row's
    // styles: the phone breakpoint hides all but the first three rows, and an
    // inline `display` outranks any stylesheet rule trying to. Everything else
    // about the row stays inline, as the rest of the dashboard does.
    <li
      style={{
        gridTemplateColumns: "auto 3.25rem minmax(0, 1fr)",
        gap: "0.625rem",
        alignItems: "baseline",
        padding: "0.375rem 0",
        borderBottom: "1px solid var(--color-border)",
        fontSize: "0.71875rem",
        lineHeight: 1.4,
      }}
    >
      <span style={{ ...monoStyle, color: "var(--color-text-muted)" }}>
        {entry.time}
      </span>
      <span
        style={{
          fontSize: "0.59375rem",
          fontWeight: 700,
          letterSpacing: "0.07em",
          padding: "0.125rem 0.3125rem",
          borderRadius: 3,
          textAlign: "center",
          color: badge?.color ?? "var(--color-text-muted)",
          background: badge?.background ?? "var(--color-surface-raised)",
        }}
      >
        {badge?.label ?? entry.origin}
      </span>
      {/*
        First line only. A battery-control tick logs a summary and then one line
        per battery, which is the right amount of detail in the Tools page's log
        and four times too much in a column this narrow.
      */}
      <span style={{ color: LEVEL_COLOR[entry.level] }}>
        {entry.message.split("\n")[0]}
        {entry.repeat > 1 && (
          <span style={{ color: "var(--color-text-muted)" }}>
            {" "}
            ×{entry.repeat}
          </span>
        )}
      </span>
    </li>
  );
}
