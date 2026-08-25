/**
 * Every array and battery in one table.
 *
 * A table rather than a row of tiles, because the number of these is whatever
 * the house has: three fits either way, eight only fits this one. It also puts
 * the same quantity in the same column down the page, which is the thing that
 * makes a column of readings scannable and a grid of cards not.
 *
 * The State column carries a tag naming what its bar is a share of, never a
 * bare bar: an array's is its published limit and a battery's is its charge,
 * and those are different questions with the same shape.
 */
import { Link } from "react-router";
import type { DashboardArray, DashboardBattery } from "../../lib/dashboard";
import type { Reading } from "../../lib/readings";
import {
  accentTagStyle,
  cardLinkStyle,
  cardStyle,
  monoStyle,
  ruleStyle,
  tagStyle,
} from "./chrome";
import FillBar from "./FillBar";
import { BatteryIcon, SunIcon } from "./Icons";

export default function DeviceTable({
  arrays,
  batteries,
}: {
  arrays: DashboardArray[];
  batteries: DashboardBattery[];
}) {
  if (arrays.length === 0 && batteries.length === 0) {
    return (
      <section style={{ ...cardStyle, padding: "1rem 1.125rem" }}>
        <p style={ruleStyle}>
          No arrays or batteries yet — head to{" "}
          <Link to="/settings" style={cardLinkStyle}>
            Settings
          </Link>{" "}
          to add them.
        </p>
      </section>
    );
  }

  return (
    <section style={{ ...cardStyle, padding: "0.875rem 1.125rem 0.25rem" }}>
      {/*
        Two renderings, one shown at a time — see the dashboard block in
        app.css. Four columns need about 520px before they stop being a row of
        collisions, and below that a phone wants a list, not a table it has to
        drag sideways. The alternative, restyling the table elements with
        `display`, keeps the markup and throws away the semantics: a `<td>` set
        to `block` stops being a cell, and a hidden `<thead>` takes the column
        headers out of the accessibility tree with it.
      */}
      <ul className="dash-narrow-only" style={listStyle}>
        {arrays.map((array) => (
          <NarrowRow
            key={array.id}
            icon={<SunIcon size={14} />}
            color="var(--color-pv)"
            title={array.title}
            detail={
              array.ratedPowerW
                ? `${array.ratedPowerW} W rated`
                : "no rating set"
            }
            now={<Value reading={array.power} />}
            energy={array.energy}
            state={<LimitState array={array} />}
          />
        ))}

        {batteries.map((battery) => (
          <NarrowRow
            key={battery.id}
            icon={<BatteryIcon size={14} />}
            color="var(--color-battery)"
            title={battery.title}
            detail={battery.window}
            now={
              <Value
                reading={battery.power}
                color={battery.power?.ok ? "var(--color-battery)" : undefined}
              />
            }
            energy={battery.energy}
            state={
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.625rem",
                  flexGrow: 1,
                }}
              >
                <Value reading={battery.charge} />
                <span style={{ flexGrow: 1, maxWidth: 120 }}>
                  <FillBar
                    percent={battery.chargePercent}
                    color="var(--color-battery)"
                    label={`${battery.title} state of charge`}
                  />
                </span>
              </div>
            }
          />
        ))}
      </ul>

      <div className="dash-wide-only" style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            minWidth: 520,
            borderCollapse: "collapse",
            fontSize: "0.78125rem",
          }}
        >
          <thead>
            <tr>
              <Th width="34%">Device</Th>
              <Th width="15%" align="right">
                Now
              </Th>
              <Th width="16%" align="right">
                Energy
              </Th>
              <Th width="35%">State</Th>
            </tr>
          </thead>
          <tbody>
            {arrays.map((array) => (
              <tr key={array.id}>
                <Td>
                  <Name
                    icon={<SunIcon size={14} />}
                    color="var(--color-pv)"
                    title={array.title}
                    detail={
                      array.ratedPowerW
                        ? `${array.ratedPowerW} W rated`
                        : "no rating set"
                    }
                  />
                </Td>
                <Td align="right">
                  <Value reading={array.power} />
                </Td>
                <Td align="right">
                  <Value reading={array.energy} />
                </Td>
                <Td>
                  <LimitState array={array} />
                </Td>
              </tr>
            ))}

            {batteries.map((battery) => (
              <tr key={battery.id}>
                <Td>
                  <Name
                    icon={<BatteryIcon size={14} />}
                    color="var(--color-battery)"
                    title={battery.title}
                    detail={battery.window}
                  />
                </Td>
                <Td align="right">
                  <Value
                    reading={battery.power}
                    color={
                      battery.power?.ok ? "var(--color-battery)" : undefined
                    }
                  />
                </Td>
                <Td align="right">
                  <Value reading={battery.energy} />
                </Td>
                <Td>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.625rem",
                    }}
                  >
                    {/*
                      The reading itself, not a percentage derived from it: it
                      carries the entity's own unit, goes muted when it is not a
                      live value, and keeps its last-changed tooltip. The number
                      behind it only sets the bar's width.
                    */}
                    <Value reading={battery.charge} />
                    <span style={{ flexGrow: 1, maxWidth: 120 }}>
                      <FillBar
                        percent={battery.chargePercent}
                        color="var(--color-battery)"
                        label={`${battery.title} state of charge`}
                      />
                    </span>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const listStyle = { listStyle: "none", margin: 0, padding: 0 } as const;

/**
 * One device on a phone: name and current power on the first line, then what it
 * has produced or stored and what it has been told, on the second.
 *
 * Two lines rather than four labelled cells, because the labels are what a
 * table needs and a phone has no room for: "3,420 W" beside a solar icon does
 * not need a column heading saying Now.
 */
function NarrowRow({
  icon,
  color,
  title,
  detail,
  now,
  energy,
  state,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  detail: string;
  now: React.ReactNode;
  energy: Reading | null;
  state: React.ReactNode;
}) {
  return (
    <li
      style={{
        padding: "0.75rem 0",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{ color, display: "flex", flex: "none" }}>{icon}</span>
        <h3 style={{ margin: 0, fontSize: "0.8125rem", fontWeight: 600 }}>
          {title}
        </h3>
        <span style={{ flexGrow: 1 }} />
        {now}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem 0.625rem",
          flexWrap: "wrap",
          marginTop: "0.4375rem",
          fontSize: "0.71875rem",
          color: "var(--color-text-muted)",
        }}
      >
        <span>
          {energy?.display ?? "—"} · {detail}
        </span>
        {state}
      </div>
    </li>
  );
}

