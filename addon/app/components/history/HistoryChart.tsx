import type { HistorySample } from "../../lib/battery-history";
import { captionStyle, monoStyle } from "../dashboard/chrome";

const WIDTH = 900;
const HEIGHT = 210;
const LEFT = 48;
const RIGHT = 14;
const TOP = 14;
const BOTTOM = 28;

export default function HistoryChart({
  samples,
  from,
  to,
  color,
  unit,
  label,
  domain,
  zeroLine = false,
}: {
  samples: HistorySample[];
  from: number;
  to: number;
  color: string;
  unit: string;
  label: string;
  domain?: [number, number];
  zeroLine?: boolean;
}) {
  if (samples.length === 0)
    return <p style={{ ...captionStyle, margin: 0 }}>No recorded values.</p>;

  const values = samples.map((sample) => sample.value);
  let low = domain?.[0] ?? Math.min(...values);
  let high = domain?.[1] ?? Math.max(...values);
  if (zeroLine) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  if (low === high) {
    const pad = Math.max(1, Math.abs(low) * 0.1);
    low -= pad;
    high += pad;
  }

  const plotW = WIDTH - LEFT - RIGHT;
  const plotH = HEIGHT - TOP - BOTTOM;
  const x = (at: number) => LEFT + ((at - from) / (to - from)) * plotW;
  const y = (value: number) => TOP + ((high - value) / (high - low)) * plotH;
  const path = samples
    .map(
      (sample, index) =>
        `${index === 0 ? "M" : "L"}${x(sample.at).toFixed(1)},${y(sample.value).toFixed(1)}`,
    )
    .join(" ");
  const ticks = [high, (high + low) / 2, low];
  const timeTicks = [from, from + (to - from) / 2, to];

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`${label} history from ${formatDate(from)} to ${formatDate(to)}. ${samples.length} recorded values, from ${low.toFixed(1)} to ${high.toFixed(1)} ${unit}.`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={LEFT}
              y1={y(tick)}
              x2={WIDTH - RIGHT}
              y2={y(tick)}
              stroke="var(--color-border)"
            />
            <text
              x={LEFT - 7}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--color-text-muted)"
              fontFamily="var(--font-mono)"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}
        {zeroLine && low < 0 && high > 0 && (
          <line
            x1={LEFT}
            y1={y(0)}
            x2={WIDTH - RIGHT}
            y2={y(0)}
            stroke="var(--color-text-muted)"
            strokeDasharray="4 4"
          />
        )}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {timeTicks.map((tick, index) => (
          <text
            key={tick}
            x={x(tick)}
            y={HEIGHT - 7}
            textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
            fontSize="11"
            fill="var(--color-text-muted)"
            fontFamily="var(--font-mono)"
          >
            {formatDate(tick)}
          </text>
        ))}
      </svg>
      <div
        style={{
          ...captionStyle,
          ...monoStyle,
          display: "flex",
          justifyContent: "space-between",
          gap: "1rem",
          marginTop: "0.25rem",
        }}
      >
        <span>{samples.length} samples</span>
        <span>
          Latest {formatValue(samples[samples.length - 1].value)} {unit}
        </span>
      </div>
    </div>
  );
}

function formatValue(value: number) {
  return Math.abs(value) >= 100
    ? Math.round(value).toLocaleString("en")
    : value.toFixed(1);
}

function formatDate(at: number) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}
