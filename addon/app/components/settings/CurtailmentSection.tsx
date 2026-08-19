import { useId } from "react";
import { Form, useNavigation } from "react-router";
import type { CurtailmentConfig } from "../../lib/curtailment";
import {
  MAX_DEADBAND_W,
  MAX_GRID_TARGET_W,
  MAX_SETTLE_SECONDS,
  MIN_DEADBAND_W,
  MIN_SETTLE_SECONDS,
  NO_CURTAILABLE_ARRAY_ERROR,
  NO_PRICES_ERROR,
} from "../../lib/curtailment";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import Field from "../Field";
import { errorStyle, formStyle, hintStyle, labelStyle } from "../form";
import Section from "./Section";

export default function CurtailmentSection({
  config,
  /**
   * What is in place for this to work. `arrays` and `prices` both block
   * enabling rather than merely warning — without either, the loop would decide
   * correctly and change nothing, which looks identical from the outside to one
   * that is broken. `grid` only warns, because a grid sensor can be configured
   * afterwards and the log says so until it is.
   */
  ready,
  actionData,
}: {
  config: CurtailmentConfig;
  ready: { grid: boolean; arrays: boolean; prices: boolean };
  actionData?: SettingsActionData;
}) {
  const navigation = useNavigation();
  const errors = failureFor(actionData, "curtailment")?.errors ?? {};
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "curtailment-save";

  const enabledId = useId();

  // Left interactive while curtailment is already on, so that an array that
  // stopped being curtailable afterwards leaves a box that can still be
  // unticked rather than a switch stuck in the on position.
  const canEnable = (ready.arrays && ready.prices) || config.enabled;

  return (
    <Section
      title="PV curtailment"
      description="When enabled, the arrays are held back to roughly what the house and its battery can absorb while a kWh put on the grid earns less than the threshold below. Everything else generates freely."
    >
      <Form method="post" style={{ ...formStyle, marginTop: "1rem" }}>
        <input type="hidden" name="intent" value="curtailment-save" />

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input
            id={enabledId}
            type="checkbox"
            name="enabled"
            defaultChecked={config.enabled}
            disabled={!canEnable}
          />
          <label htmlFor={enabledId} style={labelStyle}>
            Enable PV curtailment
          </label>
        </div>

        {!ready.arrays && (
          <p style={errors.enabled ? errorStyle : hintStyle}>
            {NO_CURTAILABLE_ARRAY_ERROR}
          </p>
        )}
        {!ready.prices && (
          <p style={errors.enabled ? errorStyle : hintStyle}>
            {NO_PRICES_ERROR}
          </p>
        )}
        {!ready.grid && (
          <p style={hintStyle}>
            Curtailment needs the grid sensor before it can decide anything. It
            will say so in the log until then.
          </p>
        )}

        <Field
          name="priceThresholdPerKwh"
          label="Curtail below (currency/kWh)"
          type="number"
          step="any"
          defaultValue={config.priceThresholdPerKwh}
          error={errors.priceThresholdPerKwh}
          hint="Applied to what a kWh put on the grid earns, with your injection formula already applied — not the raw exchange price. 0 means “curtail only when exporting costs money”. Raise it if your contract charges a fee per exported kWh."
        />

        <Field
          name="gridTargetW"
          label="Grid target (W)"
          type="number"
          step={1}
          min={-MAX_GRID_TARGET_W}
          max={MAX_GRID_TARGET_W}
          defaultValue={config.gridTargetW}
          error={errors.gridTargetW}
          hint="Where to aim the meter while curtailing, signed the way the grid reading is: positive importing, negative exporting. 0 is balanced. A negative value keeps a little export as insurance against dipping into import; a positive value does the opposite."
        />

        <Field
          name="deadbandW"
          label="Deadband (W)"
          type="number"
          step={1}
          min={MIN_DEADBAND_W}
          max={MAX_DEADBAND_W}
          defaultValue={config.deadbandW}
          error={errors.deadbandW}
          hint={`How far the meter may sit from the target before the limit is moved. ${MIN_DEADBAND_W}–${MAX_DEADBAND_W} W. Below one percent of an inverter's rating this does nothing the rounding was not already doing.`}
        />

        <Field
          name="minLimitPercent"
          label="Minimum limit (%)"
          type="number"
          step={1}
          min={0}
          max={100}
          defaultValue={config.minLimitPercent}
          error={errors.minLimitPercent}
          hint="The lowest an array is ever taken to. Keep this above zero: an array held at 0% generates nothing, which keeps the meter where it is, which keeps the limit at 0% — and it would never come back on its own. Some inverters also drop out entirely at 0% and take minutes to restart."
        />

        <Field
          name="settleSeconds"
          label="Settle time (seconds)"
          type="number"
          step={1}
          min={MIN_SETTLE_SECONDS}
          max={MAX_SETTLE_SECONDS}
          defaultValue={config.settleSeconds}
          error={errors.settleSeconds}
          hint={`How long the meter must stay off target before the limit moves. ${MIN_SETTLE_SECONDS}–${MAX_SETTLE_SECONDS}s. This is what gives the battery time to soak up a surplus before any of it is thrown away.`}
        />

        <div>
          <button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save PV curtailment"}
          </button>
        </div>
      </Form>
    </Section>
  );
}
