import { Form, useNavigation } from "react-router";
import type { Grid } from "../../lib/grid";
import type { SettingsActionData } from "../../lib/settings-form";
import { failureFor } from "../../lib/settings-form";
import EntityAutocomplete from "../EntityAutocomplete";
import { formStyle } from "../form";
import Section from "./Section";

export default function GridSection({
  grid,
  actionData,
}: {
  grid: Grid;
  actionData?: SettingsActionData;
}) {
  const navigation = useNavigation();
  const errors = failureFor(actionData, "grid")?.errors ?? {};
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "grid-save";

  return (
    <Section
      title="Grid"
      description="Both sensors are instantaneous power in W and never negative. The net exchange the strategies balance is consumption minus production."
    >
      <Form method="post" style={{ ...formStyle, marginTop: "1rem" }}>
        <input type="hidden" name="intent" value="grid-save" />
        <EntityAutocomplete
          name="importEntityId"
          label="Consumption — power drawn from the grid (W)"
          placeholder="e.g. sensor.grid_import_power"
          defaultValue={grid.importEntityId}
          error={errors.importEntityId}
        />
        <EntityAutocomplete
          name="exportEntityId"
          label="Production — power fed back into the grid (W)"
          placeholder="e.g. sensor.grid_export_power"
          defaultValue={grid.exportEntityId}
          error={errors.exportEntityId}
        />
        <div>
          <button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save grid"}
          </button>
        </div>
      </Form>
    </Section>
  );
}
