import { useId, useState } from "react";
import type { DashboardReadings } from "../../lib/dashboard";
import { usePolledJson } from "../../lib/json-fetch";
import {
  isCurtailable,
  type PvEntity,
  pvLimitEventType,
  pvSlug,
} from "../../lib/pv-entities";
import { pvAutomationYaml } from "../../lib/pv-onboarding";
import { hintStyle, inputStyle, labelStyle } from "../form";

export default function PvCurtailmentChecklist({
  arrays,
  enabled,
  reviewed,
  onReview,
}: {
  arrays: PvEntity[];
  enabled: boolean;
  reviewed: boolean;
  onReview: (reviewed: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const reviewId = useId();
  const { data, failing } = usePolledJson<DashboardReadings>(
    "/api/readings?snapshot",
    { enabled: open, intervalMs: 5_000, hiddenIntervalMs: 30_000 },
  );
  const gridW = data?.grid.powerW ?? null;
  const gridPower = data?.grid.power;
  const gridDirection =
    gridW === null
      ? "Unavailable"
      : gridW > 0
        ? "Importing"
        : gridW < 0
          ? "Exporting"
          : "Balanced";
  const curtailable = arrays.filter(isCurtailable);

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary style={labelStyle}>PV curtailment setup checklist</summary>
      <ol style={{ paddingInlineStart: "1.4rem" }}>
        <li>
          <h3>Check live readings</h3>
          <p style={hintStyle} role="status">
            {failing || data?.error
              ? "Live readings are not updating."
              : !data && "Loading live readings…"}
          </p>
          <ul>
            <li>
              Grid: {gridDirection}
              {gridW !== null && gridPower?.ok && ` (${gridPower.display})`}
              {" · "}
              <a href="#grid-settings">Grid settings</a>
            </li>
            <li>
              Export price: {data?.prices.production ?? "Unavailable"}
              {" · "}
              <a href="#price-settings">Price settings</a>
            </li>
            {arrays.map((array) => {
              const power = data?.arrays.find(
                (reading) => reading.id === array.id,
              )?.power;
              return (
                <li key={array.id}>
                  {array.title} PV power:{" "}
                  {power?.ok ? power.display : "Unavailable"}
                </li>
              );
            })}
            {arrays.length === 0 && (
              <li>PV power: Add an array to see its reading.</li>
            )}
          </ul>
          <p style={hintStyle}>
            Positive grid power means import. Negative means export. The export
            price includes your production tariff.
          </p>
        </li>
        <li>
          <h3>Confirm inverter settings</h3>
          <p style={hintStyle}>
            In <a href="#pv-settings">PV entities</a>, allow curtailment for
            each inverter you want to control. Use its nameplate AC output in
            watts. Choose “Follows the house” if the inverter supports frequent
            writes, or “One fixed step” with a supported limit if writes must be
            infrequent.
          </p>
          {curtailable.length === 0 && (
            <p style={hintStyle}>No curtailable arrays configured.</p>
          )}
          {curtailable.length > 0 && (
            <ul>
              {curtailable.map((array) => (
                <li key={array.id}>
                  {array.title}: {array.ratedPowerW} W AC,{" "}
                  {array.controlMode === "modulating"
                    ? "Follows the house"
                    : `One fixed step (${array.stepLimitPercent ?? "limit missing"}${array.stepLimitPercent === null ? "" : "%"})`}
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <h3>Set up Home Assistant automations</h3>
          <p style={hintStyle}>
            Paste each template into an automation’s YAML editor. Replace both
            placeholder targets. The example expects a percentage control that
            releases at 100%. If your inverter uses watts, use{" "}
            <code>limit_w</code> and adapt the release action. Match both
            actions to your inverter’s integration. Update the trigger after
            renaming an array.
          </p>
          {curtailable.map((array) => (
            <details key={array.id}>
              <summary>{array.title} automation YAML</summary>
              <p>
                Event:{" "}
                <code style={{ overflowWrap: "anywhere" }}>
                  {pvLimitEventType(pvSlug(array))}
                </code>
              </p>
              <textarea
                aria-label={`${array.title} automation YAML`}
                readOnly
                rows={10}
                value={pvAutomationYaml(array)}
                onFocus={(event) => event.currentTarget.select()}
                style={{
                  ...inputStyle(),
                  boxSizing: "border-box",
                  width: "100%",
                  fontFamily: "monospace",
                  resize: "vertical",
                }}
              />
            </details>
          ))}
        </li>
        <li>
          <h3>Review and verify</h3>
          <p style={hintStyle}>
            With PV curtailment off, use Home Assistant’s Developer Tools →
            Events to fire each array’s exact event. Send{" "}
            <code>released: false</code> and a supported test value in{" "}
            <code>limit_percent</code> (or <code>limit_w</code> for a
            watts-based action). Then send <code>released: true</code> to
            restore normal operation.
          </p>
          <p style={hintStyle}>
            Check both automation traces to see which actions ran. Separately
            check the inverter’s own applied limit or mode after each event. A
            successful trace shows that Home Assistant ran the action. The
            inverter readback confirms the limit and release took effect. PV
            generation alone can fall below a limit as sunlight changes.
          </p>
          {!enabled && (
            <div
              style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}
            >
              <input
                id={reviewId}
                type="checkbox"
                checked={reviewed}
                disabled={
                  curtailable.length === 0 ||
                  curtailable.some(
                    (array) =>
                      array.controlMode === "stepped" &&
                      array.stepLimitPercent === null,
                  )
                }
                onChange={(event) => onReview(event.target.checked)}
              />
              <label htmlFor={reviewId} style={labelStyle}>
                I reviewed the AC ratings and write modes and verified limit and
                release on every curtailable inverter.
              </label>
            </div>
          )}
        </li>
      </ol>
    </details>
  );
}
