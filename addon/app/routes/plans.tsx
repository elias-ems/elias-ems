import ChargePlanCard from "../components/dashboard/ChargePlanCard";
import { ruleStyle } from "../components/dashboard/chrome";
import { readChargeLimits } from "../lib/charge-limit-loop.server";
import type { Route } from "./+types/plans";

export async function loader() {
  return { chargeLimits: await readChargeLimits() };
}

export default function Plans({ loaderData }: Route.ComponentProps) {
  return (
    <main className="page dash">
      <div>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Energy plans</h1>
        <p style={{ ...ruleStyle, marginTop: "0.35rem", maxWidth: "68ch" }}>
          Forecast demand, solar, battery behaviour and PV curtailment on one
          timeline. These are modeled outcomes, not measured history.
        </p>
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
