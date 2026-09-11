/**
 * Today's selling price, hour by hour, with the curtailment threshold drawn
 * across it.
 *
 * The threshold line is the point of the chart. Everything below it is an hour
 * where putting a kWh on the grid costs money, which is exactly when curtailment
 * holds the arrays back — so the shaded band is not decoration, it is the rule
 * the strategy underneath is following, drawn.
 *
 * Plotted in SVG with no library: it is two dozen rectangles and five labels,
 * and a charting dependency would be a build-size and upgrade cost for that.
 *
 * Pure. Given the same props it renders the same markup on the server and in
 * the browser, which is what keeps hydration quiet — the numbers arrive already
 * bucketed and already expressed as minutes past local midnight, so nothing
 * here asks what time it is or where the reader lives.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PriceCurvePoint } from "../../lib/dashboard";
import { captionStyle } from "./chrome";

const MINUTES_PER_DAY = 1440;

/**
 * The plot geometry, in user units.
 *
 * Two of them rather than one scaled down, because an SVG scales its labels
 * along with its plot: the wide chart rendered into a phone-width column comes
 * out at half size, which puts a 10px axis label at five pixels tall. The
 * compact one draws a narrower plot so it renders at close to 1:1 in that
 * space, and thins the hour labels out to match the room they then have.
 *
 * `w`/`h` are the plot area; the viewBox adds the gutters around it.
 */
type Geometry = {
  w: number;
  h: number;
  /** Room for the y labels on the left, and the hour labels underneath. */
  padLeft: number;
  padTop: number;
  padBottom: number;
  /** Which hours the axis names. */
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

/**
 * How wide the plot is allowed to get, in user units — which are CSS pixels,
 * because the chart is drawn at whatever width it is given rather than scaled
 * into it (see `useMeasuredWidth`).
 *
 * The floor is where the wide plot stops being readable and the compact one
 * takes over anyway. The ceiling is a guard rather than a target: past it the
 * chart goes back to being scaled up, which on a panel that wide is a fraction
 * of a percent and much better than the alternative — a hard cap leaves the
 * card two thirds chart and one third nothing.
 */
const MIN_WIDE = 480;
const MAX_WIDE = 2000;

/** Once there is room, the axis names every second hour instead of every third. */
const DENSE_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];

/** The gutter to the right of the plot. */
const PAD_RIGHT = 12;

/**
 * The wide plot, redrawn for the width it actually has.
 */
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

/**
 * The element's own width, once there is a browser to ask.
 *
 * `null` until then — on the server, and on the client's first render, which
 * is what keeps hydration quiet: both produce the default geometry, and the
 * measured one only arrives in an effect afterwards.
 */
function useMeasuredWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      // Rounded, so a fractional layout width does not rewrite the whole
      // viewBox on every scrollbar-sized reflow.
      setWidth(Math.round(entry.contentRect.width));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * Sized so that the whole viewBox — 322 units — lands at roughly the 300 css px
 * a phone card has to spare, which puts this chart at about 1:1 and its labels
 * at their nominal size. The gutter is 40 rather than 38 because an 11-unit
 * font needs the extra two for `-0.05`.
 */
const COMPACT: Geometry = {
  w: 270,
  h: 130,
  padLeft: 40,
  // The top gridline's label is drawn against this: its ascender rises about
  // one em above the baseline, so the gutter has to clear the font size.
  padTop: 9,
  padBottom: 24,
  hours: [0, 6, 12, 18, 24],
  font: 11,
  nowChip: 44,
};

