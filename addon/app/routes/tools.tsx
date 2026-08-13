import type { CSSProperties } from "react";
import { useHref } from "react-router";
import DiagnosticsBox from "../components/DiagnosticsBox";
import { headingStyle, hintStyle } from "../components/form";
import { readDiagnostics } from "../lib/diagnostics.server";
import type { Route } from "./+types/tools";

/** Enough of the log to be useful on first paint; the box then polls for more. */
const INITIAL_ENTRIES = 100;

export async function loader() {
  return { entries: readDiagnostics({ limit: INITIAL_ENTRIES }) };
}

export default function Tools({ loaderData }: Route.ComponentProps) {
  // Through `useHref`, so the URL carries the ingress prefix. A plain "/api/…"
  // in an `href` is not something React Router rewrites — it would be resolved
  // against the Home Assistant origin, where this app is not served.
  const downloadHref = useHref("/api/diagnostics.txt");

  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>Tools</h1>

      <section style={{ marginTop: "2rem" }}>
        <div style={sectionHeaderStyle}>
          <h2 style={headingStyle}>Diagnostics</h2>
          {/* A plain anchor, not a Link: the point is a real request, so the
              browser sees the Content-Disposition and saves the file instead of
              client-navigating to it. */}
          <a href={downloadHref} download style={downloadStyle}>
            Download
          </a>
        </div>

        <p style={{ ...hintStyle, marginTop: "0.35rem" }}>
          What every feature has logged since the add-on last started. Held in
          memory only — a restart clears it, so download it before restarting if
          you need to keep it.
        </p>

        <DiagnosticsBox
          initialEntries={loaderData.entries}
          label="Entries"
          defaultOpen
        />
      </section>
    </main>
  );
}

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const downloadStyle: CSSProperties = {
  flex: "none",
  padding: "0.35rem 0.75rem",
  border: "1px solid var(--color-border-strong)",
  borderRadius: 4,
  background: "var(--color-surface)",
  fontSize: "0.875rem",
  textDecoration: "none",
};
