import { useHref } from "react-router";
import ChargePlanCard from "../components/dashboard/ChargePlanCard";
import { ruleStyle } from "../components/dashboard/chrome";
import { readChargeLimits } from "../lib/charge-limit-loop.server";
import type { Route } from "./+types/plans";

export async function loader() {
  return { chargeLimits: await readChargeLimits() };
}

export default function Plans({ loaderData }: Route.ComponentProps) {
  const exportHref = useHref("/api/planner-export.json");

  return (
    <main className="page dash">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Energy plans</h1>
          <p style={{ ...ruleStyle, marginTop: "0.35rem", maxWidth: "68ch" }}>
            Forecast demand, solar, battery behaviour and PV curtailment on one
            timeline. These are modeled outcomes, not measured history.
          </p>
        </div>
        {loaderData.chargeLimits.batteries.length > 0 && (
          <a
            href={exportHref}
            download
            style={{
              padding: "0.35rem 0.75rem",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 4,
              background: "var(--color-surface)",
              fontSize: "0.875rem",
              textDecoration: "none",
              color: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            Export planner data
          </a>
        )}
      </div>

      {loaderData.chargeLimits.batteries.length === 0 ? (
        <p style={ruleStyle}>
          Add a battery with charge-limit planning in Settings to see an energy
          plan here.
        </p>
      ) : (
        <ChargePlanCard initial={loaderData.chargeLimits} />
      )}
    </main>
  );
}
