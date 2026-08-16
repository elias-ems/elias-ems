import { data } from "react-router";
import BatteriesSection from "../components/settings/BatteriesSection";
import ControlSection from "../components/settings/ControlSection";
import GridSection from "../components/settings/GridSection";
import PvSection from "../components/settings/PvSection";
import { isSteerable, parseBattery } from "../lib/batteries";
import {
  addBattery,
  listBatteries,
  removeBattery,
  updateBattery,
} from "../lib/batteries.server";
import { NO_STEERABLE_BATTERY_ERROR, parseControlConfig } from "../lib/control";
import {
  readControlConfig,
  saveControlConfig,
} from "../lib/control-config.server";
import { syncControlLoop } from "../lib/control-loop.server";
import { isGridConfigured, parseGrid } from "../lib/grid";
import { readGrid, saveGrid } from "../lib/grid.server";
import { parsePvEntity } from "../lib/pv-entities";
import {
  addPvEntity,
  listPvEntities,
  removePvEntity,
  updatePvEntity,
} from "../lib/pv-entities.server";
import type { SettingsActionData } from "../lib/settings-form";
import type { Route } from "./+types/settings";

export async function loader() {
  const [pvEntities, grid, batteries, control] = await Promise.all([
    listPvEntities(),
    readGrid(),
    listBatteries(),
    readControlConfig(),
  ]);

  return { pvEntities, grid, batteries, control };
}

/** Null for a section's add form, the row's id when editing an existing one. */
function editedId(formData: FormData): string | null {
  const id = formData.get("id");
  return id ? String(id) : null;
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const failed = (result: SettingsActionData) => data(result, { status: 400 });

  switch (intent) {
    case "pv-add":
    case "pv-update": {
      const recordId = intent === "pv-update" ? editedId(formData) : null;
      const parsed = parsePvEntity(formData);
      if (!parsed.ok) {
        return failed({ section: "pv", recordId, errors: parsed.errors });
      }
      if (recordId) await updatePvEntity(recordId, parsed.fields);
      else await addPvEntity(parsed.fields);
      return { section: "pv" as const, ok: true as const };
    }

    case "pv-remove": {
      await removePvEntity(String(formData.get("id")));
      return { section: "pv" as const, ok: true as const };
    }

    case "grid-save": {
      const parsed = parseGrid(formData);
      if (!parsed.ok) {
        return failed({
          section: "grid",
          recordId: null,
          errors: parsed.errors,
        });
      }
      await saveGrid(parsed.grid);
      return { section: "grid" as const, ok: true as const };
    }

    case "battery-add":
    case "battery-update": {
      const recordId = intent === "battery-update" ? editedId(formData) : null;
      const parsed = parseBattery(formData);
      if (!parsed.ok) {
        return failed({ section: "battery", recordId, errors: parsed.errors });
      }
      if (recordId) await updateBattery(recordId, parsed.fields);
      else await addBattery(parsed.fields);
      return { section: "battery" as const, ok: true as const };
    }

    case "battery-remove": {
      await removeBattery(String(formData.get("id")));
      return { section: "battery" as const, ok: true as const };
    }

    case "control-save": {
      const parsed = parseControlConfig(formData);
      if (!parsed.ok) {
        return failed({
          section: "control",
          recordId: null,
          errors: parsed.errors,
        });
      }

      // The form disables the checkbox in this state, but the check has to be
      // here too: a control key can be cleared from a battery after control was
      // switched on, and nothing stops a form being posted directly.
      if (parsed.config.enabled) {
        const batteries = await listBatteries();
        if (!batteries.some(isSteerable)) {
          return failed({
            section: "control",
            recordId: null,
            errors: { enabled: NO_STEERABLE_BATTERY_ERROR },
          });
        }
      }

      await saveControlConfig(parsed.config);
      // Take effect now rather than at the next restart: someone who has just
      // ticked the box expects the log on the home page to start moving.
      await syncControlLoop();
      return { section: "control" as const, ok: true as const };
    }

    default:
      // Only our own forms post here, so an unknown intent is a bug in this
      // file, not something a user can reach by filling something in wrong.
      throw data(`Unknown settings intent: ${intent}`, { status: 400 });
  }
}

export default function Settings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { pvEntities, grid, batteries, control } = loaderData;

  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>Settings</h1>

      <PvSection pvEntities={pvEntities} actionData={actionData} />
      <GridSection grid={grid} actionData={actionData} />
      <BatteriesSection batteries={batteries} actionData={actionData} />
      <ControlSection
        config={control}
        ready={{
          grid: isGridConfigured(grid),
          batteries: batteries.length > 0,
          steerable: batteries.some(isSteerable),
        }}
        actionData={actionData}
      />
    </main>
  );
}
