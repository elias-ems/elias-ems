import type { CSSProperties } from "react";
import { useHref } from "react-router";
import { cardStyle, hintStyle, pageTitleStyle } from "../components/form";

const SANDBOX_URL = "https://elias-ems.github.io/elias-ems/planner";

// The benchmark used to run here, against a bundled dataset. Comparing
// strategies now happens in the Planner sandbox on the documentation site,
// which replays an export from this add-on — so all this page has to do is
// point there and hand over that export.
export default function Benchmark() {
  // Through `useHref`, so the URL carries the ingress prefix — the same
  // download the Tools page offers.
  const exportHref = useHref("/api/planner-export.json");

  return (
    <main className="page">
      <h1 style={pageTitleStyle}>Benchmark</h1>

      <section style={{ ...cardStyle, marginTop: "1.5rem" }}>
        <p style={{ margin: 0, maxWidth: "62ch", lineHeight: 1.5 }}>
          Battery strategies are now compared in the{" "}
          <a href={SANDBOX_URL} target="_blank" rel="noreferrer">
            Planner sandbox
          </a>{" "}
          on the documentation site. It replays your own planner data through
          every strategy under the same physical model and shows what each one
          would have cost.
        </p>

        <ol style={stepsStyle}>
          <li>Download the current planner export below.</li>
          <li>
            Open the{" "}
            <a href={SANDBOX_URL} target="_blank" rel="noreferrer">
              Planner sandbox
            </a>{" "}
            and import the file.
          </li>
        </ol>

        {/* A plain anchor, not a Link: the browser has to see the
            Content-Disposition to save the file rather than navigate to it. */}
        <a href={exportHref} download style={primaryButtonStyle}>
          Download planner export
        </a>

        <p style={{ ...hintStyle, marginTop: "0.75rem", maxWidth: "62ch" }}>
          The export holds your configured devices, load and solar forecasts,
          dynamic tariffs and interval models. The sandbox reads it in your
          browser; nothing is uploaded.
        </p>
      </section>
    </main>
  );
}

const stepsStyle: CSSProperties = {
  margin: "1rem 0 1.25rem",
  paddingLeft: "1.25rem",
  lineHeight: 1.6,
};

// The header's blue, which already clears AA under white text in both themes.
const primaryButtonStyle: CSSProperties = {
  display: "inline-block",
  padding: "0.6rem 1.1rem",
  borderRadius: 4,
  background: "var(--color-header-bg)",
  color: "var(--color-header-text)",
  fontWeight: 600,
  textDecoration: "none",
};
