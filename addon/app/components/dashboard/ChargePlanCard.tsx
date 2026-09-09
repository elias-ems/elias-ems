import { useEffect, useState } from "react";
import type {
  ChargeLimitStatus,
  ChargeLimitsData,
} from "../../lib/charge-limit-status";
import { usePolledJson } from "../../lib/json-fetch";
import { hintStyle } from "../form";
import { cardStyle, eyebrowStyle, monoStyle } from "./chrome";

const colors = ["var(--color-battery)", "var(--color-text)"];

function Timeline({
  status,
  kind,
}: {
  status: ChargeLimitStatus;
  kind: "power" | "soc" | "price";
}) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const points = status.plan?.points || [];
  if (!points.length) return null;
  const from = points[0].start;
  const to = points[points.length - 1].end;
  const series =
    kind === "power"
      ? [points.map((p) => p.limitW), points.map((p) => p.chargeW)]
      : kind === "soc"
        ? [points.map((p) => p.soc), points.map((p) => p.baselineSoc)]
        : [points.map((p) => p.buy), points.map((p) => p.sell)];
  const labels =
    kind === "power"
      ? ["Charge ceiling", "Expected charging"]
      : kind === "soc"
        ? ["Planned SoC", "Unrestricted SoC"]
        : ["Purchase price", "Export price"];
  const max = kind === "soc" ? 100 : Math.max(0.01, ...series.flat());
  const min = Math.min(0, ...series.flat());
  const unit =
    kind === "power" ? "W" : kind === "soc" ? "%" : `${status.currency}/kWh`;
  const width = compact ? 320 : 900;
  const left = compact ? 42 : 70;
  const right = width - (compact ? 12 : 50);
  const x = (t: number) => left + ((t - from) / (to - from)) * (right - left);
  const y = (n: number) => 105 - ((n - min) / (max - min)) * 85;
  const time = (t: number) => status.times[String(t)] || "";
  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} 155`}
        role="img"
        aria-label={`${labels.join(" and ")} over time, ${unit}`}
        style={{ width: "100%", display: "block" }}
      >
        <title>{`${labels.join(" and ")} (${unit})`}</title>
        {compact && (
          <text x={left} y={12} fontSize={10} fill="var(--color-text-muted)">
            {unit}
          </text>
        )}
        {[min, (min + max) / 2, max].map((v) => (
          <g key={v}>
            <line
              x1={left}
              x2={right}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--color-border)"
            />
            <text
              x={left - 8}
              y={y(v) + 4}
              textAnchor="end"
              fill="var(--color-text-muted)"
              fontSize={11}
            >
              {kind === "price" ? v.toFixed(2) : Math.round(v)}
            </text>
          </g>
        ))}
        {series.map((values, j) => (
          <path
            key={labels[j]}
            d={points
              .map(
                (p, i) =>
                  `${i ? "L" : "M"}${x(p.start)},${y(values[i])} H${x(p.end)}`,
              )
              .join(" ")}
            fill="none"
            stroke={colors[j]}
            strokeWidth={2}
            strokeDasharray={j ? "5 4" : undefined}
          />
        ))}
        {(compact ? [0, 1] : [0, 0.5, 1]).map((f) => (
          <text
            key={f}
            x={left + f * (right - left)}
            y={124}
            textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
            fontSize={11}
            fill="var(--color-text-muted)"
          >
            {time(from + f * (to - from))}
          </text>
        ))}
        <text x={left} y={147} fontSize={11} fill="var(--color-text)">
          {compact
            ? `${labels[0]} / ${labels[1]}`
            : `${labels[0]} — solid · ${labels[1]} — dashed · ${unit}`}
        </text>
      </svg>
    </div>
  );
}

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
          <Timeline status={status} kind="power" />
          <Timeline status={status} kind="soc" />
          <Timeline status={status} kind="price" />
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
              Forecast and schedule details
            </summary>
            <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
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
                      <th key={label} style={{ padding: "0.4rem" }}>
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
