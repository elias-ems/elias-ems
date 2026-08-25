import { data } from "react-router";
import { pageTitleStyle } from "../components/form";
import BatteriesSection from "../components/settings/BatteriesSection";
import ControlSection from "../components/settings/ControlSection";
import CurtailmentSection from "../components/settings/CurtailmentSection";
import GridSection from "../components/settings/GridSection";
import PricesSection from "../components/settings/PricesSection";
import PvSection from "../components/settings/PvSection";
import {
  DUPLICATE_SLUG_ERROR,
  isSteerable,
  parseBattery,
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
import { releasePvArray, syncControlLoop } from "../lib/control-loop.server";
import {
  NO_CURTAILABLE_ARRAY_ERROR,
  NO_PRICES_ERROR,
  parseCurtailmentConfig,
} from "../lib/curtailment";
import {
  readCurtailmentConfig,
  saveCurtailmentConfig,
} from "../lib/curtailment-config.server";
import { appendDiagnostic } from "../lib/diagnostics.server";
import { isGridConfigured, parseGrid } from "../lib/grid";
import { readGrid, saveGrid } from "../lib/grid.server";
import { readPrices, summarizePrices } from "../lib/price-source.server";
import { isPriceConfigured, parsePriceConfig } from "../lib/prices";
import { readPriceConfig, savePriceConfig } from "../lib/prices.server";
import {
  DUPLICATE_PV_SLUG_ERROR,
  isCurtailable,
  parsePvEntity,
} from "../lib/pv-entities";
import {
  addPvEntity,
  listPvEntities,
  removePvEntity,
  updatePvEntity,
} from "../lib/pv-entities.server";
import type { SettingsActionData } from "../lib/settings-form";
import { titleSlugClashes } from "../lib/slug";
import type { Route } from "./+types/settings";

export async function loader() {
  const [pvEntities, grid, batteries, control, curtailment, prices] =
    await Promise.all([
      listPvEntities(),
      readGrid(),
      listBatteries(),
      readControlConfig(),
      readCurtailmentConfig(),
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
    curtailment,
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

      // Two arrays whose titles slugify the same way would publish to the same
      // event type and take each other's limits, with nothing anywhere
      // reporting a problem. Here rather than in `parsePvEntity` because it
      // needs every other array, which a pure model module cannot read — the
      // same rule, and the same reason, as for batteries below.
      const pvClash = titleSlugClashes(
        await listPvEntities(),
        parsed.fields.title,
        recordId,
      );
      if (pvClash) {
        return failed({
          section: "pv",
          recordId,
          errors: { title: DUPLICATE_PV_SLUG_ERROR },
        });
      }

      if (!recordId) {
        await addPvEntity(parsed.fields);
        return { section: "pv" as const, ok: true as const };
      }

      // Read before writing, because the release below needs the record as it
      // *was*: an array whose rating has just been cleared no longer carries
      // the number its limit was a percentage of.
      const previous = (await listPvEntities()).find(
        (entity) => entity.id === recordId,
      );
      await updatePvEntity(recordId, parsed.fields);

      // An array that has just left the plan must be let go of, or the last
      // limit published for it stands for ever — nothing decides for it any
      // more, so nothing would ever supersede it.
      if (previous && !isCurtailable(parsed.fields)) {
        await releasePvArray(previous);
      }
      return { section: "pv" as const, ok: true as const };
    }

    case "pv-remove": {
      const id = String(formData.get("id"));
      // Same reason, and more urgent: a removed array is one nothing will ever
      // decide for again. Captured before the removal, since afterwards there
      // is nothing left to name it by.
      const removed = (await listPvEntities()).find(
        (entity) => entity.id === id,
      );
      await removePvEntity(id);
      if (removed) await releasePvArray(removed);
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
      const batteryClash = titleSlugClashes(
        await listBatteries(),
        parsed.fields.title,
        recordId,
      );
      if (batteryClash) {
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

    case "curtailment-save": {
      const parsed = parseCurtailmentConfig(formData);
      if (!parsed.ok) {
        return failed({
          section: "curtailment",
          recordId: null,
          errors: parsed.errors,
        });
      }

      // The form disables the checkbox in these states, but the checks have to
      // be here too: an array can stop being curtailable, or a price source can
      // be cleared, after curtailment was switched on — and nothing stops a
      // form being posted directly.
      if (parsed.config.enabled) {
        const [pvEntities, prices] = await Promise.all([
          listPvEntities(),
          readPriceConfig(),
        ]);
        if (!pvEntities.some(isCurtailable)) {
          return failed({
            section: "curtailment",
            recordId: null,
            errors: { enabled: NO_CURTAILABLE_ARRAY_ERROR },
          });
        }
        if (!isPriceConfigured(prices)) {
          return failed({
            section: "curtailment",
            recordId: null,
            errors: { enabled: NO_PRICES_ERROR },
          });
        }
      }

      await saveCurtailmentConfig(parsed.config);
      // Take effect now rather than at the next restart, for the reason
      // battery control does: someone who has just ticked the box expects the
      // log to start moving. This is also what releases the arrays when the
      // box is *un*ticked.
      await syncControlLoop();
      return { section: "curtailment" as const, ok: true as const };
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
  const {
    pvEntities,
    grid,
    batteries,
    control,
    curtailment,
    prices,
    priceSummary,
  } = loaderData;

  return (
    <main className="page">
      <h1 style={pageTitleStyle}>Settings</h1>

      {/* The cards flow into two or three columns once the panel has room for
          them; app.css owns where that happens and why. */}
      <div className="settings-grid" style={{ marginTop: "1.5rem" }}>
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
        <CurtailmentSection
          config={curtailment}
          ready={{
            grid: isGridConfigured(grid),
            arrays: pvEntities.some(isCurtailable),
            prices: isPriceConfigured(prices),
          }}
          actionData={actionData}
        />
      </div>
    </main>
  );
}
