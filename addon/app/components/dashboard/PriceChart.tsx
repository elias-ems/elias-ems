/**
 * Day-ahead electricity prices (production, consumption, and market wholesale),
 * interval by interval, with the curtailment threshold drawn across it.
 *
 * Plotted in SVG with no charting dependency. Stepped lines reflect the
 * piecewise-constant interval pricing, allowing all three series to be compared
 * on a single shared time and price axis.
 *
 * Pure. Given the same props it renders the same markup on the server and in
 * the browser, which keeps hydration quiet — numbers arrive pre-bucketed in
 * minutes past local midnight.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PriceCurvePoint } from "../../lib/dashboard";
import { captionStyle } from "./chrome";

const MINUTES_PER_DAY = 1440;

export type PriceSeriesId = "production" | "consumption" | "market";
export type ChartPricePoint = PriceCurvePoint;

export const SERIES_META: Record<
  PriceSeriesId,
  { label: string; color: string; dashed?: boolean }
> = {
  production: {
    label: "Production",
    color: "var(--color-export)",
  },
  consumption: {
    label: "Consumption",
    color: "var(--color-focus)",
  },
  market: {
    label: "Market",
    color: "var(--color-chart-bar)",
    dashed: true,
  },
};

/**
 * The plot geometry, in user units.
 *
 * Two geometries rather than one scaled down: the wide chart scaled into a phone
 * width comes out at half size, which renders a 10px label at 5px. The compact one
 * draws a narrower plot so labels stay near 1:1 and thins out hour marks.
 */
type Geometry = {
  w: number;
  h: number;
  padLeft: number;
  padTop: number;
  padBottom: number;
  hours: number[];
  font: number;
  nowChip: number;
};

const WIDE: Geometry = {
  w: 640,
  h: 180,
  padLeft: 38,
  padTop: 6,
  padBottom: 26,
  hours: [0, 3, 6, 9, 12, 15, 18, 21, 24],
  font: 10,
  nowChip: 48,
};

const MIN_WIDE = 480;
const MAX_WIDE = 2000;
const DENSE_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
const PAD_RIGHT = 12;

function wideGeometry(width: number | null): Geometry {
  if (width === null) return WIDE;

  const total = Math.min(Math.max(width, MIN_WIDE), MAX_WIDE);
  const w = total - WIDE.padLeft - PAD_RIGHT;

  return {
    ...WIDE,
    w,
    hours: w >= 800 ? DENSE_HOURS : WIDE.hours,
  };
}

function useMeasuredWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

const COMPACT: Geometry = {
  w: 270,
  h: 130,
  padLeft: 40,
  padTop: 9,
  padBottom: 24,
  hours: [0, 6, 12, 18, 24],
  font: 11,
  nowChip: 44,
};

