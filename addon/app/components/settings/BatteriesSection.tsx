import { useId } from "react";
import type { Battery, BatteryErrors } from "../../lib/batteries";
import {
  BATTERY_DEFAULTS,
  batterySlug,
  isSteerable,
  setpointEventType,
} from "../../lib/batteries";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import Field from "../Field";
import { hintStyle, labelStyle } from "../form";
import BatteryNameField from "./BatteryNameField";
import EditableList from "./EditableList";
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
      title="Batteries"
      description="Capacity and the charge window are typed in; the readings come from Home Assistant. A steered battery's setpoints go out as an event named after its title."
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
                  Steered —{" "}
                  <code>{setpointEventType(batterySlug(battery))}</code>
                </>
              ) : (
                "Not steered — watched only"
              )}
            </div>
          </>
        )}
        renderFields={(battery) => {
          const errors = errorsFor(battery);
          return (
            <>
              <BatteryNameField
                defaultValue={battery?.title}
                savedTitle={battery?.title}
                error={errors.title}
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
                hint="Control will not discharge below this."
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
                hint="Control will not charge above this."
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
              <SteeredField defaultChecked={battery?.steered ?? true} />
              <Field
                name="maxChargePowerW"
                label="Maximum charge power (W) — optional"
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 5000"
                defaultValue={battery?.maxChargePowerW ?? ""}
                error={errors.maxChargePowerW}
                hint="Leave empty for no limit."
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
                hint="A positive number. Leave empty for no limit."
              />
            </>
          );
        }}
      />
    </Section>
  );
}

/**
 * Whether this battery is steered at all — the one thing that decides if a
 * setpoint is ever published for it. A checkbox rather than the presence of
 * some other field, so that "watched, not steered" is something chosen rather
 * than something arrived at by leaving a box empty.
 *
 * Its own component only because a checkbox is the one control the shared
 * `Field` does not render: the label goes beside the input rather than above
 * it, and it has no value to carry.
 */
function SteeredField({ defaultChecked }: { defaultChecked: boolean }) {
  const inputId = useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input
          id={inputId}
          type="checkbox"
          name="steered"
          defaultChecked={defaultChecked}
        />
        <label htmlFor={inputId} style={labelStyle}>
          Steer this battery
        </label>
      </div>
      <p style={hintStyle}>
        Publishes a setpoint event for it whenever control decides something.
        Leave this off to watch the battery without steering it — it still
        appears on the dashboard and is simply left alone.
      </p>
    </div>
  );
}
