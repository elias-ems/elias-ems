import { useEffect, useState } from "react";
import type { ChargePlanPoint } from "../../lib/charge-plan";
import { hintStyle } from "../form";

/** A time-linked picture of the modeled power balance, not a live meter. */
export default function PlanPowerFlow({
  points,
  times,
}: {
  points: ChargePlanPoint[];
  times: Record<string, string>;
}) {
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing || points.length < 2) return;
    const timer = window.setInterval(
      () => setSelected((current) => (current + 1) % points.length),
      900,
    );
    return () => window.clearInterval(timer);
  }, [playing, points.length]);

  if (!points.length) return null;

  const index = Math.min(selected, points.length - 1);
  const point = points[index];
  const solar = Math.max(0, point.generatedSolarW ?? point.solarW);
  const demand = Math.max(0, point.loadW);
  const charging = Math.max(0, point.chargeW);
  const discharging = Math.max(0, point.dischargeW);
  const grid = demand + charging - solar - discharging;
  const watts = (value: number) =>
    `${Math.round(value).toLocaleString("en-US")} W`;
  const stamp = (time: number) => times[String(time)] || "";

  const from = points[0].start;
  const to = points[points.length - 1].end;
  const left = 52;
  const right = 810;
  const top = 24;
  const bottom = 226;
  const x = (time: number) =>
    left + ((time - from) / (to - from)) * (right - left);
  const max = Math.max(
    1,
    ...points.map((p) =>
      Math.max(p.loadW, p.generatedSolarW ?? p.solarW, p.chargeW),
    ),
  );
  const ceiling = Math.ceil(max / 1000) * 1000 || 1000;
  const y = (value: number) => bottom - (value / ceiling) * (bottom - top);
  const path = (value: (p: ChargePlanPoint) => number, area = false) => {
    const steps = points
      .map(
        (p, i) => `${i ? "L" : "M"}${x(p.start)},${y(value(p))} H${x(p.end)}`,
      )
      .join(" ");
    return area ? `${steps} L${right},${bottom} L${left},${bottom} Z` : steps;
  };
  const selectedX = x((point.start + point.end) / 2);

  return (
    <section
      aria-label="Forecast power flow"
      style={{
        display: "grid",
        gap: "0.85rem",
        padding: "0.8rem",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
      }}
    >
      <div>
        <strong>Forecast power flow</strong>
        <p style={{ ...hintStyle, margin: "0.25rem 0 0" }}>
          Modeled power for each interval. Select a time to follow demand,
          solar, and battery charging through the plan.
        </p>
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox="0 0 830 150"
          role="img"
          aria-label={`At ${stamp(point.start)}: solar ${watts(solar)}, household demand ${watts(demand)}, battery charging ${watts(charging)}, battery discharging ${watts(discharging)}, grid ${grid >= 0 ? "import" : "export"} ${watts(Math.abs(grid))}`}
          style={{ display: "block", width: "100%", minWidth: 650 }}
        >
          <title>Modeled power balance at {stamp(point.start)}</title>
          <line
            x1="88"
            x2="742"
            y1="75"
            y2="75"
            stroke="var(--color-border-strong)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          {[
            {
              x: 105,
              label: "Solar",
              value: watts(solar),
              color: "var(--color-pv)",
              arrow: solar > 0 ? "↓" : "·",
            },
            {
              x: 312,
              label: "Grid",
              value: `${grid >= 0 ? "Import" : "Export"} ${watts(Math.abs(grid))}`,
              color: grid >= 0 ? "var(--color-import)" : "var(--color-export)",
              arrow: Math.abs(grid) > 0.5 ? (grid >= 0 ? "↓" : "↑") : "·",
            },
            {
              x: 520,
              label: "Battery",
              value:
                charging > 0
                  ? `Charging ${watts(charging)}`
                  : discharging > 0
                    ? `Discharging ${watts(discharging)}`
                    : "Idle",
              color: "var(--color-battery)",
              arrow: charging > 0 ? "↑" : discharging > 0 ? "↓" : "·",
            },
            {
              x: 725,
              label: "Home",
              value: watts(demand),
              color: "var(--color-text)",
              arrow: demand > 0 ? "↓" : "·",
            },
          ].map((node) => (
            <g key={node.label}>
              <line
                x1={node.x}
                x2={node.x}
                y1={node.label === "Home" ? 75 : 55}
                y2={node.label === "Home" ? 107 : 75}
                stroke={node.color}
                strokeWidth="3"
              />
              <circle cx={node.x} cy="75" r="6" fill={node.color} />
              <text
                x={node.x}
                y="33"
                textAnchor="middle"
                fontSize="13"
                fontWeight="bold"
                fill="var(--color-text)"
              >
                {node.label}
              </text>
              <text
                x={node.x}
                y="51"
                textAnchor="middle"
                fontSize="12"
                fill={node.color}
              >
                {node.value}
              </text>
              <text
                x={node.x}
                y={node.label === "Home" ? 130 : 68}
                textAnchor="middle"
                fontSize="23"
                fontWeight="bold"
                fill={node.color}
              >
                {node.arrow}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg
          viewBox="0 0 830 280"
          role="img"
          aria-label="Forecast household demand, generated solar, and battery charging over time. Use the time slider to select an interval."
          style={{ display: "block", width: "100%", minWidth: 650 }}
        >
          <title>Demand, solar and charging forecast</title>
          {[0, ceiling / 2, ceiling].map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--color-border)"
              />
              <text
                x={left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                fontSize="11"
                fill="var(--color-text-muted)"
              >
                {Math.round(tick).toLocaleString("en-US")}
              </text>
            </g>
          ))}
          <path
            d={path((p) => Math.max(0, p.loadW), true)}
            fill="var(--color-import-soft)"
          />
          <path
            d={path((p) => Math.max(0, p.generatedSolarW ?? p.solarW), true)}
            fill="var(--color-pv-soft)"
          />
          <path
            d={path((p) => Math.max(0, p.chargeW), true)}
            fill="var(--color-battery-soft)"
          />
          {[
            {
              label: "Demand",
              value: (p: ChargePlanPoint) => Math.max(0, p.loadW),
              color: "var(--color-import)",
            },
            {
              label: "Solar",
              value: (p: ChargePlanPoint) =>
                Math.max(0, p.generatedSolarW ?? p.solarW),
              color: "var(--color-pv)",
            },
            {
              label: "Charging",
              value: (p: ChargePlanPoint) => Math.max(0, p.chargeW),
              color: "var(--color-battery)",
            },
          ].map((series) => (
            <path
              key={series.label}
              d={path(series.value)}
              fill="none"
              stroke={series.color}
              strokeWidth="2.5"
            />
          ))}
          <line
            x1={selectedX}
            x2={selectedX}
            y1={top}
            y2={bottom}
            stroke="var(--color-text)"
            strokeDasharray="4 4"
          />
          <text x={left} y="249" fontSize="11" fill="var(--color-text-muted)">
            {stamp(from)}
          </text>
          <text
            x={right}
            y="249"
            textAnchor="end"
            fontSize="11"
            fill="var(--color-text-muted)"
          >
            {stamp(to)}
          </text>
          <text x={left} y="271" fontSize="11" fill="var(--color-text-muted)">
            Power (W)
          </text>
        </svg>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          fontSize: "0.8rem",
        }}
      >
        {[
          ["Demand", "var(--color-import)"],
          ["Generated solar", "var(--color-pv)"],
          ["Battery charging", "var(--color-battery)"],
        ].map(([label, color]) => (
          <span
            key={label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 14, borderTop: `3px solid ${color}` }}
            />
            {label}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <button
          type="button"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? "Pause forecast" : "Play forecast"}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={points.length - 1}
          value={index}
          onChange={(event) => {
            setSelected(Number(event.target.value));
            setPlaying(false);
          }}
          aria-label="Forecast interval"
          style={{ flex: 1, minWidth: 120 }}
        />
        <span style={{ ...hintStyle, whiteSpace: "nowrap" }}>
          {stamp(point.start)}
        </span>
      </div>
      <p style={{ ...hintStyle, margin: 0 }}>
        Grid power is the balance of these forecasts and expected battery
        discharge; positive means import. Charging is expected battery power,
        not the charge ceiling.
      </p>
    </section>
  );
}