export default function PriceChart({
  curve,
  visibleSeries = { production: true, consumption: true, market: true },
  nowMinutes,
  thresholdPerKwh,
  currency,
  dayLabel,
  compact = false,
}: {
  curve: PriceCurvePoint[];
  visibleSeries?: Record<PriceSeriesId, boolean>;
  nowMinutes: number | null;
  /** Curtail below this. Highlighted when production is visible. */
  thresholdPerKwh: number | null;
  currency: string;
  dayLabel: "today" | "tomorrow";
  compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(box);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const stats = useMemo(() => {
    if (curve.length === 0) return [];
    const result: Array<{
      id: PriceSeriesId;
      label: string;
      color: string;
      min: number;
      max: number;
      avg: number;
    }> = [];

    const compute = (
      id: PriceSeriesId,
      label: string,
      color: string,
      getValue: (p: PriceCurvePoint) => number | null,
    ) => {
      const vals: number[] = [];
      for (const p of curve) {
        const v = getValue(p);
        if (v !== null) vals.push(v);
      }
      if (vals.length === 0) return;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      result.push({ id, label, color, min, max, avg });
    };

    if (visibleSeries.production) {
      compute(
        "production",
        SERIES_META.production.label,
        SERIES_META.production.color,
        (p) => p.productionPerKwh,
      );
    }
    if (visibleSeries.consumption) {
      compute(
        "consumption",
        SERIES_META.consumption.label,
        SERIES_META.consumption.color,
        (p) => p.consumptionPerKwh,
      );
    }
    if (visibleSeries.market) {
      compute(
        "market",
        SERIES_META.market.label,
        SERIES_META.market.color,
        (p) => p.marketPerKwh,
      );
    }

    return result;
  }, [curve, visibleSeries]);

  if (curve.length === 0) return null;

  const g = compact ? COMPACT : wideGeometry(measured);

  // Collect values from all currently active series to compute scale domain
  const activeValues: number[] = [];
  if (visibleSeries.production) {
    for (const p of curve) {
      if (p.productionPerKwh !== null) activeValues.push(p.productionPerKwh);
    }
  }
  if (visibleSeries.consumption) {
    for (const p of curve) {
      if (p.consumptionPerKwh !== null) activeValues.push(p.consumptionPerKwh);
    }
  }
  if (visibleSeries.market) {
    for (const p of curve) {
      if (p.marketPerKwh !== null) activeValues.push(p.marketPerKwh);
    }
  }

  const activeThreshold = visibleSeries.production ? thresholdPerKwh : null;
  const scale = buildScale(activeValues, activeThreshold, g.h);
  const baselineY = activeThreshold !== null ? scale.y(activeThreshold) : null;
  const nowX =
    nowMinutes === null ? null : (nowMinutes / MINUTES_PER_DAY) * g.w;
  const halfChip = g.nowChip / 2;

  const selectAt = (clientX: number, svg: SVGSVGElement) => {
    const bounds = svg.getBoundingClientRect();
    const totalW = g.padLeft + g.w + PAD_RIGHT;
    const plotX = ((clientX - bounds.left) / bounds.width) * totalW - g.padLeft;
    const cursorMinutes = (plotX / g.w) * MINUTES_PER_DAY;
    const index = curve.findIndex(
      (p) => p.startMinutes <= cursorMinutes && cursorMinutes < p.endMinutes,
    );
    setHoveredIndex(
      index < 0 ? (cursorMinutes < 0 ? 0 : curve.length - 1) : index,
    );
  };

  const hovered = hoveredIndex !== null ? curve[hoveredIndex] : null;
  const hoverX = hovered
    ? ((hovered.startMinutes + hovered.endMinutes) / 2 / MINUTES_PER_DAY) * g.w
    : null;
  const hoveredSlotX = hovered
    ? (hovered.startMinutes / MINUTES_PER_DAY) * g.w
    : null;
  const hoveredSlotW = hovered
    ? ((hovered.endMinutes - hovered.startMinutes) / MINUTES_PER_DAY) * g.w
    : null;

  // Prepare inspection details for the hovered interval
  const activeTooltipRows: Array<{
    id: PriceSeriesId;
    label: string;
    color: string;
    value: number;
    isBelowThreshold?: boolean;
  }> = [];

  if (visibleSeries.consumption && hovered?.consumptionPerKwh != null) {
    activeTooltipRows.push({
      id: "consumption",
      label: "Consumption",
      color: SERIES_META.consumption.color,
      value: hovered.consumptionPerKwh,
    });
  }
  if (visibleSeries.market && hovered?.marketPerKwh != null) {
    activeTooltipRows.push({
      id: "market",
      label: "Market",
      color: SERIES_META.market.color,
      value: hovered.marketPerKwh,
    });
  }
  if (visibleSeries.production && hovered?.productionPerKwh != null) {
    const isBelow =
      activeThreshold !== null && hovered.productionPerKwh < activeThreshold;
    activeTooltipRows.push({
      id: "production",
      label: "Production",
      color: isBelow ? "var(--color-import)" : SERIES_META.production.color,
      value: hovered.productionPerKwh,
      isBelowThreshold: isBelow,
    });
  }

  const tooltipWidth = compact ? 150 : 175;
  const tooltipHeight = 22 + activeTooltipRows.length * 16;
  const tooltipX =
    hoverX !== null
      ? clamp(hoverX - tooltipWidth / 2, 0, g.w - tooltipWidth)
      : 0;

  const yValues = activeTooltipRows.map((r) => scale.y(r.value));
  const minY = yValues.length > 0 ? Math.min(...yValues) : g.h / 2;
  const maxY = yValues.length > 0 ? Math.max(...yValues) : g.h / 2;
  const tooltipY =
    minY > tooltipHeight + 10
      ? minY - tooltipHeight - 6
      : Math.min(g.h - tooltipHeight - 4, maxY + 8);

  return (
    <div ref={box}>
      <svg
        viewBox={`0 0 ${g.padLeft + g.w + PAD_RIGHT} ${
          g.padTop + g.h + g.padBottom
        }`}
        width="100%"
        role="img"
        aria-label={describe(
          curve,
          visibleSeries,
          activeThreshold,
          currency,
          dayLabel,
        )}
        style={{ touchAction: "none" }}
        onPointerMove={(e) => selectAt(e.clientX, e.currentTarget)}
        onPointerDown={(e) => selectAt(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        <g transform={`translate(${g.padLeft},${g.padTop})`}>
          {/* Below-threshold curtailment band */}
          {baselineY !== null && (
            <rect
              x="0"
              y={baselineY}
              width={g.w}
              height={Math.max(0, g.h - baselineY)}
              fill="var(--color-import-soft)"
            />
          )}

          {/* Grid lines */}
          {scale.ticks.map((tick) => (
            <line
              key={tick.value}
              x1="0"
              y1={tick.y}
              x2={g.w}
              y2={tick.y}
              stroke="var(--color-border)"
            />
          ))}

          {/* Zero reference baseline */}
          {scale.inRange(0) &&
            (activeThreshold === null || activeThreshold !== 0) && (
              <line
                x1="0"
                y1={scale.y(0)}
                x2={g.w}
                y2={scale.y(0)}
                stroke="var(--color-border)"
                strokeDasharray="2 3"
                opacity="0.6"
              />
            )}

          {/* Hovered interval background */}
          {hoveredSlotX !== null && hoveredSlotW !== null && (
            <rect
              x={hoveredSlotX}
              y={0}
              width={Math.max(1, hoveredSlotW)}
              height={g.h}
              fill="var(--color-surface-active)"
              opacity="0.4"
              pointerEvents="none"
            />
          )}

          {/* Stepped price curves */}
          {visibleSeries.market && (
            <path
              d={buildSteppedPath(curve, (p) => p.marketPerKwh, scale.y, g.w)}
              fill="none"
              stroke={SERIES_META.market.color}
              strokeWidth="1.75"
              strokeDasharray="5 3"
              strokeLinejoin="round"
            />
          )}

          {visibleSeries.consumption && (
            <path
              d={buildSteppedPath(
                curve,
                (p) => p.consumptionPerKwh,
                scale.y,
                g.w,
              )}
              fill="none"
              stroke={SERIES_META.consumption.color}
              strokeWidth="2"
              strokeLinejoin="round"
            />
          )}

          {visibleSeries.production && (
            <path
              d={buildSteppedPath(
                curve,
                (p) => p.productionPerKwh,
                scale.y,
                g.w,
              )}
              fill="none"
              stroke={SERIES_META.production.color}
              strokeWidth="2"
              strokeLinejoin="round"
            />
          )}

          {/* Curtailment threshold line */}
          {baselineY !== null && (
            <line
              x1="0"
              y1={baselineY}
              x2={g.w}
              y2={baselineY}
              stroke="var(--color-import)"
              strokeWidth="1.25"
              strokeDasharray="4 3"
            />
          )}

          {/* Hover guideline, point circles, and tooltip */}
          {hovered && hoverX !== null && (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                y1="0"
                x2={hoverX}
                y2={g.h}
                stroke="var(--color-text)"
                strokeWidth="1"
                strokeDasharray="2 2"
                opacity="0.4"
              />

              {visibleSeries.consumption &&
                hovered.consumptionPerKwh !== null && (
                  <circle
                    cx={hoverX}
                    cy={scale.y(hovered.consumptionPerKwh)}
                    r="3.5"
                    fill={SERIES_META.consumption.color}
                    stroke="var(--color-surface)"
                    strokeWidth="1.5"
                  />
                )}

              {visibleSeries.market && hovered.marketPerKwh !== null && (
                <circle
                  cx={hoverX}
                  cy={scale.y(hovered.marketPerKwh)}
                  r="3"
                  fill={SERIES_META.market.color}
                  stroke="var(--color-surface)"
                  strokeWidth="1.5"
                />
              )}

              {visibleSeries.production &&
                hovered.productionPerKwh !== null && (
                  <circle
                    cx={hoverX}
                    cy={scale.y(hovered.productionPerKwh)}
                    r="3.5"
                    fill={
                      activeThreshold !== null &&
                      hovered.productionPerKwh < activeThreshold
                        ? "var(--color-import)"
                        : SERIES_META.production.color
                    }
                    stroke="var(--color-surface)"
                    strokeWidth="1.5"
                  />
                )}

              {activeTooltipRows.length > 0 && (
                <>
                  <rect
                    x={tooltipX}
                    y={tooltipY}
                    width={tooltipWidth}
                    height={tooltipHeight}
                    rx="4"
                    fill="var(--color-surface)"
                    stroke="var(--color-border)"
                    strokeWidth="1"
                    style={{
                      filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.18))",
                    }}
                  />
                  <text
                    x={tooltipX + 8}
                    y={tooltipY + 14}
                    fontSize={g.font}
                    fontWeight="600"
                    fill="var(--color-text)"
                    fontFamily="var(--font-mono)"
                  >
                    {clock(hovered.startMinutes)}–{clock(hovered.endMinutes)}
                  </text>
                  {activeTooltipRows.map((row, idx) => (
                    <g key={row.id}>
                      <circle
                        cx={tooltipX + 11}
                        cy={tooltipY + 26 + idx * 16}
                        r="3"
                        fill={row.color}
                      />
                      <text
                        x={tooltipX + 18}
                        y={tooltipY + 29 + idx * 16}
                        fontSize={g.font - 1}
                        fill="var(--color-text-muted)"
                        fontFamily="var(--font-mono)"
                      >
                        {row.label}
                      </text>
                      <text
                        x={tooltipX + tooltipWidth - 8}
                        y={tooltipY + 29 + idx * 16}
                        textAnchor="end"
                        fontSize={g.font}
                        fontWeight="600"
                        fill={
                          row.isBelowThreshold
                            ? "var(--color-import)"
                            : "var(--color-text)"
                        }
                        fontFamily="var(--font-mono)"
                      >
                        {row.value.toFixed(4)}
                      </text>
                    </g>
                  ))}
                </>
              )}
            </g>
          )}

          {/* Current slot marker */}
          {nowX !== null && (
            <>
              <line
                x1={nowX}
                y1="0"
                x2={nowX}
                y2={g.h}
                stroke="var(--color-text)"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.4"
                pointerEvents="none"
              />
              <rect
                x={clamp(nowX - halfChip, 0, g.w - g.nowChip)}
                y="3"
                width={g.nowChip}
                height="16"
                rx="3"
                fill="var(--color-text)"
                pointerEvents="none"
              />
              <text
                x={clamp(nowX, halfChip, g.w - halfChip)}
                y="14.5"
                textAnchor="middle"
                fontSize={g.font}
                fontWeight="600"
                fill="var(--color-surface)"
                fontFamily="var(--font-mono)"
                pointerEvents="none"
              >
                {clock(nowMinutes ?? 0)}
              </text>
            </>
          )}

          {/* Hour labels on X axis */}
          <g
            fontSize={g.font}
            fill="var(--color-text-muted)"
            textAnchor="middle"
            fontFamily="var(--font-mono)"
          >
            {g.hours.map((hour) => (
              <text key={hour} x={(hour / 24) * g.w} y={g.h + 16}>
                {String(hour).padStart(2, "0")}
              </text>
            ))}
          </g>
        </g>

        {/* Y axis price tick labels */}
        <g
          fontSize={g.font}
          fill="var(--color-text-muted)"
          textAnchor="end"
          fontFamily="var(--font-mono)"
        >
          {scale.ticks.map((tick) => (
            <text
              key={tick.value}
              x={g.padLeft - 6}
              y={g.padTop + tick.y + 4}
              fill={
                activeThreshold !== null && tick.value === activeThreshold
                  ? "var(--color-import)"
                  : "var(--color-text-muted)"
              }
            >
              {tick.label}
            </text>
          ))}
        </g>
      </svg>

      {/* Threshold and now legends */}
      {(activeThreshold !== null || nowMinutes !== null) && (
        <div
          style={{
            ...captionStyle,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.25rem 0.875rem",
            marginTop: "0.375rem",
          }}
        >
          {activeThreshold !== null && (
            <span>
              <Swatch
                color="var(--color-import-soft)"
                border="var(--color-import)"
              />
              below threshold ({activeThreshold.toFixed(4)} {currency})
            </span>
          )}
          {nowMinutes !== null && (
            <span>
              <Swatch color="var(--color-chart-bar-now)" />
              current slot
            </span>
          )}
          <span style={{ marginLeft: "auto" }}>{currency}/kWh</span>
        </div>
      )}

      {/* Min / Max / Avg stats */}
      {stats.length > 0 && (
        <div
          style={{
            ...captionStyle,
            display: "flex",
            flexWrap: "wrap",
            gap: "0.25rem 0.875rem",
            marginTop: "0.25rem",
            color: "var(--color-text-muted)",
            fontSize: "0.6875rem",
          }}
        >
          {stats.map((s) => (
            <span key={s.id}>
              <Swatch color={s.color} dashed={s.id === "market"} />
              <span style={{ color: "var(--color-text)", fontWeight: 500 }}>
                {s.label}
              </span>
              : min <strong>{s.min.toFixed(4)}</strong> · max{" "}
              <strong>{s.max.toFixed(4)}</strong> · avg{" "}
              <strong>{s.avg.toFixed(4)}</strong>
            </span>
          ))}
          {activeThreshold === null && nowMinutes === null && (
            <span style={{ marginLeft: "auto" }}>{currency}/kWh</span>
          )}
        </div>
      )}
    </div>
  );
}

function Swatch({
  color,
  border,
  dashed,
}: {
  color: string;
  border?: string;
  dashed?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: dashed ? 3 : 8,
        borderRadius: dashed ? 1 : 2,
        marginRight: 5,
        verticalAlign: dashed ? 2 : -1,
        background: color,
        border: border ? `1px dashed ${border}` : undefined,
      }}
    />
  );
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type Scale = {
  y: (value: number) => number;
  ticks: Array<{ value: number; y: number; label: string }>;
  inRange: (value: number) => boolean;
};

