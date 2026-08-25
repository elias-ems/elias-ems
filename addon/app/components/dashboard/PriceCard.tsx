/**
 * What a kWh earns and costs right now, and the day it sits in.
 *
 * The selling price leads, and it is the largest thing on the page, because it
 * is the number both strategies are reacting to: curtailment compares it to a
 * threshold, and it is why the battery is soaking a surplus rather than the
 * grid taking it. The buying and exchange prices sit beside it — the exchange
 * one especially, because it is what makes a formula checkable against a bill
 * and a mis-picked entity visible rather than merely plausible.
 */
import { Link } from "react-router";
import type { DashboardPrices } from "../../lib/dashboard";
import {
  captionStyle,
  cardLinkStyle,
  cardStyle,
  eyebrowStyle,
  monoStyle,
  ruleStyle,
} from "./chrome";
import { AlertIcon, TagIcon } from "./Icons";
import PriceChart from "./PriceChart";

export default function PriceCard({
  prices,
  thresholdPerKwh,
  thresholdDisplay,
  strategyLabel,
  curtailing,
}: {
  prices: DashboardPrices;
  /** The number the chart draws its line at. */
  thresholdPerKwh: number;
  /** The same, formatted the way every other price on the page is. */
  thresholdDisplay: string;
  /**
   * What happens in the band above the threshold, or null when the answer is
   * "nothing" — which is what the threshold on its own already says.
   */
  strategyLabel: string | null;
  /** Whether curtailment is switched on, which is what makes the line mean anything. */
  curtailing: boolean;
}) {
  // The question the card is really asking: is exporting worth doing right now?
  // Not "is the price negative" — the threshold is configurable because a
  // contract with an injection fee breaks even somewhere above zero.
  const below =
    prices.productionPerKwh !== null &&
    prices.productionPerKwh < thresholdPerKwh;

  return (
    // The two columns, the stacking, and which edge the divider sits on are in
    // app.css: a media query is the one thing an inline style cannot say.
    <section className="dash-price dash-split" style={cardStyle}>
      <div
        style={{
          padding: "1.125rem 1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.875rem",
        }}
      >
        <h2 style={eyebrowStyle}>
          <TagIcon size={14} />
          Price now
        </h2>

        {!prices.configured ? (
          <Empty>
            No price source yet — head to{" "}
            <Link to="/settings" style={cardLinkStyle}>
              Settings
            </Link>{" "}
            and point this at a day-ahead entity.
          </Empty>
        ) : prices.error ? (
          <Empty>{prices.error}</Empty>
        ) : (
          <>
            <div>
              <Label>Selling</Label>
              <div
                style={{
                  ...monoStyle,
                  fontSize: "2.5rem",
                  fontWeight: 600,
                  lineHeight: 1,
                  letterSpacing: "-0.02em",
                  color: below
                    ? "var(--color-import)"
                    : prices.production === null
                      ? "var(--color-text-muted)"
                      : "var(--color-text)",
                }}
              >
                {stripUnit(prices.production)}
              </div>
              <div
                style={{
                  ...monoStyle,
                  ...captionStyle,
                  fontSize: "0.75rem",
                  marginTop: 5,
                }}
              >
                {prices.currency}/kWh
              </div>
            </div>

            <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
              <Figure label="Buying" value={stripUnit(prices.consumption)} />
              <Figure label="Exchange" value={stripUnit(prices.spot)} />
              <Figure
                label="Threshold"
                value={stripUnit(thresholdDisplay)}
                muted
              />
              {curtailing && strategyLabel && (
                <Figure label="Above it" value={strategyLabel} muted />
              )}
            </div>

            {curtailing && below && (
              <p
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.4375rem",
                  margin: 0,
                  padding: "0.5rem 0.625rem",
                  borderRadius: 6,
                  fontSize: "0.71875rem",
                  lineHeight: 1.45,
                  background: "var(--color-import-soft)",
                  color: "var(--color-import)",
                }}
              >
                <span style={{ flex: "none", marginTop: 1 }}>
                  <AlertIcon size={14} />
                </span>
                <span>
                  Under your {thresholdDisplay} threshold — a kWh put on the
                  grid costs you money right now.
                </span>
              </p>
            )}
          </>
        )}
      </div>

      <div
        style={{
          padding: "1rem 1.25rem 0.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          minWidth: 0,
        }}
      >
        <h2 style={eyebrowStyle}>Selling price · today, hourly average</h2>
        {prices.curve.length > 0 ? (
          <>
            {/*
              The same chart at two plot sizes, one shown at a time. The wide
              one scaled into a phone column would render its axis at five
              pixels tall; see `PriceChart`.
            */}
            <div className="dash-chart-wide">
              <PriceChart
                curve={prices.curve}
                nowMinutes={prices.nowMinutes}
                thresholdPerKwh={thresholdPerKwh}
                currency={prices.currency}
              />
            </div>
            <div className="dash-chart-narrow">
              <PriceChart
                compact
                curve={prices.curve}
                nowMinutes={prices.nowMinutes}
                thresholdPerKwh={thresholdPerKwh}
                currency={prices.currency}
              />
            </div>
          </>
        ) : (
          <Empty>
            {prices.configured
              ? "Nothing to chart yet — that entity has published no prices for today."
              : "The day's prices appear here once a source is configured."}
          </Empty>
        )}
        {prices.coverage && (
          <p style={{ ...captionStyle, margin: 0 }}>
            {[prices.slot, prices.coverage].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.6875rem",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--color-text-muted)",
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

function Figure({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div
        style={{
          ...monoStyle,
          fontSize: "1.0625rem",
          fontWeight: 500,
          color: muted ? "var(--color-text-muted)" : "var(--color-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={ruleStyle}>{children}</p>;
}

/**
 * `"0.0784 EUR/kWh"` → `"0.0784"`.
 *
 * The card prints the currency once, under the headline, rather than after
 * every number — four repetitions of `EUR/kWh` in a row of three figures is
 * noise, and it is what pushed the headline into wrapping at narrow widths.
 * Splitting the server's string rather than asking for an unformatted number
 * keeps one formatter in one place: `formatPricePerKwh` still decides the
 * decimals, and this only drops what it appended.
 */
function stripUnit(display: string | null): string {
  if (display === null) return "—";
  const space = display.indexOf(" ");
  return space === -1 ? display : display.slice(0, space);
}
