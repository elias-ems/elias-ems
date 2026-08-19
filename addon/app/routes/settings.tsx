import { data } from "react-router";
import BatteriesSection from "../components/settings/BatteriesSection";
import ControlSection from "../components/settings/ControlSection";
import GridSection from "../components/settings/GridSection";
import PricesSection from "../components/settings/PricesSection";
import PvSection from "../components/settings/PvSection";
import {
  DUPLICATE_SLUG_ERROR,
  isSteerable,
  parseBattery,
  slugifyTitle,
} from "../lib/batteries";
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
import { appendDiagnostic } from "../lib/diagnostics.server";
import { isGridConfigured, parseGrid } from "../lib/grid";
import { readGrid, saveGrid } from "../lib/grid.server";
import { readPrices, summarizePrices } from "../lib/price-source.server";
import { parsePriceConfig } from "../lib/prices";
import { savePriceConfig } from "../lib/prices.server";
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
  const [pvEntities, grid, batteries, control, prices] = await Promise.all([
    listPvEntities(),
    readGrid(),
    listBatteries(),
    readControlConfig(),
    // Its own read rather than the dashboard's: this page has no readings to
    // borrow, and what it needs is the *summary* — proof that the entity picked
    // is really a price feed, which is only knowable by going and looking.
    readPrices(),
  ]);

  return {
    pvEntities,
    grid,
    batteries,
    control,
    prices: prices.config,
    priceSummary: summarizePrices(prices.read),
  };
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

      // Two batteries whose titles slugify the same way would publish to the
      // same event type and take each other's targets, with nothing anywhere
      // reporting a problem. Here rather than in `parseBattery` because it
      // needs every other battery, which a pure model module cannot read.
      const slug = slugifyTitle(parsed.fields.title);
      const clash = (await listBatteries()).some(
        (battery) =>
          battery.id !== recordId && slugifyTitle(battery.title) === slug,
      );
      if (clash) {
        return failed({
          section: "battery",
          recordId,
          errors: { title: DUPLICATE_SLUG_ERROR },
        });
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
      // here too: a battery can stop being steered after control was switched
      // on, and nothing stops a form being posted directly.
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

    case "prices-save": {
      const parsed = parsePriceConfig(formData);
      if (!parsed.ok) {
        return failed({
          section: "prices",
          recordId: null,
          errors: parsed.errors,
        });
      }

      await savePriceConfig(parsed.config);

      // Logged here and nowhere else on this path. The read side runs on every
      // dashboard render and every stream push, so logging what it found would
      // fill the buffer with the same sentence; the card shows that state
      // instead. A configuration change is rare, deliberate, and exactly what
      // somebody reading back a control decision later needs to see beside it.
      const { read } = await readPrices();
      appendDiagnostic(
        "prices",
        read.error ? "warn" : "info",
        read.error
          ? `Prices from ${parsed.config.forecastEntityId}: ${read.error}`
          : `Prices from ${parsed.config.forecastEntityId} — ${summarizePrices(read).detail}`,
      );

      return { section: "prices" as const, ok: true as const };
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
  const { pvEntities, grid, batteries, control, prices, priceSummary } =
    loaderData;

  return (
    <main style={{ padding: "2rem", maxWidth: 640 }}>
      <h1>Settings</h1>

      <PvSection pvEntities={pvEntities} actionData={actionData} />
      <GridSection grid={grid} actionData={actionData} />
      <BatteriesSection batteries={batteries} actionData={actionData} />
      <PricesSection
        config={prices}
        summary={priceSummary}
        actionData={actionData}
      />
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
