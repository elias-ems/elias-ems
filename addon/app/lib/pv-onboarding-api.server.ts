import { createHmac, randomBytes } from "node:crypto";
import {
  invalidateChargePlans,
  withChargeLimitLock,
} from "./charge-limit-loop.server";
import { isGridConfigured } from "./grid";
import { isPriceConfigured } from "./prices";
import {
  DUPLICATE_PV_SLUG_ERROR,
  isPvControlMode,
  type PvEntity,
  parsePvEntity,
  pvLimitEventType,
  pvSlug,
} from "./pv-entities";
import { addPvEntity, updatePvEntity } from "./pv-entities.server";
import {
  apiResponse,
  pvFieldKeys,
  readSettingsApi,
} from "./settings-api.server";
import { titleSlugClashes } from "./slug";

const previewKey = randomBytes(32);
const sensorId = /^sensor\.[a-z0-9_]+$/;
const limitId = /^number\.[a-z0-9_]+$/;

type Snapshot = Awaited<ReturnType<typeof readSettingsApi>>;

function missingPvInputs(array: PvEntity) {
  return [
    ...(!array.powerEntityId ? ["powerEntityId"] : []),
    ...(!array.energyEntityId ? ["energyEntityId"] : []),
    ...(array.ratedPowerW === null ? ["ratedPowerW"] : []),
    ...(array.controlMode === "stepped" && array.stepLimitPercent === null
      ? ["stepLimitPercent"]
      : []),
  ];
}

function describeOnboarding({ settings, revision }: Snapshot) {
  return {
    revision,
    enabled: settings.curtailment.enabled,
    missingInputs: [
      ...(!isGridConfigured(settings.grid) ? ["grid.powerEntityId"] : []),
      ...(!isPriceConfigured(settings.prices)
        ? ["prices.forecastEntityId"]
        : []),
      ...(!settings.pvEntities.length ? ["pvArray"] : []),
    ],
    arrays: settings.pvEntities.map((array) => ({
      ...array,
      eventType: pvLimitEventType(pvSlug(array)),
      missingInputs: missingPvInputs(array),
    })),
  };
}

export async function readPvOnboarding() {
  return apiResponse(describeOnboarding(await readSettingsApi()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPvInput(key: (typeof pvFieldKeys)[number], value: unknown) {
  switch (key) {
    case "powerEntityId":
    case "energyEntityId":
      return typeof value === "string" && sensorId.test(value);
    case "title":
      return typeof value === "string";
    case "controlMode":
      return isPvControlMode(value);
    default:
      return (
        value === null || (typeof value === "number" && Number.isFinite(value))
      );
  }
}

function prepareProposal(snapshot: Snapshot, body: Record<string, unknown>) {
  const { settings, revision } = snapshot;
  if (body.revision !== revision) {
    return apiResponse(
      { error: "Settings revision changed. Read and preview again.", revision },
      409,
    );
  }
  if (settings.curtailment.enabled) {
    return apiResponse(
      { error: "Pause PV curtailment in Settings before staging an array." },
      409,
    );
  }
  if (
    (body.arrayId !== undefined && typeof body.arrayId !== "string") ||
    typeof body.limitEntityId !== "string" ||
    !limitId.test(body.limitEntityId) ||
    !isRecord(body.fields)
  ) {
    return apiResponse(
      {
        error:
          "Supply fields and a number.* limitEntityId. arrayId is optional.",
      },
      400,
    );
  }

  const previous = settings.pvEntities.find(
    (array) => array.id === body.arrayId,
  );
  if (body.arrayId !== undefined && !previous) {
    return apiResponse({ error: "PV array not found." }, 404);
  }

  const changes = body.fields;
  const keys = new Set<string>(pvFieldKeys);
  if (Object.keys(changes).some((key) => !keys.has(key))) {
    return apiResponse({ error: "Only PV setup fields may be edited." }, 400);
  }

  const form = new FormData();
  for (const key of pvFieldKeys) {
    const supplied = Object.hasOwn(changes, key);
    const value = supplied ? changes[key] : previous?.[key];
    if (supplied && !isPvInput(key, value)) {
      return apiResponse({ error: "Invalid PV setup field.", field: key }, 400);
    }
    if (value != null) form.set(key, String(value));
  }
  if (previous?.curtailable) form.set("curtailable", "on");

  const parsed = parsePvEntity(form);
  if (!parsed.ok) return apiResponse({ errors: parsed.errors }, 400);
  const fields = parsed.fields;
  const id = previous?.id ?? null;
  if (titleSlugClashes(settings.pvEntities, fields.title, id)) {
    return apiResponse({ errors: { title: DUPLICATE_PV_SLUG_ERROR } }, 400);
  }

  const array = { id: id ?? "", ...fields };
  const eventType = pvLimitEventType(pvSlug(array));
  const automation = {
    alias: `${fields.title} PV curtailment`,
    initial_state: false,
    mode: "queued",
    triggers: [{ trigger: "event", event_type: eventType }],
    actions: [
      {
        action: "number.set_value",
        target: { entity_id: body.limitEntityId },
        data: {
          value:
            "{{ 100 if trigger.event.data.released else trigger.event.data.limit_percent }}",
        },
      },
    ],
  };
  const diff = (Object.keys(fields) as Array<keyof typeof fields>)
    .filter((key) => !previous || fields[key] !== previous[key])
    .map((key) => ({
      field: key,
      before: previous?.[key] ?? null,
      after: fields[key],
    }));
  const review = { revision, arrayId: id, eventType, diff, automation };
  const previewToken = createHmac("sha256", previewKey)
    .update(JSON.stringify(review))
    .digest("hex");
  return {
    fields,
    review,
    previewToken,
    missingInputs: missingPvInputs(array),
  };
}

export async function pvOnboardingAction(request: Request, apply: boolean) {
  if (request.method !== "POST") {
    return apiResponse({ error: "Use POST." }, 405, "POST");
  }
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    return apiResponse({ error: "Use application/json." }, 415);
  }
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.revision !== "string") {
    return apiResponse(
      { error: "Supply the settings revision in a JSON object." },
      400,
    );
  }

  return withChargeLimitLock(async () => {
    const snapshot = await readSettingsApi();
    const proposal = prepareProposal(snapshot, body);
    if (proposal instanceof Response) return proposal;

    const { review, previewToken, fields, missingInputs } = proposal;
    if (!apply) return apiResponse({ ...review, previewToken, missingInputs });
    if (body.previewToken !== previewToken) {
      return apiResponse(
        {
          error:
            "The request differs from the reviewed preview. Preview again.",
        },
        409,
      );
    }
    const saved = review.arrayId
      ? await updatePvEntity(review.arrayId, fields)
      : await addPvEntity(fields);
    if (!saved) return apiResponse({ error: "PV array not found." }, 404);
    invalidateChargePlans();
    const updated = await readSettingsApi();
    return apiResponse({ ...describeOnboarding(updated), arrayId: saved.id });
  });
}
