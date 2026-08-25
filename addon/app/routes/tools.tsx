import type { CSSProperties } from "react";
import { Link, useHref } from "react-router";
import DiagnosticsBox from "../components/DiagnosticsBox";
import {
  cardStyle,
  headingStyle,
  hintStyle,
  pageTitleStyle,
} from "../components/form";
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
    <main className="page">
      <h1 style={pageTitleStyle}>Tools</h1>

      <section style={{ ...cardStyle, marginTop: "1.5rem" }}>
        <div style={sectionHeaderStyle}>
          <h2 style={headingStyle}>Diagnostics</h2>
          {/* A plain anchor, not a Link: the point is a real request, so the
              browser sees the Content-Disposition and saves the file instead of
              client-navigating to it. */}
          <a href={downloadHref} download style={downloadStyle}>
            Download
          </a>
        </div>

        <p style={{ ...hintStyle, marginTop: "0.35rem", maxWidth: "62ch" }}>
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

      {/*
        Below the diagnostics rather than beside them: what is here is for
        whoever is working on the add-on, not for whoever is running it, and a
        section anyone can reach should not put a developer's page at eye level.
        It is on Tools rather than in Settings because nothing in it is a
        setting — Settings is where the installation is described, and this
        changes nothing about it.
      */}
      <section style={{ ...cardStyle, marginTop: "1.25rem" }}>
        <h2 style={headingStyle}>Debug</h2>
        <p style={{ ...hintStyle, marginTop: "0.35rem", maxWidth: "62ch" }}>
          Not part of running the add-on — these are for working on it.
        </p>

        <ul style={debugListStyle}>
          <li>
            <Link to="/playground">Component playground</Link>
            <p style={{ ...hintStyle, marginTop: "0.15rem", maxWidth: "62ch" }}>
              Every component the add-on draws with, in the states that matter —
              including the ones a working installation never reaches. Useful
              for checking the light and dark themes and the layout breakpoints
              against Home Assistant's own theme, which only exists inside a
              real panel.
            </p>
          </li>
        </ul>
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

const debugListStyle: CSSProperties = {
  listStyle: "none",
  margin: "1rem 0 0",
  padding: 0,
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
