/**
 * The two control loops, side by side with the feed of what they have decided.
 *
 * A rail of rows rather than a card each: the strategies are one system acting
 * on one meter, and the layout says so. It also means the pair keeps the same
 * shape when a third strategy arrives — a row, not another column to find room
 * for.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { StrategySummary } from "../../lib/dashboard-view";
import type { DiagnosticEntry } from "../../lib/diagnostics";
import {
  cardLinkStyle,
  cardStyle,
  iconPlateStyle,
  monoStyle,
  ruleStyle,
  unitStyle,
} from "./chrome";
import DecisionFeed from "./DecisionFeed";
import FillBar from "./FillBar";
import { BatteryIcon, SunIcon } from "./Icons";
import StatePill from "./StatePill";

/** The colour a row's number and bar are drawn in, by which loop it is. */
const ACCENT = {
  "pv-curtailment": {
    color: "var(--color-pv)",
    soft: "var(--color-pv-soft)",
  },
  "battery-control": {
    color: "var(--color-battery)",
    soft: "var(--color-battery-soft)",
  },
} as const;

export default function StrategyRail({
  curtailment,
  control,
  initialEntries,
}: {
  curtailment: { summary: StrategySummary; rule: ReactNode };
  control: { summary: StrategySummary; rule: ReactNode };
  initialEntries: DiagnosticEntry[];
}) {
  return (
    <section
      style={{
        ...cardStyle,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 340px)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <StrategyRow
          icon={<SunIcon size={17} />}
          accent={ACCENT["pv-curtailment"]}
          title="PV curtailment"
          summary={curtailment.summary}
          rule={curtailment.rule}
          divided
        />
        <StrategyRow
          icon={<BatteryIcon size={17} />}
          accent={ACCENT["battery-control"]}
          title="Battery control"
          summary={control.summary}
          rule={control.rule}
        />
      </div>

      <DecisionFeed initialEntries={initialEntries} />
    </section>
  );
}

function StrategyRow({
  icon,
  accent,
  title,
  summary,
  rule,
  divided,
}: {
  icon: ReactNode;
  accent: { color: string; soft: string };
  title: string;
  summary: StrategySummary;
  rule: ReactNode;
  divided?: boolean;
}) {
  // Grey rather than the feature's colour whenever the strategy is not acting,
  // so a page of muted rows reads as "nothing is happening" at a glance.
  const acting = summary.tone === "pv" || summary.tone === "battery";
  const valueColor = acting ? accent.color : "var(--color-text-muted)";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.875rem",
        padding: "0.9375rem 1.125rem",
        borderBottom: divided ? "1px solid var(--color-border)" : undefined,
        flexWrap: "wrap",
      }}
    >
      <span
        style={iconPlateStyle(
          acting ? accent.color : "var(--color-text-muted)",
          acting ? accent.soft : "var(--color-surface-raised)",
        )}
      >
        {icon}
      </span>

      <div style={{ flexGrow: 1, minWidth: 200 }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: "0.5625rem" }}
        >
          <h3 style={{ margin: 0, fontSize: "0.90625rem", fontWeight: 600 }}>
            {title}
          </h3>
          <StatePill tone={summary.tone}>{summary.state}</StatePill>
        </div>
        <p style={{ ...ruleStyle, marginTop: 5 }}>
          {rule}{" "}
          <Link to="/settings" style={cardLinkStyle}>
            Settings
          </Link>
        </p>
      </div>

      <div style={{ width: 168, flex: "none" }}>
        <div
          style={{
            ...monoStyle,
            fontSize: "1.625rem",
            fontWeight: 600,
            lineHeight: 1,
            textAlign: "right",
            color: valueColor,
          }}
        >
          {summary.value ?? "—"}
          {summary.value !== null && summary.unit && (
            <span style={unitStyle}>{summary.unit}</span>
          )}
        </div>
        <div style={{ marginTop: "0.5rem", textAlign: "right" }}>
          <FillBar
            percent={summary.percent}
            color={acting ? accent.color : "var(--color-chart-bar)"}
            caption={summary.caption}
            label={title}
          />
        </div>
      </div>
    </div>
  );
}