/**
 * What curtailment has said to this array, if anything.
 *
 * Three states, and they are genuinely different: never told, told to generate
 * freely, and held back. Only the last one gets a bar — a full bar meaning
 * "released" next to an empty one meaning "we have not spoken to it" would be
 * two very different facts drawn almost identically.
 */
function LimitState({ array }: { array: DashboardArray }) {
  if (!array.curtailable) {
    return <span style={tagStyle}>not curtailable</span>;
  }
  if (!array.ratedPowerW) {
    return <span style={tagStyle}>rating needed</span>;
  }
  if (array.limitPercent === null) {
    return <span style={tagStyle}>no limit published</span>;
  }
  if (array.limitPercent >= 100) {
    return <span style={tagStyle}>released</span>;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
      <span style={accentTagStyle("var(--color-pv)", "var(--color-pv-soft)")}>
        limited to {array.limitPercent}%
      </span>
      <span style={{ flexGrow: 1, maxWidth: 120 }}>
        <FillBar
          percent={array.limitPercent}
          color="var(--color-pv)"
          label={`${array.title} published limit`}
        />
      </span>
    </div>
  );
}

function Name({
  icon,
  color,
  title,
  detail,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  detail: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        flexWrap: "wrap",
      }}
    >
      <span style={{ color, display: "flex", flex: "none" }}>{icon}</span>
      <span style={{ fontWeight: 600 }}>{title}</span>
      <span
        style={{ color: "var(--color-text-muted)", fontSize: "0.71875rem" }}
      >
        {detail}
      </span>
    </div>
  );
}

function Value({
  reading,
  color,
}: {
  reading: Reading | null;
  color?: string;
}) {
  return (
    <span
      style={{
        ...monoStyle,
        fontWeight: 600,
        // Muted when the number is not a live value, the rule every reading on
        // this page already follows.
        color: reading?.ok
          ? (color ?? "var(--color-text)")
          : "var(--color-text-muted)",
      }}
      title={reading?.updatedAt ? updatedAt(reading.updatedAt) : undefined}
    >
      {reading ? reading.display : "—"}
    </span>
  );
}

/**
 * Absolute and locale-free, for the reason `Measurement` gives: both the server
 * and the browser render this attribute, so anything depending on the clock or
 * on where the reader is would differ between them.
 */
function updatedAt(at: number): string {
  return `Last changed ${new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

function Th({
  children,
  width,
  align,
}: {
  children: React.ReactNode;
  width: string;
  align?: "right";
}) {
  return (
    <th
      style={{
        width,
        textAlign: align ?? "left",
        fontSize: "0.65625rem",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--color-text-muted)",
        padding: "0 0.875rem 0.5rem 0",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "0.6875rem 0.875rem 0.6875rem 0",
        borderBottom: "1px solid var(--color-border)",
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}