function buildScale(
  values: number[],
  threshold: number | null,
  h: number,
): Scale {
  const all = threshold !== null ? [...values, threshold] : [...values];
  if (all.length === 0) all.push(0);

  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(hi - lo, 0.01);
  const step = niceStep(span);

  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const y = (value: number) => ((max - value) / (max - min)) * h;
  const inRange = (value: number) => value >= min && value <= max;

  const ticks: Scale["ticks"] = [];
  for (let i = 0; min + i * step <= max + step / 2; i++) {
    const value = round(min + i * step);
    ticks.push({ value, y: y(value), label: value.toFixed(2) });
  }

  if (threshold !== null && !ticks.some((tick) => tick.value === threshold)) {
    ticks.push({
      value: threshold,
      y: y(threshold),
      label: threshold.toFixed(2),
    });
  }

  return { y, ticks, inRange };
}

function niceStep(span: number): number {
  const steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  return steps.find((step) => span / step <= 6) ?? steps[steps.length - 1];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function buildSteppedPath(
  curve: PriceCurvePoint[],
  getValue: (p: PriceCurvePoint) => number | null,
  scaleY: (v: number) => number,
  plotW: number,
): string {
  let path = "";
  let inSegment = false;
  for (const p of curve) {
    const val = getValue(p);
    if (val === null) {
      inSegment = false;
      continue;
    }
    const xStart = (p.startMinutes / MINUTES_PER_DAY) * plotW;
    const xEnd = (p.endMinutes / MINUTES_PER_DAY) * plotW;
    const y = scaleY(val);
    if (!inSegment) {
      path += `M ${xStart.toFixed(1)} ${y.toFixed(1)} H ${xEnd.toFixed(1)} `;
      inSegment = true;
    } else {
      path += `L ${xStart.toFixed(1)} ${y.toFixed(1)} H ${xEnd.toFixed(1)} `;
    }
  }
  return path.trim();
}

function describe(
  curve: PriceCurvePoint[],
  visibleSeries: Record<PriceSeriesId, boolean>,
  threshold: number | null,
  currency: string,
  dayLabel: "today" | "tomorrow",
): string {
  const activeLabels = (Object.keys(visibleSeries) as PriceSeriesId[])
    .filter((id) => visibleSeries[id])
    .map((id) => SERIES_META[id].label);

  if (activeLabels.length === 0) {
    return `No price series selected for ${dayLabel}.`;
  }

  return `Electricity price curves (${activeLabels.join(", ")}) by interval ${dayLabel}, in ${currency}/kWh${
    threshold !== null
      ? `, against a curtailment threshold of ${threshold.toFixed(4)} ${currency}/kWh.`
      : "."
  } Total ${curve.length} intervals.`;
}
