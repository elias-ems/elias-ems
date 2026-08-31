import { useId, useState } from "react";
import { Form, useNavigation } from "react-router";
import type { CurtailmentConfig } from "../../lib/curtailment";
import {
  bandFieldName,
  CURTAILMENT_STRATEGIES,
  MAX_CHARGER_POWER_W,
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
import EntityAutocomplete from "../EntityAutocomplete";
import Field from "../Field";
import {
  errorStyle,
  formStyle,
  hintStyle,
  inputStyle,
  labelStyle,
} from "../form";
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
  const strategyId = useId();
  // Held in state so the band rows and the strategy description can follow the
  // selection without a round trip.
  const [strategy, setStrategy] = useState(config.strategy);
  const selected = CURTAILMENT_STRATEGIES.find(
    (option) => option.id === strategy,
  );
  const bandErrors = errors.bands ?? [];

  /**
   * Which of a band's two values this strategy actually reads. The other is
   * still posted, as a hidden input, so that switching strategy does not erase
   * the tuning belonging to the one being switched away from.
   */
  const shown =
    strategy === "graded-export" ? "exportPercent" : "ceilingPercent";
  const hidden = shown === "exportPercent" ? "ceilingPercent" : "exportPercent";

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

        <div>
          <label htmlFor={strategyId} style={labelStyle}>
            Above the threshold
          </label>
          <select
            id={strategyId}
            name="strategy"
            value={strategy}
            onChange={(event) =>
              setStrategy(event.target.value as CurtailmentConfig["strategy"])
            }
            style={inputStyle()}
          >
            {CURTAILMENT_STRATEGIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {selected && <p style={hintStyle}>{selected.description}</p>}
        </div>

        {strategy === "threshold" ? (
          // Posted even though nothing reads them, so that trying this strategy
          // for an afternoon does not quietly reset the other two to defaults.
          config.bands.flatMap((band, index) =>
            (["abovePerKwh", "ceilingPercent", "exportPercent"] as const).map(
              (key) => (
                <input
                  key={bandFieldName(index, key)}
                  type="hidden"
                  name={bandFieldName(index, key)}
                  value={band[key]}
                />
              ),
            ),
          )
        ) : (
          <fieldset
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "0.5rem",
              padding: "0.75rem 1rem 1rem",
              display: "grid",
              gap: "0.75rem",
            }}
          >
            <legend style={labelStyle}>Bands</legend>
            <p style={hintStyle}>
              Each band reaches this far above the threshold, and the first one
              a price falls under is the one that applies. Past the last edge
              the arrays are released outright. Edges have to climb.
            </p>

            {config.bands.map((band, index) => (
              <div
                // Keyed on the value being shown as well as the row, so that
                // switching strategy remounts the input rather than leaving the
                // other strategy's number sitting under this one's label.
                //
                // biome-ignore lint/suspicious/noArrayIndexKey: the bands are a fixed-length ordered tuple, so position is the identity — rows are never added, removed or reordered.
                key={`band-${index}-${shown}`}
                style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}
              >
                <Field
                  name={bandFieldName(index, "abovePerKwh")}
                  label={`Band ${index + 1} up to (+currency/kWh)`}
                  type="number"
                  step="any"
                  defaultValue={band.abovePerKwh}
                  error={bandErrors[index]?.abovePerKwh}
                />
                <Field
                  name={bandFieldName(index, shown)}
                  label={
                    shown === "exportPercent" ? "Allowed export (%)" : "Cap (%)"
                  }
                  type="number"
                  step={1}
                  min={0}
                  max={100}
                  defaultValue={band[shown]}
                  error={bandErrors[index]?.[shown]}
                />
                <input
                  type="hidden"
                  name={bandFieldName(index, hidden)}
                  value={band[hidden]}
                />
              </div>
            ))}

            <p style={hintStyle}>
              {shown === "exportPercent"
                ? "A percentage of the combined rating of the arrays being curtailed — how much of what they could make is allowed to cross the meter. 100% is the same as not holding them back."
                : "A percentage of each inverter's own rating. Remember this is a ceiling and not a cut: 70% binds around noon and does nothing at dusk."}
            </p>
          </fieldset>
        )}

        <Field
          name="gridTargetW"
          label="Grid target (W)"
          type="number"
          step={1}
          min={-MAX_GRID_TARGET_W}
          max={MAX_GRID_TARGET_W}
          defaultValue={config.gridTargetW}
          error={errors.gridTargetW}
          hint={`Where to aim the meter while curtailing, signed the way the grid reading is: positive importing, negative exporting. 0 is balanced. A negative value keeps a little export as insurance against dipping into import; a positive value does the opposite.${
            strategy === "soft-ceiling"
              ? " The soft ceiling never reads the meter, so this only applies below the threshold."
              : ""
          }`}
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
          hint={`How far the meter may sit from the target before the limit is moved. ${MIN_DEADBAND_W}–${MAX_DEADBAND_W} W. Below one percent of an inverter's rating this does nothing the rounding was not already doing.${
            strategy === "soft-ceiling"
              ? " Below the threshold only, for the same reason as the grid target."
              : ""
          }`}
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

        <fieldset
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: "0.5rem",
            padding: "0.75rem 1rem 1rem",
            display: "grid",
            gap: "0.75rem",
          }}
        >
          <legend style={labelStyle}>A car charging on solar</legend>
          <p style={{ ...hintStyle, maxWidth: "60ch" }}>
            A charger following the meter and curtailment following the meter
            cannot both have it. Curtailment gets there first, so the arrays are
            cut back to the house before the car ever starts — and then nothing
            moves again, because the meter reads balanced. Naming the sensor
            here is what breaks that: while it is on, the arrays are allowed to
            keep making what the charger could take.
          </p>

          <EntityAutocomplete
            name="carChargingEntityId"
            domain="binary_sensor"
            label="A car wants to charge (binary sensor)"
            placeholder="e.g. binary_sensor.evcc_charging"
            defaultValue={config.carChargingEntityId}
            error={errors.carChargingEntityId}
            hint="Use a sensor that is on while a car is connected and still wants charge — not one that is on only while it is already charging. The second kind cannot open this, because curtailment is exactly what stops the charging from starting. Leave empty if there is no charger."
          />

          <Field
            name="chargerPowerW"
            label="Charger power (W)"
            type="number"
            step={1}
            min={0}
            max={MAX_CHARGER_POWER_W}
            defaultValue={config.chargerPowerW}
            error={errors.chargerPowerW}
            hint="What the charger can take at full rate. The arrays are held open for this much, less whatever is already generating that curtailment is not modulating. Set it higher than your arrays combined and they are simply never held back while a car is charging. Left empty, a sensor above holds nothing open — the log says so on every tick until a number is here."
          />
        </fieldset>

        <div>
          <button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save PV curtailment"}
          </button>
        </div>
      </Form>
    </Section>
  );
}
