import type { PvEntity, PvEntityErrors } from "../../lib/pv-entities";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import Field from "../Field";
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
            </>
          );
        }}
      />
    </Section>
  );
}