export default function PriceChart({
  curve,
  nowMinutes,
  thresholdPerKwh,
  currency,
  compact = false,
}: {
  curve: PriceCurvePoint[];
  nowMinutes: number | null;
  /** Curtail below this. The line, and the top of the shaded band. */
  thresholdPerKwh: number;
  currency: string;
  /** The narrower plot, for a column a phone can spare. */
  compact?: boolean;
}) {
  // Both hooks run before the empty-curve exit below, as they must: a
  // component cannot call fewer of them on one render than on another.
  const box = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(box);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const stats = useMemo(() => {
    if (curve.length === 0) return null;
    let minPoint = curve[0];
    let maxPoint = curve[0];
    let sum = 0;
    for (const p of curve) {
      if (p.sellingPerKwh < minPoint.sellingPerKwh) minPoint = p;
      if (p.sellingPerKwh > maxPoint.sellingPerKwh) maxPoint = p;
      sum += p.sellingPerKwh;
    }
    return {
      minPoint,
      maxPoint,
      avg: sum / curve.length,
    };
  }, [curve]);

  if (curve.length === 0) return null;

  const g = compact ? COMPACT : wideGeometry(measured);
  const values = curve.map((point) => point.sellingPerKwh);
  const scale = buildScale(values, thresholdPerKwh, g.h);
  const thresholdY = scale.y(thresholdPerKwh);
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

  const tooltipWidth = compact ? 130 : 155;
  const tooltipHeight = 42;
  const tooltipX =
    hoverX !== null
      ? clamp(hoverX - tooltipWidth / 2, 0, g.w - tooltipWidth)
      : 0;
  const hoverY = hovered ? scale.y(hovered.sellingPerKwh) : 0;
  const tooltipY =
    hoverY > 52
      ? hoverY - tooltipHeight - 6
      : Math.min(g.h - tooltipHeight - 4, hoverY + 8);

  return (
    // The wrapper is what gets measured, not the svg: the svg's width is
    // `100%` of exactly this box, so asking it would be asking the answer to
    // describe itself.
    <div ref={box}>
      <svg
        viewBox={`0 0 ${g.padLeft + g.w + PAD_RIGHT} ${
          g.padTop + g.h + g.padBottom
        }`}
        width="100%"
        role="img"
        aria-label={describe(curve, thresholdPerKwh, currency)}
        style={{ touchAction: "none" }}
        onPointerMove={(e) => selectAt(e.clientX, e.currentTarget)}
        onPointerDown={(e) => selectAt(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        <g transform={`translate(${g.padLeft},${g.padTop})`}>
          {/* Everything under the threshold: the intervals exporting costs money. */}
          <rect
            x="0"
            y={thresholdY}
            width={g.w}
            height={Math.max(0, g.h - thresholdY)}
            fill="var(--color-import-soft)"
          />

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

          {/* Subtle neutral zero baseline if 0 is in scale and threshold is non-zero */}
          {thresholdPerKwh !== 0 && scale.inRange(0) && (
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

          {curve.map((point, index) => {
            const duration = Math.max(1, point.endMinutes - point.startMinutes);
            const slotWidth = (duration / MINUTES_PER_DAY) * g.w;
            const x = (point.startMinutes / MINUTES_PER_DAY) * g.w;
            const gap = slotWidth > 15 ? 2.5 : slotWidth > 5 ? 1 : 0.5;
            const barWidth = Math.max(1, slotWidth - gap);
            const barX = x + (slotWidth - barWidth) / 2;
            const top = scale.y(point.sellingPerKwh);
            const below = point.sellingPerKwh < thresholdPerKwh;
            const isNow =
              nowMinutes !== null &&
              point.startMinutes <= nowMinutes &&
              nowMinutes < point.endMinutes;
            const isHovered = hoveredIndex === index;

            const fill = isNow
              ? below
                ? "var(--color-import-now)"
                : "var(--color-chart-bar-now)"
              : below
                ? "var(--color-import)"
                : "var(--color-chart-bar)";

            return (
              <rect
                key={point.startMinutes}
                x={barX}
                y={Math.min(top, thresholdY)}
                width={barWidth}
                // A price sitting exactly on the threshold still gets a mark,
                // so an interval never silently disappears from the row.
                height={Math.max(1.5, Math.abs(top - thresholdY))}
                rx={Math.min(1.5, Math.max(0.5, barWidth / 4))}
                fill={fill}
                opacity={
                  hoveredIndex !== null && !isHovered && !isNow ? 0.75 : 1
                }
                stroke={isHovered ? "var(--color-text)" : undefined}
                strokeWidth={isHovered ? 1 : 0}
              >
                <title>
                  {`${clock(point.startMinutes)}–${clock(point.endMinutes)}: ${point.sellingPerKwh.toFixed(4)} ${currency}/kWh (${
                    below ? "below threshold" : "above threshold"
                  })`}
                </title>
              </rect>
            );
          })}

          {/* Drawn over the bars: it is the line they are measured against. */}
          <line
            x1="0"
            y1={thresholdY}
            x2={g.w}
            y2={thresholdY}
            stroke="var(--color-import)"
            strokeWidth="1.25"
            strokeDasharray="4 3"
          />

          {/* Hover guideline and floating inspection chip */}
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
                opacity="0.35"
              />
              <rect
                x={tooltipX}
                y={tooltipY}
                width={tooltipWidth}
                height={tooltipHeight}
                rx="4"
                fill="var(--color-surface)"
                stroke="var(--color-border)"
                strokeWidth="1"
                style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.18))" }}
              />
              <text
                x={tooltipX + 8}
                y={tooltipY + 15}
                fontSize={g.font}
                fontWeight="600"
                fill="var(--color-text)"
                fontFamily="var(--font-mono)"
              >
                {clock(hovered.startMinutes)}–{clock(hovered.endMinutes)}
              </text>
              <text
                x={tooltipX + 8}
                y={tooltipY + 31}
                fontSize={g.font}
                fontWeight="600"
                fill={
                  hovered.sellingPerKwh < thresholdPerKwh
                    ? "var(--color-import)"
                    : "var(--color-text)"
                }
                fontFamily="var(--font-mono)"
              >
                {hovered.sellingPerKwh.toFixed(4)} {currency}
                <tspan
                  fill="var(--color-text-muted)"
                  fontWeight="normal"
                  fontSize={g.font - 1}
                  dx={5}
                >
                  {hovered.sellingPerKwh < thresholdPerKwh ? "below" : "above"}
                </tspan>
              </text>
            </g>
          )}

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
                // The canvas colour, so the chip's label inverts with the theme
                // exactly as its background does.
                fill="var(--color-surface)"
                fontFamily="var(--font-mono)"
                pointerEvents="none"
              >
                {clock(nowMinutes ?? 0)}
              </text>
            </>
          )}

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
                tick.value === thresholdPerKwh
                  ? "var(--color-import)"
                  : "var(--color-text-muted)"
              }
            >
              {tick.label}
            </text>
          ))}
        </g>
      </svg>

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
        <span>
          <Swatch color="var(--color-import)" />
          below threshold
        </span>
        <span>
          <Swatch color="var(--color-chart-bar)" />
          above threshold
        </span>
        {nowMinutes !== null && (
          <span>
            <Swatch color="var(--color-chart-bar-now)" />
            current slot
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          {currency}/kWh after contract
        </span>
      </div>

      {stats && (
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
          <span>
            Min:{" "}
            <strong style={{ color: "var(--color-text)" }}>
              {stats.minPoint.sellingPerKwh.toFixed(4)}
            </strong>{" "}
            ({clock(stats.minPoint.startMinutes)}–
            {clock(stats.minPoint.endMinutes)})
          </span>
          <span>
            Max:{" "}
            <strong style={{ color: "var(--color-text)" }}>
              {stats.maxPoint.sellingPerKwh.toFixed(4)}
            </strong>{" "}
            ({clock(stats.maxPoint.startMinutes)}–
            {clock(stats.maxPoint.endMinutes)})
          </span>
          <span>
            Avg:{" "}
            <strong style={{ color: "var(--color-text)" }}>
              {stats.avg.toFixed(4)}
            </strong>{" "}
            {currency}/kWh
          </span>
        </div>
      )}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: 2,
        marginRight: 5,
        verticalAlign: -1,
        background: color,
      }}
    />
  );
}

