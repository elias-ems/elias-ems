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
  barWidth: number;
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
  /** Wide enough to read, narrow enough that 24 of them leave gaps. */
  barWidth: (640 / 24) * 0.8,
  hours: [0, 3, 6, 9, 12, 15, 18, 21, 24],
  font: 10,
  nowChip: 48,
};

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
  barWidth: (270 / 24) * 0.78,
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
  if (curve.length === 0) return null;

  const g = compact ? COMPACT : WIDE;
  const values = curve.map((point) => point.sellingPerKwh);
  const scale = buildScale(values, thresholdPerKwh, g.h);
  const thresholdY = scale.y(thresholdPerKwh);
  const nowX =
    nowMinutes === null ? null : (nowMinutes / MINUTES_PER_DAY) * g.w;
  const halfChip = g.nowChip / 2;

  return (
    <div>
      <svg
        viewBox={`0 0 ${g.padLeft + g.w + 12} ${g.padTop + g.h + g.padBottom}`}
        width="100%"
        role="img"
        aria-label={describe(curve, thresholdPerKwh, currency)}
      >
        <g transform={`translate(${g.padLeft},${g.padTop})`}>
          {/* Everything under the threshold: the hours exporting costs money. */}
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

          {curve.map((point) => {
            const x = (point.startMinutes / MINUTES_PER_DAY) * g.w;
            const top = scale.y(point.sellingPerKwh);
            const below = point.sellingPerKwh < thresholdPerKwh;
            const isNow =
              nowMinutes !== null &&
              point.startMinutes <= nowMinutes &&
              nowMinutes < point.startMinutes + 60;

            return (
              <rect
                key={point.startMinutes}
                x={x + (g.w / 24 - g.barWidth) / 2}
                y={Math.min(top, thresholdY)}
                width={g.barWidth}
                // A price sitting exactly on the threshold still gets a mark,
                // so an hour never silently disappears from the row.
                height={Math.max(1.5, Math.abs(top - thresholdY))}
                rx="2"
                fill={
                  isNow
                    ? "var(--color-chart-now)"
                    : below
                      ? "var(--color-import)"
                      : "var(--color-chart-bar)"
                }
              />
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
              />
              <rect
                x={clamp(nowX - halfChip, 0, g.w - g.nowChip)}
                y="3"
                width={g.nowChip}
                height="16"
                rx="3"
                fill="var(--color-text)"
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
          gap: "0.25rem 0.875rem",
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
        <span style={{ marginLeft: "auto" }}>
          {currency}/kWh after the contract
        </span>
      </div>
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
};

/**
 * The y axis: a domain wide enough for the data *and* the threshold, and a set
 * of round gridlines across it.
 *
 * The threshold has to be inside the domain even when no hour comes near it —
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

  return { y, ticks };
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

  const hours =
    below.length === 0
      ? "No hour today is below it."
      : `${below.length} of ${curve.length} hours are below it, the lowest at ${clock(cheapest.startMinutes)}.`;

  return `Today's selling price by the hour, against a curtailment threshold of ${threshold.toFixed(4)} ${currency}/kWh. ${hours}`;
}
