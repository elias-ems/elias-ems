import { useEffect, useState } from "react";
import type { ChargePlanPoint } from "../../lib/charge-plan";

const colors = ["var(--color-battery)", "var(--color-text)"];

export type PlanTimelineKind = "power" | "soc" | "price";

/**
 * Two stepped planning series on a shared time axis.
 *
 * The chart owns its responsive geometry and interaction, while its caller
 * supplies already-formatted times so server rendering never depends on the
 * browser's locale.
 */
export default function PlanTimeline({
  points,
  times,
  kind,
  currency,
}: {
  points: ChargePlanPoint[];
  times: Record<string, string>;
  kind: PlanTimelineKind;
  currency: string;
}) {
  const [compact, setCompact] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
    kind === "power" ? "W" : kind === "soc" ? "%" : `${currency}/kWh`;
  const left = compact ? 42 : 70;
  const plotWidth = Math.max(compact ? 278 : 780, points.length * 34);
  const width = left + plotWidth + (compact ? 12 : 30);
  const right = left + plotWidth;
  const x = (t: number) => left + ((t - from) / (to - from)) * plotWidth;
  const y = (n: number) => 105 - ((n - min) / (max - min)) * 85;
  const time = (t: number) => times[String(t)] || "";
  const clock = (t: number) => time(t).match(/\d{2}:\d{2}$/)?.[0] || time(t);
  const isTwoHourTick = (t: number) => {
    const match = clock(t).match(/^(\d{2}):(\d{2})$/);
    return match !== null && Number(match[1]) % 2 === 0 && match[2] === "00";
  };
  const value = (n: number) =>
    kind === "price" ? n.toFixed(3) : String(Math.round(n));
  const hovered = active === null ? null : points[active];
  const hoverX = hovered ? x((hovered.start + hovered.end) / 2) : 0;
  const tooltipWidth = 176;
  const tooltipX = Math.min(
    right - tooltipWidth,
    Math.max(left, hoverX - tooltipWidth / 2),
  );

  const selectAt = (clientX: number, svg: SVGSVGElement) => {
    const bounds = svg.getBoundingClientRect();
    const cursor = ((clientX - bounds.left) / bounds.width) * width;
    const timestamp = from + ((cursor - left) / plotWidth) * (to - from);
    const index = points.findIndex(
      (point) => point.start <= timestamp && timestamp < point.end,
    );
    setActive(index < 0 ? (timestamp < from ? 0 : points.length - 1) : index);
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} 190`}
        role="img"
        aria-label={`${labels.join(" and ")} over time, ${unit}`}
        style={{ width: "100%", minWidth: width, display: "block" }}
        onPointerMove={(event) => selectAt(event.clientX, event.currentTarget)}
        onPointerLeave={() => setActive(null)}
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
        {points
          .filter((point) => isTwoHourTick(point.start))
          .map((point) => (
            <g key={point.start}>
              <line
                x1={x(point.start)}
                x2={x(point.start)}
                y1={108}
                y2={113}
                stroke="var(--color-border)"
              />
              <text
                x={x((point.start + point.end) / 2)}
                y={125}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-text-muted)"
                fontFamily="var(--font-mono)"
              >
                {clock(point.start)}
              </text>
            </g>
          ))}
        <line
          x1={right}
          x2={right}
          y1={108}
          y2={113}
          stroke="var(--color-border)"
        />
        <text x={left} y={151} fontSize={11} fill="var(--color-text)">
          {compact
            ? `${labels[0]} / ${labels[1]}`
            : `${labels[0]} — solid · ${labels[1]} — dashed · ${unit}`}
        </text>

        <rect
          x={left}
          y={18}
          width={plotWidth}
          height={95}
          fill="transparent"
          style={{ cursor: "crosshair" }}
        />

        {hovered && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={18}
              y2={108}
              stroke="var(--color-text-muted)"
              strokeDasharray="3 3"
            />
            <rect
              x={tooltipX}
              y={8}
              width={tooltipWidth}
              height={61}
              rx={4}
              fill="var(--color-surface)"
              stroke="var(--color-border)"
            />
            <text
              x={tooltipX + 8}
              y={24}
              fontSize={11}
              fill="var(--color-text)"
              fontFamily="var(--font-mono)"
            >
              <tspan fontWeight="bold">{time(hovered.start)}</tspan>
              <tspan x={tooltipX + 8} dy={17}>
                {`${labels[0]}: ${value(series[0][active ?? 0])} ${unit}`}
              </tspan>
              <tspan x={tooltipX + 8} dy={16}>
                {`${labels[1]}: ${value(series[1][active ?? 0])} ${unit}`}
              </tspan>
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