/** `795` → `13:15`, without asking the browser what a time looks like. */
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

/**
 * The y axis: a domain wide enough for the data *and* the threshold, and a set
 * of round gridlines across it.
 *
 * The threshold has to be inside the domain even when no interval comes near it —
 * a chart that cropped the line out would show a day of prices with nothing to
 * compare them to, which is the one thing this chart exists to do.
 */
function buildScale(values: number[], threshold: number, h: number): Scale {
  const lo = Math.min(...values, threshold);
  const hi = Math.max(...values, threshold);
  // A flat day would otherwise divide by zero and put every bar on the axis.
  const span = Math.max(hi - lo, 0.01);
  const step = niceStep(span);

  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const y = (value: number) => ((max - value) / (max - min)) * h;
  const inRange = (value: number) => value >= min && value <= max;

  const ticks: Scale["ticks"] = [];
  // Multiplied out from an integer count rather than accumulated, so that a
  // step of 0.05 does not drift into 0.15000000000000002 by the fourth line.
  for (let i = 0; min + i * step <= max + step / 2; i++) {
    const value = round(min + i * step);
    ticks.push({ value, y: y(value), label: value.toFixed(2) });
  }

  // The threshold gets its own line whenever it is not already on one, so the
  // number the shading is about is always labelled.
  if (!ticks.some((tick) => tick.value === threshold)) {
    ticks.push({
      value: threshold,
      y: y(threshold),
      label: threshold.toFixed(2),
    });
  }

  return { y, ticks, inRange };
}

/** The roundest step that puts four to eight gridlines across the span. */
function niceStep(span: number): number {
  const steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  return steps.find((step) => span / step <= 6) ?? steps[steps.length - 1];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Kills the float noise a multiplied step leaves behind. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function describe(
  curve: PriceCurvePoint[],
  threshold: number,
  currency: string,
): string {
  const below = curve.filter((point) => point.sellingPerKwh < threshold);
  const cheapest = curve.reduce((low, point) =>
    point.sellingPerKwh < low.sellingPerKwh ? point : low,
  );

  const intervals =
    below.length === 0
      ? "No interval today is below it."
      : `${below.length} of ${curve.length} intervals are below it, the lowest at ${clock(cheapest.startMinutes)}.`;

  return `Today's selling price by interval, against a curtailment threshold of ${threshold.toFixed(4)} ${currency}/kWh. ${intervals}`;
}
