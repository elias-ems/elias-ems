import { useState } from "react";
import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteLoaderData,
} from "@remix-run/react";
import { addPvEntity, listPvEntities, removePvEntity } from "../lib/pv-entities.server";
import EntityAutocomplete from "../components/EntityAutocomplete";

export async function loader() {
  const pvEntities = await listPvEntities();
  return json({ pvEntities });
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "remove") {
    await removePvEntity(formData.get("id"));
    return json({ ok: true });
  }

  const powerEntityId = formData.get("powerEntityId")?.toString().trim();
  const energyEntityId = formData.get("energyEntityId")?.toString().trim();

  const errors = {};
  if (!powerEntityId) errors.powerEntityId = "Pick the current power entity.";
  if (!energyEntityId) errors.energyEntityId = "Pick the total energy entity.";
  if (Object.keys(errors).length > 0) {
    return json({ errors }, { status: 400 });
  }

  await addPvEntity({ powerEntityId, energyEntityId });
  return json({ ok: true });
}

export default function Settings() {
  const { pvEntities } = useLoaderData();
  const { ingressPath } = useRouteLoaderData("root");
  const actionData = useActionData();
  const navigation = useNavigation();
  const [showForm, setShowForm] = useState(false);
  const settingsAction = `${ingressPath}/settings`;

  const isAdding =
    navigation.state !== "idle" && navigation.formData?.get("intent") !== "remove";

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 640 }}>
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
              border: "1px solid #cbd2d9",
              background: showForm ? "#e4e7eb" : "#fff",
              fontSize: "1.25rem",
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            +
          </button>
        </div>

        {pvEntities.length === 0 && !showForm && (
          <p style={{ color: "#7b8794" }}>No PV entities yet.</p>
        )}

        {pvEntities.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
            {pvEntities.map((entity) => (
              <li
                key={entity.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid #e4e7eb",
                }}
              >
                <div>
                  <div>
                    Power: <code>{entity.powerEntityId}</code>
                  </div>
                  <div>
                    Energy: <code>{entity.energyEntityId}</code>
                  </div>
                </div>
                <Form method="post" action={settingsAction}>
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="id" value={entity.id} />
                  <button
                    type="submit"
                    style={{
                      border: "none",
                      background: "none",
                      color: "#e12d39",
                      cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        )}

        {showForm && (
          <Form
            key={pvEntities.length}
            method="post"
            action={settingsAction}
            style={{
              marginTop: "1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              maxWidth: 420,
            }}
          >
            <EntityAutocomplete
              name="powerEntityId"
              label="Current power (W)"
              placeholder="e.g. sensor.inverter_power"
              error={actionData?.errors?.powerEntityId}
              ingressPath={ingressPath}
            />
            <EntityAutocomplete
              name="energyEntityId"
              label="Total energy generated (kWh)"
              placeholder="e.g. sensor.inverter_energy_total"
              error={actionData?.errors?.energyEntityId}
              ingressPath={ingressPath}
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
