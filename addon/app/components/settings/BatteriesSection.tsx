import { useId } from "react";
import type { Battery, BatteryErrors } from "../../lib/batteries";
import {
  BATTERY_DEFAULTS,
  batterySlug,
  isSteerable,
  supportsSetpoints,
} from "../../lib/batteries";
import { commandEventType, SETPOINT_MODES } from "../../lib/battery-command";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import Field from "../Field";
import { hintStyle, labelStyle } from "../form";
import EditableList from "./EditableList";
import EventNameField from "./EventNameField";
import Section from "./Section";
import { useSectionEditor } from "./useSectionEditor";

export default function BatteriesSection({
  batteries,
  actionData,
}: {
  batteries: Battery[];
  actionData?: SettingsActionData;
}) {
  const editor = useSectionEditor(actionData, "battery");
  const failure = failureFor(actionData, "battery");

  const errorsFor = (battery: Battery | undefined): BatteryErrors =>
    failure && failure.recordId === (battery?.id ?? null) ? failure.errors : {};

  return (
    <Section
      id="batteries"
      title="Batteries"
      description="Capacity and the charge window are typed in; the readings come from Home Assistant. The selected battery control strategy publishes a command event for each battery with Steer this battery enabled."
      add={{
        label: "Add battery",
        open: editor.showAdd,
        onToggle: () => editor.setShowAdd(!editor.showAdd),
      }}
    >
      <EditableList
        records={batteries}
        intent="battery"
        emptyMessage="No batteries yet."
        showAdd={editor.showAdd}
        onCloseAdd={() => editor.setShowAdd(false)}
        editingId={editor.editingId}
        onEdit={editor.setEditingId}
        renderSummary={(battery) => (
          <>
            <div style={{ fontWeight: 600 }}>{battery.title}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
              {battery.capacityKwh} kWh, used between {battery.minChargePercent}
              % and {battery.maxChargePercent}%
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              Power: <code>{battery.powerEntityId}</code>
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              Energy: <code>{battery.energyEntityId}</code>
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              Charge: <code>{battery.socEntityId}</code>
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              {isSteerable(battery) ? (
                <>
                  Steered; commands on{" "}
                  <code>{commandEventType(batterySlug(battery))}</code>
                </>
              ) : (
                "Watched — steering off"
              )}
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              Modes: {battery.controlModes.join(", ")}
              {battery.dischargeLimitSupported
                ? "; discharge limit in balance"
                : ""}
              {supportsSetpoints(battery) ? "" : " — not usable by net zero"}
            </div>
            {battery.chargeLimitPlanning && (
              <div style={{ fontSize: "0.875rem" }}>Charge-limit planning</div>
            )}
          </>
        )}
        renderFields={(battery) => {
          const errors = errorsFor(battery);
          return (
            <>
              <EventNameField
                defaultValue={battery?.title}
                savedTitle={battery?.title}
                error={errors.title}
                placeholder="e.g. Home battery"
                noun="battery"
                carries="command"
                eventType={commandEventType}
              />
              <Field
                name="capacityKwh"
                label="Capacity (kWh)"
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 10"
                defaultValue={battery?.capacityKwh}
                error={errors.capacityKwh}
              />
              <Field
                name="minChargePercent"
                label="Minimum charge (%)"
                type="number"
                min={0}
                max={100}
                step={1}
                defaultValue={
                  battery?.minChargePercent ?? BATTERY_DEFAULTS.minChargePercent
                }
                error={errors.minChargePercent}
                hint="For charge-limit planning, match the reserve configured in the battery's native self-consumption mode."
              />
              <Field
                name="maxChargePercent"
                label="Maximum charge (%)"
                type="number"
                min={0}
                max={100}
                step={1}
                defaultValue={
                  battery?.maxChargePercent ?? BATTERY_DEFAULTS.maxChargePercent
                }
                error={errors.maxChargePercent}
                hint="For charge-limit planning, match the maximum SoC configured on the battery."
              />
              <EntityAutocomplete
                name="energyEntityId"
                label="Energy (kWh)"
                placeholder="e.g. sensor.battery_energy_total"
                defaultValue={battery?.energyEntityId}
                error={errors.energyEntityId}
              />
              <EntityAutocomplete
                name="powerEntityId"
                label="Power (W) — positive charging, negative discharging"
                placeholder="e.g. sensor.battery_power"
                defaultValue={battery?.powerEntityId}
                error={errors.powerEntityId}
              />
              <EntityAutocomplete
                name="socEntityId"
                label="Charge — state of charge (%)"
                placeholder="e.g. sensor.battery_state_of_charge"
                defaultValue={battery?.socEntityId}
                error={errors.socEntityId}
              />
              <CheckboxField
                name="steered"
                label="Steer this battery"
                defaultChecked={battery?.steered ?? true}
                hint="Allows the selected battery control strategy to publish commands for this battery. An automation listening for the event above turns them into whatever this inverter needs. Leave this off to only monitor it."
              />
              <fieldset style={fieldsetStyle}>
                <legend style={labelStyle}>
                  Modes its automation can carry out
                </legend>
                <CheckboxField
                  name="controlModes"
                  value="balance"
                  label="Balance: native self-consumption within limits"
                  defaultChecked
                  disabled
                />
                {SETPOINT_MODES.map((mode) => (
                  <CheckboxField
                    key={mode}
                    name="controlModes"
                    value={mode}
                    label={MODE_LABELS[mode]}
                    defaultChecked={
                      battery?.controlModes.includes(mode) ?? true
                    }
                  />
                ))}
                <p style={hintStyle}>
                  Net zero energy commands hold, charge and discharge setpoints
                  and needs all three. Optimize charge limits commands balance.
                </p>
              </fieldset>
              <CheckboxField
                name="dischargeLimitSupported"
                label="Can limit discharge (AC output) in balance"
                defaultChecked={battery?.dischargeLimitSupported ?? false}
                hint="Lets Optimize charge limits hold energy back for higher-priced hours. The automation must cap battery output, not whole-inverter or grid export. Off leaves discharge native."
              />
              <Field
                name="powerStepW"
                label="Power step (W)"
                type="number"
                min={1}
                step="any"
                defaultValue={
                  battery?.powerStepW ?? BATTERY_DEFAULTS.powerStepW
                }
                error={errors.powerStepW}
                hint="The resolution limits are planned in — the step of the setting the automation writes."
              />
              <CheckboxField
                name="chargeLimitPlanning"
                label="Plan charge limits"
                defaultChecked={battery?.chargeLimitPlanning ?? false}
                hint="Shows a charge-limit plan on Home, even while another strategy is selected. Enable Optimize charge limits under Battery control to publish it."
              />
              <Field
                name="chargeEfficiencyPercent"
                label="Efficiency per direction (%)"
                type="number"
                min={1}
                max={100}
                step="any"
                defaultValue={battery?.chargeEfficiencyPercent ?? 95}
                error={errors.chargeEfficiencyPercent}
                hint="95% charging and 95% discharging gives about 90% round-trip efficiency."
              />
              <Field
                name="maxChargePowerW"
                label="Maximum charge power (W) — optional"
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 5000"
                defaultValue={battery?.maxChargePowerW ?? ""}
                error={errors.maxChargePowerW}
                hint="Required for charge-limit planning. Otherwise, leave empty to leave commands uncapped in this direction."
              />
              <Field
                name="maxDischargePowerW"
                label="Maximum discharge power (W) — optional"
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 5000"
                defaultValue={battery?.maxDischargePowerW ?? ""}
                error={errors.maxDischargePowerW}
                hint="Required for charge-limit planning. Otherwise, leave empty to leave commands uncapped in this direction."
              />
            </>
          );
        }}
      />
    </Section>
  );
}

const MODE_LABELS = {
  hold: "Hold: keep battery power at 0 W",
  charge: "Charge at a given power",
  discharge: "Discharge at a given power",
} as const;

const fieldsetStyle = {
  border: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
} as const;

/**
 * A checkbox with its label beside it. Its own component only because a
 * checkbox is the one control the shared `Field` does not render.
 *
 * Steering is a checkbox rather than the presence of some other field, so that
 * "watched, not steered" is something chosen rather than something arrived at
 * by leaving a box empty.
 */
function CheckboxField({
  name,
  value,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string;
  value?: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
  disabled?: boolean;
}) {
  const inputId = useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input
          id={inputId}
          type="checkbox"
          name={name}
          value={value}
          defaultChecked={defaultChecked}
          disabled={disabled}
        />
        <label htmlFor={inputId} style={labelStyle}>
          {label}
        </label>
      </div>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  );
}
