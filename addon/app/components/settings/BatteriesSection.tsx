import type { Battery, BatteryErrors } from "../../lib/batteries";
import { BATTERY_DEFAULTS } from "../../lib/batteries";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import Field from "../Field";
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
      description="Capacity and the charge window are typed in; the readings and the target come from Home Assistant."
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
              {battery.targetPowerEntityId ? (
                <>
                  Target: <code>{battery.targetPowerEntityId}</code>
                </>
              ) : (
                "Target: not set — watched, not steered"
              )}
            </div>
          </>
        )}
        renderFields={(battery) => {
          const errors = errorsFor(battery);
          return (
            <>
              <Field
                name="title"
                label="Title"
                placeholder="e.g. Home battery"
                defaultValue={battery?.title}
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
              <EntityAutocomplete
                name="targetPowerEntityId"
                label="Target power (W) — optional"
                placeholder="e.g. number.battery_target_power"
                defaultValue={battery?.targetPowerEntityId}
                error={errors.targetPowerEntityId}
                domains={["number", "input_number"]}
                hint="Where the setpoint is written, same sign convention as Power. Suggests number and input_number entities, but accepts any id you type. Leave empty to watch this battery without steering it."
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
                hint="Leave empty to use the target entity's own limit."
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
                hint="A positive number. Leave empty to use the target entity's own limit."
              />
            </>
          );
        }}
      />
    </Section>
  );
}
