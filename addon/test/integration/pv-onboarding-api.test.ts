import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startStack } from "../stack.js";

it("stages a PV array through ingress and rejects changed and stale previews", async () => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "elias-ems-onboarding-"),
  );
  const fields = {
    title: "Mock inverter",
    powerEntityId: "sensor.inverter_power",
    energyEntityId: "sensor.inverter_energy_total",
    ratedPowerW: 4000,
    controlMode: "stepped",
    stepLimitPercent: 25,
  };
  await writeFile(
    path.join(dataDir, "pv-entities.json"),
    JSON.stringify([
      {
        ...fields,
        id: "existing",
        title: "Other array",
        token: "private-token",
      },
    ]),
  );
  const stack = await startStack({ dataDir });
  const api = `${stack.baseUrl}api/v1/`;
  const onboarding = `${api}onboarding/pv-curtailment`;
  const settings = async () => {
    const response = await fetch(`${api}settings`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("private-token");
    expect(body).not.toContain(stack.ha.token);
    return JSON.parse(body);
  };
  const post = (step: string, body: object) =>
    fetch(`${onboarding}/${step}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const limitEntityId = "number.mock_inverter_limit";
  stack.ha.setState(limitEntityId, 100, { min: 0, max: 100, step: 1 });

  try {
    const before = await settings();
    const setup = await (await fetch(onboarding)).json();
    expect(setup).toMatchObject({
      revision: before.revision,
      enabled: false,
      missingInputs: ["grid.powerEntityId", "prices.forecastEntityId"],
      arrays: [{ id: "existing", eventType: "elias_ems_other_array_pv_limit" }],
    });

    const proposal = { revision: before.revision, fields, limitEntityId };
    const previewResponse = await post("preview", proposal);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      eventType: "elias_ems_mock_inverter_pv_limit",
      diff: expect.arrayContaining([
        { field: "ratedPowerW", before: null, after: 4000 },
        { field: "curtailable", before: null, after: false },
      ]),
      automation: {
        initial_state: false,
        triggers: [
          { trigger: "event", event_type: "elias_ems_mock_inverter_pv_limit" },
        ],
        actions: [{ target: { entity_id: limitEntityId } }],
      },
    });
    expect(await settings()).toEqual(before);
    expect(await readdir(dataDir)).toEqual(["pv-entities.json"]);
    expect(stack.ha.events).toEqual([]);

    const reviewed = { ...proposal, previewToken: preview.previewToken };
    expect(
      (
        await post("apply", {
          ...reviewed,
          fields: { ...fields, ratedPowerW: 5000 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("preview", {
          ...proposal,
          fields: { ...fields, curtailable: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("preview", {
          ...proposal,
          fields: { ...fields, title: "Other-array" },
        })
      ).status,
    ).toBe(400);

    const applied = await post("apply", reviewed);
    expect(applied.status).toBe(200);
    const { arrayId } = await applied.json();
    const after = await settings();
    expect(after.revision).not.toBe(before.revision);
    expect(after.settings).toEqual({
      ...before.settings,
      pvEntities: [
        ...before.settings.pvEntities,
        { ...fields, id: arrayId, curtailable: false },
      ],
    });
    expect(stack.ha.events).toEqual([]);

    const update = {
      arrayId,
      revision: after.revision,
      fields: { ratedPowerW: 4200 },
      limitEntityId,
    };
    const updatePreview = await post("preview", update);
    expect(updatePreview.status).toBe(200);
    const retry = await updatePreview.json();
    expect(retry.diff).toEqual([
      { field: "ratedPowerW", before: 4000, after: 4200 },
    ]);

    const gridEdit = await fetch(`${stack.baseUrl}settings`, {
      method: "POST",
      headers: { Origin: stack.origin },
      body: new URLSearchParams({
        intent: "grid-save",
        powerEntityId: "sensor.grid_power",
      }),
    });
    expect(gridEdit.status).toBe(200);
    const afterGrid = await settings();
    expect(afterGrid.revision).not.toBe(after.revision);
    expect(afterGrid.settings.grid.powerEntityId).toBe("sensor.grid_power");
    expect(
      (await post("apply", { ...update, previewToken: retry.previewToken }))
        .status,
    ).toBe(409);
    expect(await settings()).toEqual(afterGrid);

    const freshUpdate = { ...update, revision: afterGrid.revision };
    const freshPreview = await post("preview", freshUpdate);
    expect(freshPreview.status).toBe(200);
    const { previewToken } = await freshPreview.json();
    const concurrent = await Promise.all([
      post("apply", { ...freshUpdate, previewToken }),
      post("apply", { ...freshUpdate, previewToken }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const final = await settings();
    expect(final.settings).toEqual({
      ...afterGrid.settings,
      pvEntities: [
        afterGrid.settings.pvEntities[0],
        { ...afterGrid.settings.pvEntities[1], ratedPowerW: 4200 },
      ],
    });
    expect(stack.ha.events).toEqual([]);
    expect(
      stack.ha.requests.filter(
        ({ method, path }) =>
          method === "POST" && path.startsWith("/core/api/services/"),
      ),
    ).toEqual([]);
  } finally {
    await stack.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
