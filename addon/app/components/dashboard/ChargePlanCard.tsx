import { useEffect, useState } from "react";
import type {
  ChargeLimitStatus,
  ChargeLimitsData,
} from "../../lib/charge-limit-status";
import { usePolledJson } from "../../lib/json-fetch";
import { hintStyle } from "../form";
import { cardStyle, eyebrowStyle, monoStyle } from "./chrome";
import PlanTimeline from "./PlanTimeline";

function BatteryPlan({
  status,
  now,
}: {
  status: ChargeLimitStatus;
  now: number;
}) {
  const first = status.plan?.points[0];
  const expired = status.validUntil !== null && now > status.validUntil;
  const next = status.plan?.points.find((p) => p.limitW !== first?.limitW);
  const stamp = (t: number) => status.times[String(t)] || "";
  return (
    <section
      style={{
        ...cardStyle,
        padding: "1.25rem",
        display: "grid",
        gap: "0.8rem",
      }}
    >
      <h2 style={eyebrowStyle}>
        Battery plan · {status.title} ·{" "}
        {expired ? "Awaiting update" : status.state}
      </h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1.5rem",
          alignItems: "baseline",
        }}
      >
        <strong style={{ ...monoStyle, fontSize: "2rem" }}>
          {first ? `${Math.round(first.limitW)} W` : "—"}
        </strong>
        <span style={hintStyle}>
          Recommended charge ceiling{expired ? " (previous plan)" : ""}
        </span>
        <span style={hintStyle}>
          Reported:{" "}
          {status.reportedW === null ? "unavailable" : `${status.reportedW} W`}
        </span>
        {status.requestedW !== null && (
          <span style={hintStyle}>Requested: {status.requestedW} W</span>
        )}
      </div>
      <p style={{ ...hintStyle, margin: 0 }}>{status.message}</p>
      {status.checks && (
        <details>
          <summary>Planning inputs</summary>
          <ul>
            {Object.entries(status.checks).map(([key, value]) => (
              <li key={key}>
                {key}: {value}
              </li>
            ))}
          </ul>
        </details>
      )}
      {status.mode === "preview" && (
        <p style={hintStyle}>
          Preview only — the battery's settings are unchanged.
        </p>
      )}
      {status.plan && (
        <>
          <p style={hintStyle}>
            {next
              ? `Next change: ${next.limitW} W at ${stamp(next.start)}.`
              : "No further limit change within this plan."}{" "}
            {status.calculatedAt !== null &&
              `Calculated ${stamp(status.calculatedAt)}.`}
          </p>
          {(["power", "soc", "price"] as const).map((kind) => (
            <PlanTimeline
              key={kind}
              points={status.plan?.points || []}
              times={status.times}
              kind={kind}
              currency={status.currency}
            />
          ))}
          <p style={hintStyle}>
            Modeled cost difference versus unrestricted self-consumption:{" "}
            <strong>
              {(status.plan.baselineCost - status.plan.cost).toFixed(2)}{" "}
              {status.currency}
            </strong>{" "}
            within published prices. This is a forecast, not measured savings;
            the two plans can end with different stored energy.
          </p>
          <p style={hintStyle}>
            {status.sources} Energy dashboard forecast source
            {status.sources === 1 ? "" : "s"} · {status.historyHours} complete
            hours of consumption history · solar reduced by{" "}
            {status.solarMarginPercent}% for planning.{" "}
            {status.forecastEnd !== null &&
              `Solar coverage ends ${stamp(status.forecastEnd)}.`}{" "}
            Energy valued beyond the price horizon:{" "}
            {status.plan.terminalReserveKwh.toFixed(2)} kWh above the native
            reserve.
          </p>
          <details>
            <summary style={{ cursor: "pointer" }}>
              Forecast and schedule details · {status.plan.points.length}{" "}
              intervals
            </summary>
            <div
              style={{
                marginTop: "0.75rem",
                maxHeight: "clamp(16rem, 52vh, 36rem)",
                overflow: "auto",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
              }}
            >
              <table
                style={{
                  width: "100%",
                  fontSize: "0.8rem",
                  textAlign: "right",
                  borderCollapse: "collapse",
                }}
              >
                <caption style={hintStyle}>
                  SoC is at the end of each interval. Solar includes the
                  configured margin.
                </caption>
                <thead>
                  <tr>
                    {[
                      "Time",
                      "Ceiling W",
                      "Charge W",
                      "Solar W",
                      "Load W",
                      "SoC %",
                    ].map((label) => (
                      <th
                        key={label}
                        style={{
                          position: "sticky",
                          top: 0,
                          zIndex: 1,
                          padding: "0.5rem 0.4rem",
                          background: "var(--color-surface)",
                          borderBottom: "1px solid var(--color-border)",
                        }}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {status.plan.points.map((p) => (
                    <tr key={p.start}>
                      <td style={{ whiteSpace: "nowrap", padding: "0.4rem" }}>
                        {stamp(p.start)}
                      </td>
                      {[p.limitW, p.chargeW, p.solarW, p.loadW, p.soc].map(
                        (value, i) => (
                          <td
                            key={
                              ["ceiling", "charge", "solar", "load", "soc"][i]
                            }
                            style={{
                              padding: "0.4rem",
                              borderTop: "1px solid var(--color-border)",
                            }}
                          >
                            {Math.round(value)}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export default function ChargePlanCard({
  initial,
}: {
  initial: ChargeLimitsData;
}) {
  const { data, failing } = usePolledJson<ChargeLimitsData>(
    "/api/charge-limits",
    {
      enabled: initial.batteries.length > 0,
      intervalMs: 30_000,
      leading: false,
    },
  );
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {failing && (
        <p style={hintStyle}>
          Battery plan updates are unavailable; showing the last received plan.
        </p>
      )}
      {(data || initial).batteries.map((status) => (
        <BatteryPlan key={status.batteryId} status={status} now={now} />
      ))}
    </>
  );
}
