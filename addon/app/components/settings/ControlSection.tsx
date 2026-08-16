import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";
import type { ControlConfig } from "../../lib/control";
import {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  NO_STEERABLE_BATTERY_ERROR,
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
   * Whether the grid, at least one battery, and at least one battery with a
   * control key are configured. The last is the only one of the three that
   * blocks enabling rather than merely warning.
   */
  ready,
  actionData,
}: {
  config: ControlConfig;
  ready: { grid: boolean; batteries: boolean; steerable: boolean };
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

  const missing = [
    !ready.grid && "the grid sensor",
    !ready.batteries && "at least one battery",
  ].filter((item): item is string => Boolean(item));

  // Left interactive while control is already on, so that a control key
  // cleared afterwards leaves a box that can still be unticked rather than a
  // switch stuck in the on position.
  const canEnable = ready.steerable || config.enabled;

  return (
    <Section
      title="Battery control"
      description="When enabled, a loop reconsiders what the batteries should be doing at the interval below and writes its decision to the diagnostics on the home page."
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

        {!ready.steerable && (
          <p style={errors.enabled ? errorStyle : hintStyle}>
            {NO_STEERABLE_BATTERY_ERROR}
          </p>
        )}

        {missing.length > 0 && (
          <p style={hintStyle}>
            Control needs {missing.join(" and ")} before it can decide anything.
            It will say so in the log until then.
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
          hint={`How often the loop reconsiders. ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS}s.`}
        />

        <div>
          <button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save battery control"}
          </button>
        </div>
      </Form>
    </Section>
  );
}
