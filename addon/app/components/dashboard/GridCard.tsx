/**
 * The meter, and how far it is from where the strategies are aiming it.
 *
 * The number alone does not answer the question a person actually has, which is
 * "is that a lot?" — 120 W of export is either a rounding error or a failure
 * depending on a deadband they configured weeks ago. So the reading is drawn
 * against that deadband rather than printed on its own.
 *
 * The scale steps rather than glides — see `meterSpan`. An axis that tracked
 * the reading continuously would make the same 120 W look different from one
 * minute to the next, and would redraw the deadband, the thing the reading is
 * being judged against, at a different width every second.
 */
import { Link } from "react-router";
import type { Reading } from "../../lib/readings";
import {
  cardLinkStyle,
  cardStyle,
  eyebrowStyle,
  monoStyle,
  ruleStyle,
} from "./chrome";
import { ExchangeIcon } from "./Icons";

const METER_W = 560;

export default function GridCard({
  configured,
  power,
  powerW,
  targetW,
  deadbandW,
  settleSeconds,
  minLimitPercent,
}: {
  configured: boolean;
  power: Reading | null;
  powerW: number | null;
  targetW: number;
  deadbandW: number;
  settleSeconds: number;
  minLimitPercent: number;
}) {
  return (
    <section
      style={{
        ...cardStyle,
        display: "grid",
        gridTemplateColumns: "minmax(190px, 220px) minmax(0, 1fr) 220px",
        alignItems: "center",
      }}
    >
      <div
        style={{
          padding: "1rem 1.25rem",
          borderRight: "1px solid var(--color-border)",
        }}
      >
        <h2 style={{ ...eyebrowStyle, marginBottom: "0.5rem" }}>
          <ExchangeIcon size={14} />
          Grid exchange
        </h2>

        {!configured ? (
          <p style={ruleStyle}>
            No grid sensor yet — head to{" "}
            <Link to="/settings" style={cardLinkStyle}>
              Settings
            </Link>
            .
          </p>
        ) : (
          <>
            <div
              style={{
                ...monoStyle,
                fontSize: "2.125rem",
                fontWeight: 600,
                lineHeight: 1,
                letterSpacing: "-0.02em",
                color: direction(powerW).color,
              }}
            >
              {power?.ok ? power.display : (power?.display ?? "—")}
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                marginTop: 5,
                color: direction(powerW).color,
              }}
            >
              {direction(powerW).word}
            </div>
          </>
        )}
      </div>

      <div style={{ padding: "0.875rem 1.5rem" }}>
        <BalanceMeter powerW={powerW} targetW={targetW} deadbandW={deadbandW} />
      </div>

      <div
        style={{
          padding: "1rem 1.25rem",
          borderLeft: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
          gap: "0.3125rem",
        }}
      >
        <Fact label="Settle" value={`${settleSeconds} s off target`} />
        <Fact label="Floor" value={`${minLimitPercent}% of rated`} />
        <Fact label="Deadband" value={`±${deadbandW} W`} />
      </div>
    </section>
  );
}

/**
 * Which way the power is flowing, in the words the rest of the app uses.
 *
 * The sign convention is the one thing to get right here: `grid.ts` defines the
 * reading as positive importing, negative exporting, and every strategy is
 * written against that. Zero is neither, and says so.
 */
function direction(powerW: number | null): { word: string; color: string } {
  if (powerW === null)
    return { word: "no reading", color: "var(--color-text-muted)" };
  if (powerW > 0) return { word: "importing", color: "var(--color-import)" };
  if (powerW < 0) return { word: "exporting", color: "var(--color-export)" };
  return { word: "balanced", color: "var(--color-text-muted)" };
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "0.75rem",
        fontSize: "0.71875rem",
      }}
    >
      <span style={{ color: "var(--color-text-muted)" }}>{label}</span>
      <span style={monoStyle}>{value}</span>
    </div>
  );
}

