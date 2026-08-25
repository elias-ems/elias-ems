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

/** The plot area, in user units. The SVG scales to whatever width it is given. */
const W = 640;
const H = 180;
/** Room for the y labels on the left, and for the hour labels underneath. */
const PAD_LEFT = 38;
const PAD_TOP = 6;
const PAD_BOTTOM = 26;
const MINUTES_PER_DAY = 1440;

/** Wide enough to read, narrow enough that 24 of them leave gaps. */
const BAR_WIDTH = (W / 24) * 0.8;

export default function PriceChart({
  curve,
  nowMinutes,
  thresholdPerKwh,
  currency,
}: {
  curve: PriceCurvePoint[];
  nowMinutes: number | null;
  /** Curtail below this. The line, and the top of the shaded band. */
  thresholdPerKwh: number;
  currency: string;
}) {
  if (curve.length === 0) return null;

  const values = curve.map((point) => point.sellingPerKwh);
  const scale = buildScale(values, thresholdPerKwh);
  const thresholdY = scale.y(thresholdPerKwh);
  const nowX = nowMinutes === null ? null : (nowMinutes / MINUTES_PER_DAY) * W;

  return (
    <div>
      <svg
        viewBox={`0 0 ${PAD_LEFT + W + 12} ${PAD_TOP + H + PAD_BOTTOM}`}
        width="100%"
        role="img"
        aria-label={describe(curve, thresholdPerKwh, currency)}
      >
        <g transform={`translate(${PAD_LEFT},${PAD_TOP})`}>
          {/* Everything under the threshold: the hours exporting costs money. */}
          <rect
            x="0"
            y={thresholdY}
            width={W}
            height={Math.max(0, H - thresholdY)}
            fill="var(--color-import-soft)"
          />

          {scale.ticks.map((tick) => (
            <line
              key={tick.value}
              x1="0"
              y1={tick.y}
              x2={W}
              y2={tick.y}
              stroke="var(--color-border)"
            />
          ))}

          {curve.map((point) => {
            const x = (point.startMinutes / MINUTES_PER_DAY) * W;
            const top = scale.y(point.sellingPerKwh);
            const below = point.sellingPerKwh < thresholdPerKwh;
            const isNow =
              nowMinutes !== null &&
              point.startMinutes <= nowMinutes &&
              nowMinutes < point.startMinutes + 60;

            return (
              <rect
                key={point.startMinutes}
                x={x + (W / 24 - BAR_WIDTH) / 2}
                y={Math.min(top, thresholdY)}
                width={BAR_WIDTH}
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
            x2={W}
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
                y2={H}
                stroke="var(--color-text)"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.4"
              />
              <rect
                x={Math.min(Math.max(nowX - 24, 0), W - 48)}
                y="3"
                width="48"
                height="16"
                rx="3"
                fill="var(--color-text)"
              />
              <text
                x={Math.min(Math.max(nowX, 24), W - 24)}
                y="14.5"
                textAnchor="middle"
                fontSize="10"
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
            fontSize="10"
            fill="var(--color-text-muted)"
            textAnchor="middle"
            fontFamily="var(--font-mono)"
          >
            {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => (
              <text key={hour} x={(hour / 24) * W} y={H + 16}>
                {String(hour).padStart(2, "0")}
              </text>
            ))}
          </g>
        </g>

        <g
          fontSize="10"
          fill="var(--color-text-muted)"
          textAnchor="end"
          fontFamily="var(--font-mono)"
        >
          {scale.ticks.map((tick) => (
            <text
              key={tick.value}
              x={PAD_LEFT - 6}
              y={PAD_TOP + tick.y + 4}
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

      <div style={{ ...captionStyle, display: "flex", gap: "0.875rem" }}>
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
function buildScale(values: number[], threshold: number): Scale {
  const lo = Math.min(...values, threshold);
  const hi = Math.max(...values, threshold);
  // A flat day would otherwise divide by zero and put every bar on the axis.
  const span = Math.max(hi - lo, 0.01);
  const step = niceStep(span);

  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const y = (value: number) => ((max - value) / (max - min)) * H;

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
