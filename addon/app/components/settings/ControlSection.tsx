import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";
import { CHARGE_LIMIT_BATTERY_ERROR } from "../../lib/charge-limit-status";
import type { ControlConfig } from "../../lib/control";
import {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  STRATEGIES,
} from "../../lib/control";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import Field from "../Field";
import {
  errorStyle,
  formStyle,
  hintStyle,
  inputStyle,
  labelStyle,
} from "../form";
import Section from "./Section";

export default function ControlSection({
  config,
  /**
   * Whether a battery is configured, and whether exactly one is steered and
   * planned. The second is what blocks enabling rather than merely warning.
   */
  ready,
  actionData,
}: {
  config: ControlConfig;
  ready: {
    batteries: boolean;
    planned: boolean;
  };
  actionData?: SettingsActionData;
}) {
  const navigation = useNavigation();
  const errors = failureFor(actionData, "control")?.errors ?? {};
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "control-save";

  const enabledId = useId();
  const strategyId = useId();
  // Held in state only so the strategy description can follow the selection.
  const [strategy, setStrategy] = useState(config.strategy);
  const selected = STRATEGIES.find((option) => option.id === strategy);

  // Left interactive while control is already on, so that a battery
  // un-steered afterwards leaves a box that can still be unticked rather than
  // a switch stuck in the on position. Every strategy needs the same battery.
  const eligible = ready.planned;
  const canEnable = eligible || config.enabled;

  return (
    <Section
      id="battery-control"
      title="Battery control"
      description="When enabled, the selected strategy plans the battery every few minutes from solar forecasts, household history and prices, publishes the current interval as a battery command, and writes each decision to the diagnostics on the home page."
    >
      <Form method="post" style={{ ...formStyle, marginTop: "1rem" }}>
        <input type="hidden" name="intent" value="control-save" />

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input
            id={enabledId}
            type="checkbox"
            name="enabled"
            defaultChecked={config.enabled}
            disabled={!canEnable}
          />
          <label htmlFor={enabledId} style={labelStyle}>
            Enable battery control
          </label>
        </div>

        {!eligible && (
          <p style={errors.enabled ? errorStyle : hintStyle}>
            {CHARGE_LIMIT_BATTERY_ERROR}
          </p>
        )}

        {!ready.batteries && (
          <p style={hintStyle}>
            Control needs a battery before it can plan anything.
          </p>
        )}

        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
        >
          <label htmlFor={strategyId} style={labelStyle}>
            Strategy
          </label>
          <select
            id={strategyId}
            name="strategy"
            value={strategy}
            onChange={(event) =>
              setStrategy(event.target.value as ControlConfig["strategy"])
            }
            style={inputStyle()}
          >
            {STRATEGIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {selected && <p style={hintStyle}>{selected.description}</p>}
        </div>

        <Field
          name="intervalSeconds"
          label="Loop interval (seconds)"
          type="number"
          min={MIN_INTERVAL_SECONDS}
          max={MAX_INTERVAL_SECONDS}
          step={1}
          defaultValue={config.intervalSeconds}
          error={errors.intervalSeconds}
          hint={`At most how often the shared control loop reconsiders PV curtailment. Battery strategies replan every five minutes regardless. ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS}s.`}
        />
        {errors.enabled && <p style={errorStyle}>{errors.enabled}</p>}

        <div>
          <button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save battery control"}
          </button>
        </div>
      </Form>
    </Section>
  );
}
