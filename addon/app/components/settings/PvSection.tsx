import { useId } from "react";
import type { PvEntity, PvEntityErrors } from "../../lib/pv-entities";
import { isCurtailable, pvLimitEventType, pvSlug } from "../../lib/pv-entities";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import Field from "../Field";
import { hintStyle, labelStyle } from "../form";
import EditableList from "./EditableList";
import Section from "./Section";
import { useSectionEditor } from "./useSectionEditor";

export default function PvSection({
  pvEntities,
  actionData,
}: {
  pvEntities: PvEntity[];
  actionData?: SettingsActionData;
}) {
  const editor = useSectionEditor(actionData, "pv");
  const failure = failureFor(actionData, "pv");

  const errorsFor = (entity: PvEntity | undefined): PvEntityErrors =>
    failure && failure.recordId === (entity?.id ?? null) ? failure.errors : {};

  return (
    <Section
      title="PV entities"
      description="The readings come from Home Assistant. A curtailable array's generation limit goes out as an event named after its title, which is what PV curtailment steers it with."
      add={{
        label: "Add PV entity",
        open: editor.showAdd,
        onToggle: () => editor.setShowAdd(!editor.showAdd),
      }}
    >
      <EditableList
        records={pvEntities}
        intent="pv"
        emptyMessage="No PV entities yet."
        showAdd={editor.showAdd}
        onCloseAdd={() => editor.setShowAdd(false)}
        editingId={editor.editingId}
        onEdit={editor.setEditingId}
        renderSummary={(entity) => (
          <>
            <div style={{ fontWeight: 600 }}>{entity.title}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
              Power: <code>{entity.powerEntityId}</code>
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              Energy: <code>{entity.energyEntityId}</code>
            </div>
            <div style={{ fontSize: "0.875rem" }}>
              {isCurtailable(entity) ? (
                <>
                  Curtailable at {entity.ratedPowerW} W —{" "}
                  <code>{pvLimitEventType(pvSlug(entity))}</code>
                </>
              ) : (
                "Not curtailable — watched only"
              )}
            </div>
          </>
        )}
        renderFields={(entity) => {
          const errors = errorsFor(entity);
          return (
            <>
              <Field
                name="title"
                label="Title"
                placeholder="e.g. South roof"
                defaultValue={entity?.title}
                error={errors.title}
                hint="Names the array on the dashboard, and is what its limit event is called after."
              />
              <EntityAutocomplete
                name="powerEntityId"
                label="Current power (W)"
                placeholder="e.g. sensor.inverter_power"
                defaultValue={entity?.powerEntityId}
                error={errors.powerEntityId}
              />
              <EntityAutocomplete
                name="energyEntityId"
                label="Total energy generated (kWh)"
                placeholder="e.g. sensor.inverter_energy_total"
                defaultValue={entity?.energyEntityId}
                error={errors.energyEntityId}
              />
              <CurtailableField defaultChecked={entity?.curtailable ?? false} />
              <Field
                name="ratedPowerW"
                label="Inverter rated power (W)"
                type="number"
                min={0}
                step="any"
                placeholder="e.g. 5000"
                defaultValue={entity?.ratedPowerW ?? ""}
                error={errors.ratedPowerW}
                hint="The inverter's rated AC output. Curtailment is commanded as a percentage of it, so one step is a hundredth of this number. Only needed for a curtailable array."
              />
            </>
          );
        }}
      />
    </Section>
  );
}

/**
 * Whether this array may be held back at all — the one thing that decides if a
 * limit is ever published for it. A checkbox rather than the presence of the
 * rating beside it, so that "watched, not curtailed" is something chosen rather
 * than something arrived at by leaving a box empty; the rating is then required
 * once this is ticked, which is where the two fields meet.
 *
 * Its own component for the reason `SteeredField` is: a checkbox is the one
 * control the shared `Field` does not render, with its label beside the input
 * rather than above it and no value to carry.
 */
function CurtailableField({ defaultChecked }: { defaultChecked: boolean }) {
  const inputId = useId();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input
          id={inputId}
          type="checkbox"
          name="curtailable"
          defaultChecked={defaultChecked}
        />
        <label htmlFor={inputId} style={labelStyle}>
          Allow curtailing this array
        </label>
      </div>
      <p style={hintStyle}>
        Publishes a generation limit as an event whenever curtailment decides
        one. Leave this off to watch the array without holding it back — it
        still appears on the dashboard and still counts towards what the house
        is generating.
      </p>
    </div>
  );
}