function BalanceMeter({
  powerW,
  targetW,
  deadbandW,
}: {
  powerW: number | null;
  targetW: number;
  deadbandW: number;
}) {
  const span = meterSpan(powerW, targetW, deadbandW);
  const centre = METER_W / 2;
  const toX = (watts: number) =>
    centre + (clamp(watts - targetW, -span, span) / span) * centre;

  const bandHalf = (deadbandW / span) * centre;
  const valueX = powerW === null ? centre : toX(powerW);
  const [from, to] = valueX < centre ? [valueX, centre] : [centre, valueX];

  return (
    <svg
      viewBox={`0 0 ${METER_W} 62`}
      width="100%"
      role="img"
      aria-label={meterLabel(powerW, targetW, deadbandW)}
    >
      <rect
        x="0"
        y="18"
        width={METER_W}
        height="14"
        rx="7"
        fill="var(--color-surface-raised)"
      />
      {/* Outlined as well as tinted: a 12%-alpha fill on the raised surface is
          about 1.2:1, which is not a mark anyone can see. */}
      <rect
        x={centre - bandHalf}
        y="18.5"
        width={bandHalf * 2}
        height="13"
        fill="var(--color-export-soft)"
        stroke="var(--color-export)"
        strokeWidth="1"
        strokeDasharray="3 2"
      />
      {powerW !== null && (
        <rect
          x={from}
          y="18"
          width={Math.max(2, to - from)}
          height="14"
          rx="3"
          fill={
            powerW > targetW ? "var(--color-import)" : "var(--color-export)"
          }
        />
      )}
      <line
        x1={centre}
        y1="10"
        x2={centre}
        y2="40"
        stroke="var(--color-border-strong)"
        strokeWidth="1.5"
      />
      <g fontSize="9.5" fill="var(--color-text-muted)">
        <text x="2" y="10">
          export
        </text>
        <text x={METER_W - 2} y="10" textAnchor="end">
          import
        </text>
      </g>
      <g
        fontSize="10"
        fill="var(--color-text-muted)"
        fontFamily="var(--font-mono)"
      >
        <text x="2" y="54">
          {targetW - span} W
        </text>
        <text x={METER_W - 2} y="54" textAnchor="end">
          +{targetW + span} W
        </text>
      </g>
      <text
        x={centre}
        y="54"
        textAnchor="middle"
        fontSize="10"
        fill="var(--color-text-muted)"
      >
        target {targetW} W
      </text>
    </svg>
  );
}

/**
 * How many watts either side of the target the meter covers.
 *
 * Two demands pulling opposite ways. It has to be tight enough that the
 * deadband is a visible slice of the track rather than a hairline — twelve
 * deadbands across the whole width does that — and wide enough that a house
 * drawing a kilowatt does not just pin the bar to the end, which is the same
 * picture at 900 W as at 9,000 W.
 *
 * So: the deadband sets the floor, the reading raises it, and the result snaps
 * to one of a few fixed steps. The snapping is the point — a scale that
 * tracked the reading continuously would redraw the deadband at a different
 * width every second, and the band the reading is being judged against is the
 * one thing that has to hold still.
 */
function meterSpan(
  powerW: number | null,
  targetW: number,
  deadbandW: number,
): number {
  const needed = Math.max(
    deadbandW * 6,
    powerW === null ? 0 : Math.abs(powerW - targetW) * 1.15,
  );
  const steps = [300, 600, 1500, 3000, 6000, 12000];
  return steps.find((step) => step >= needed) ?? steps[steps.length - 1];
}

function meterLabel(
  powerW: number | null,
  targetW: number,
  deadbandW: number,
): string {
  if (powerW === null) {
    return `Grid power against a target of ${targetW} W. No reading right now.`;
  }
  const off = Math.abs(powerW - targetW);
  return `Grid power against a target of ${targetW} W: ${powerW} W, ${
    off <= deadbandW ? "inside" : "outside"
  } the ±${deadbandW} W deadband.`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
