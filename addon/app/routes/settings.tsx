import { useEffect, useId, useState } from "react";
import { data, Form, useNavigation } from "react-router";
import EntityAutocomplete from "../components/EntityAutocomplete";
import {
  addPvEntity,
  listPvEntities,
  type PvEntity,
  type PvEntityFields,
  removePvEntity,
  updatePvEntity,
} from "../lib/pv-entities.server";
import type { Route } from "./+types/settings";

type FieldErrors = {
  title?: string;
  powerEntityId?: string;
  energyEntityId?: string;
};

export async function loader() {
  const pvEntities = await listPvEntities();
  return { pvEntities };
}

function readFields(
  formData: FormData,
): { ok: true; fields: PvEntityFields } | { ok: false; errors: FieldErrors } {
  const title = formData.get("title")?.toString().trim();
  const powerEntityId = formData.get("powerEntityId")?.toString().trim();
  const energyEntityId = formData.get("energyEntityId")?.toString().trim();

  if (!title || !powerEntityId || !energyEntityId) {
    const errors: FieldErrors = {};
    if (!title) errors.title = "Give this array a name.";
    if (!powerEntityId) errors.powerEntityId = "Pick the current power entity.";
    if (!energyEntityId)
      errors.energyEntityId = "Pick the total energy entity.";
    return { ok: false, errors };
  }

  return { ok: true, fields: { title, powerEntityId, energyEntityId } };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "remove") {
    await removePvEntity(String(formData.get("id")));
    return { ok: true };
  }

  // `entityId` tells the page which form the errors belong to: an id for the
  // row being edited, null for the add form.
  const entityId = intent === "update" ? String(formData.get("id")) : null;
  const result = readFields(formData);
  if (!result.ok) {
    return data({ errors: result.errors, entityId }, { status: 400 });
  }

  if (entityId) {
    await updatePvEntity(entityId, result.fields);
  } else {
    await addPvEntity(result.fields);
  }
  return { ok: true };
}

export default function Settings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { pvEntities } = loaderData;
  const navigation = useNavigation();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const failure = actionData && "errors" in actionData ? actionData : null;
  const submittingIntent = navigation.formData?.get("intent");
  const isSubmitting = navigation.state !== "idle";
  const isAdding = isSubmitting && submittingIntent === "add";
  const savingId =
    isSubmitting && submittingIntent === "update"
      ? String(navigation.formData?.get("id"))
      : null;

  // A save that succeeded should put the row back into its read-only state.
  useEffect(() => {
    if (actionData && !("errors" in actionData)) setEditingId(null);
  }, [actionData]);

  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>Settings</h1>

      <section style={{ marginTop: "1.5rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>PV entities</h2>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            aria-label="Add PV entity"
            title="Add PV entity"
            style={{
              width: "2rem",
              height: "2rem",
              borderRadius: "999px",
              border: "1px solid var(--color-border-strong)",
              background: showForm
                ? "var(--color-surface-active)"
                : "var(--color-surface)",
              fontSize: "1.25rem",
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            +
          </button>
        </div>

        {pvEntities.length === 0 && !showForm && (
          <p style={{ color: "var(--color-text-muted)" }}>
            No PV entities yet.
          </p>
        )}

        {pvEntities.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
            {pvEntities.map((entity) => (
              <li
                key={entity.id}
                style={{
                  padding: "0.75rem 0",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                {editingId === entity.id ? (
                  <Form method="post" style={formStyle}>
                    <input type="hidden" name="intent" value="update" />
                    <input type="hidden" name="id" value={entity.id} />
                    <EntityFields
                      entity={entity}
                      errors={
                        failure?.entityId === entity.id
                          ? failure.errors
                          : undefined
                      }
                    />
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button type="submit" disabled={savingId === entity.id}>
                        {savingId === entity.id ? "Saving…" : "Save"}
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </Form>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "1rem",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{entity.title}</div>
                      <div
                        style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}
                      >
                        Power: <code>{entity.powerEntityId}</code>
                      </div>
                      <div style={{ fontSize: "0.875rem" }}>
                        Energy: <code>{entity.energyEntityId}</code>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.75rem" }}>
                      <button
                        type="button"
                        onClick={() => setEditingId(entity.id)}
                        style={linkButtonStyle("var(--color-text)")}
                      >
                        Edit
                      </button>
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="id" value={entity.id} />
                        <button
                          type="submit"
                          style={linkButtonStyle("var(--color-danger)")}
                        >
                          Remove
                        </button>
                      </Form>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {showForm && (
          <Form
            key={pvEntities.length}
            method="post"
            style={{ ...formStyle, marginTop: "1rem" }}
          >
            <input type="hidden" name="intent" value="add" />
            <EntityFields
              errors={failure?.entityId === null ? failure.errors : undefined}
            />
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="submit" disabled={isAdding}>
                {isAdding ? "Adding…" : "Add"}
              </button>
              <button type="button" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </Form>
        )}
      </section>
    </main>
  );
}

const formStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  maxWidth: 420,
} as const;

function linkButtonStyle(color: string) {
  return {
    border: "none",
    background: "none",
    padding: 0,
    color,
    cursor: "pointer",
    font: "inherit",
  };
}

function EntityFields({
  entity,
  errors,
}: {
  entity?: PvEntity;
  errors?: FieldErrors;
}) {
  const titleId = useId();

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <label
          htmlFor={titleId}
          style={{ fontSize: "0.875rem", fontWeight: 600 }}
        >
          Title
        </label>
        <input
          id={titleId}
          type="text"
          name="title"
          autoComplete="off"
          placeholder="e.g. South roof"
          defaultValue={entity?.title}
          style={{
            padding: "0.5rem",
            border: `1px solid ${
              errors?.title
                ? "var(--color-danger)"
                : "var(--color-border-strong)"
            }`,
            borderRadius: 4,
            font: "inherit",
          }}
        />
        {errors?.title && (
          <p
            style={{
              fontSize: "0.75rem",
              color: "var(--color-danger)",
              margin: 0,
            }}
          >
            {errors.title}
          </p>
        )}
      </div>
      <EntityAutocomplete
        name="powerEntityId"
        label="Current power (W)"
        placeholder="e.g. sensor.inverter_power"
        defaultValue={entity?.powerEntityId}
        error={errors?.powerEntityId}
      />
      <EntityAutocomplete
        name="energyEntityId"
        label="Total energy generated (kWh)"
        placeholder="e.g. sensor.inverter_energy_total"
        defaultValue={entity?.energyEntityId}
        error={errors?.energyEntityId}
      />
    </>
  );
}
