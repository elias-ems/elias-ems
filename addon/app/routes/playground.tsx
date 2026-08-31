/**
 * Every component the add-on draws with, on one page, in the states that matter.
 *
 * Two things it is for.
 *
 * The first is the states nobody can reach on purpose. A sensor that has gone
 * unavailable, a price feed whose formula stopped parsing, a control loop that
 * is enabled but not running, a rejected form with its fields lit up — each of
 * those is a real branch in a component, and the only way to see one on the
 * real pages is to break the installation until it happens. Here they are just
 * fixtures, so a change to how an error reads can be checked in the second it
 * takes to scroll to it.
 *
 * The second is the two things that are wrong on every page at once when they
 * are wrong at all: the light/dark tokens and the breakpoints. Both are
 * repo-wide rules — [app.css](../app.css) is the only stylesheet, and every
 * colour goes through a `--color-*` token — and a page that renders all of it
 * side by side is where a hardcoded hex or a card that has stopped reflowing is
 * obvious rather than reported months later from someone's dark-themed panel.
 *
 * Reachable from the Debug section at the foot of Tools, and from nowhere else:
 * it is a developer's page, so it is not in the top bar. It ships with the
 * add-on rather than being stripped from the production build, because the
 * theme it has to be checked against is Home Assistant's own — and that only
 * exists inside a real ingress panel.
 *
 * Nothing here reads or writes anything. The forms post to this route's own
 * action, which reports what they would have sent and saves none of it.
 */
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import DiagnosticsBox from "../components/DiagnosticsBox";
import {
  accentTagStyle,
  captionStyle,
  cardLinkStyle,
  cardStyle,
  eyebrowStyle,
  iconPlateStyle,
  monoStyle,
  ruleStyle,
  sectionLabelStyle,
  tagStyle,
  unitStyle,
} from "../components/dashboard/chrome";
import DecisionFeed from "../components/dashboard/DecisionFeed";
import DeviceTable from "../components/dashboard/DeviceTable";
import FillBar from "../components/dashboard/FillBar";
import GridCard from "../components/dashboard/GridCard";
import {
  AlertIcon,
  BatteryIcon,
  ExchangeIcon,
  SunIcon,
  TagIcon,
} from "../components/dashboard/Icons";
import PriceCard from "../components/dashboard/PriceCard";
import PriceChart from "../components/dashboard/PriceChart";
import StatePill from "../components/dashboard/StatePill";
import StrategyRail from "../components/dashboard/StrategyRail";
import EntityAutocomplete from "../components/EntityAutocomplete";
import Field from "../components/Field";
import {
  errorStyle,
  cardStyle as formCardStyle,
  headingStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  linkButtonStyle,
  pageTitleStyle,
  rowStyle,
} from "../components/form";
import LiveHealthFacts from "../components/LiveHealthFacts";
import LiveStatus from "../components/LiveStatus";
import Measurement from "../components/Measurement";
import { Specimen, Variant } from "../components/playground/Specimen";
import ViewportRuler from "../components/playground/ViewportRuler";
import BatteriesSection from "../components/settings/BatteriesSection";
import ControlSection from "../components/settings/ControlSection";
import CurtailmentSection from "../components/settings/CurtailmentSection";
import EditableList from "../components/settings/EditableList";
import EventNameField from "../components/settings/EventNameField";
import GridSection from "../components/settings/GridSection";
import PricesSection from "../components/settings/PricesSection";
import PvSection from "../components/settings/PvSection";
import Section from "../components/settings/Section";
import { targetEventType } from "../lib/batteries";
import {
  batteryControlSummary,
  curtailmentSummary,
} from "../lib/dashboard-view";
import { playgroundFixtures } from "../lib/playground-fixtures";
import { pvLimitEventType } from "../lib/pv-entities";
import type { Route } from "./+types/playground";

/**
 * One clock reading for the whole page.
 *
 * Every fixture that has a timestamp in it is derived from this number, and it
 * comes from the loader rather than from the component so that the server
 * render and the browser's hydration build from the identical value. Calling
 * `Date.now()` during render would give the two sides answers a few hundred
 * milliseconds apart, and the ISO strings in the health list are printed
 * verbatim — which is a hydration mismatch, not a rounding difference.
 */
export async function loader() {
  return { now: Date.now() };
}

/**
 * Absorbs the forms.
 *
 * Every settings section renders a `<Form method="post">`, which posts to
 * whichever route is showing it — so without an action here the first Save
 * anyone clicked would be a 405. It reports what the form carried and stores
 * none of it: the point of the section specimens is how they look and how they
 * fail, and a playground that quietly rewrote `addon/data` while someone
 * clicked through it would be a trap rather than a tool.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();

  return {
    posted: Array.from(form.entries()).map(
      ([name, value]) => `${name}=${String(value)}`,
    ),
  };
}

/**
 * Every specimen on the page, keyed so the index and the specimen itself
 * cannot drift apart — one entry names it once, and both ends read that.
 */
const ENTRIES = {
  appHeader: {
    id: "app-header",
    name: "AppHeader",
    path: "components/AppHeader.tsx",
  },
  tokens: { id: "tokens", name: "Theme tokens", path: "app.css" },

  field: { id: "field", name: "Field", path: "components/Field.tsx" },
  entityAutocomplete: {
    id: "entity-autocomplete",
    name: "EntityAutocomplete",
    path: "components/EntityAutocomplete.tsx",
  },
  eventNameField: {
    id: "event-name-field",
    name: "EventNameField",
    path: "components/settings/EventNameField.tsx",
  },
  formStyles: {
    id: "form-styles",
    name: "Form styles",
    path: "components/form.ts",
  },

  measurement: {
    id: "measurement",
    name: "Measurement",
    path: "components/Measurement.tsx",
  },
  liveStatus: {
    id: "live-status",
    name: "LiveStatus",
    path: "components/LiveStatus.tsx",
  },
  liveHealthFacts: {
    id: "live-health-facts",
    name: "LiveHealthFacts",
    path: "components/LiveHealthFacts.tsx",
  },
  diagnosticsBox: {
    id: "diagnostics-box",
    name: "DiagnosticsBox",
    path: "components/DiagnosticsBox.tsx",
  },

  icons: { id: "icons", name: "Icons", path: "components/dashboard/Icons.tsx" },
  statePill: {
    id: "state-pill",
    name: "StatePill",
    path: "components/dashboard/StatePill.tsx",
  },
  fillBar: {
    id: "fill-bar",
    name: "FillBar",
    path: "components/dashboard/FillBar.tsx",
  },
  cardStyles: {
    id: "card-styles",
    name: "Card styles",
    path: "components/dashboard/chrome.ts",
  },
  priceChart: {
    id: "price-chart",
    name: "PriceChart",
    path: "components/dashboard/PriceChart.tsx",
  },
  priceCard: {
    id: "price-card",
    name: "PriceCard",
    path: "components/dashboard/PriceCard.tsx",
  },
  gridCard: {
    id: "grid-card",
    name: "GridCard",
    path: "components/dashboard/GridCard.tsx",
  },
  strategyRail: {
    id: "strategy-rail",
    name: "StrategyRail",
    path: "components/dashboard/StrategyRail.tsx",
  },
  decisionFeed: {
    id: "decision-feed",
    name: "DecisionFeed",
    path: "components/dashboard/DecisionFeed.tsx",
  },
  deviceTable: {
    id: "device-table",
    name: "DeviceTable",
    path: "components/dashboard/DeviceTable.tsx",
  },

  section: {
    id: "section",
    name: "Section",
    path: "components/settings/Section.tsx",
  },
  editableList: {
    id: "editable-list",
    name: "EditableList",
    path: "components/settings/EditableList.tsx",
  },
  pvSection: {
    id: "pv-section",
    name: "PvSection",
    path: "components/settings/PvSection.tsx",
  },
  gridSection: {
    id: "grid-section",
    name: "GridSection",
    path: "components/settings/GridSection.tsx",
  },
  batteriesSection: {
    id: "batteries-section",
    name: "BatteriesSection",
    path: "components/settings/BatteriesSection.tsx",
  },
  pricesSection: {
    id: "prices-section",
    name: "PricesSection",
    path: "components/settings/PricesSection.tsx",
  },
  controlSection: {
    id: "control-section",
    name: "ControlSection",
    path: "components/settings/ControlSection.tsx",
  },
  curtailmentSection: {
    id: "curtailment-section",
    name: "CurtailmentSection",
    path: "components/settings/CurtailmentSection.tsx",
  },
} as const;

type EntryKey = keyof typeof ENTRIES;

const GROUPS: Array<{ id: string; title: string; keys: EntryKey[] }> = [
  { id: "group-chrome", title: "Chrome", keys: ["appHeader", "tokens"] },
  {
    id: "group-forms",
    title: "Form controls",
    keys: ["field", "entityAutocomplete", "eventNameField", "formStyles"],
  },
  {
    id: "group-live",
    title: "Live values",
    keys: ["measurement", "liveStatus", "liveHealthFacts", "diagnosticsBox"],
  },
  {
    id: "group-dashboard",
    title: "Dashboard",
    keys: [
      "icons",
      "statePill",
      "fillBar",
      "cardStyles",
      "priceChart",
      "priceCard",
      "gridCard",
      "strategyRail",
      "decisionFeed",
      "deviceTable",
    ],
  },
  {
    id: "group-settings",
    title: "Settings",
    keys: [
      "section",
      "editableList",
      "pvSection",
      "gridSection",
      "batteriesSection",
      "pricesSection",
      "controlSection",
      "curtailmentSection",
    ],
  },
];

/** Every `--color-*` in app.css, in the order that file declares them. */
const TOKENS: Array<{ group: string; names: string[] }> = [
  {
    group: "Surfaces",
    names: [
      "--color-bg",
      "--color-surface",
      "--color-surface-raised",
      "--color-surface-active",
    ],
  },
  {
    group: "Text and edges",
    names: [
      "--color-text",
      "--color-text-muted",
      "--color-border",
      "--color-border-strong",
    ],
  },
  {
    group: "Status",
    names: [
      "--color-danger",
      "--color-warning",
      "--color-success",
      "--color-focus",
      "--color-link",
    ],
  },
  {
    group: "The house",
    names: [
      "--color-pv",
      "--color-battery",
      "--color-import",
      "--color-export",
      "--color-chart-bar",
      "--color-chart-now",
    ],
  },
  {
    group: "Tints",
    names: [
      "--color-pv-soft",
      "--color-battery-soft",
      "--color-import-soft",
      "--color-export-soft",
      "--color-warning-soft",
    ],
  },
  { group: "Top bar", names: ["--color-header-bg", "--color-header-text"] },
];

export default function Playground({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const fixtures = playgroundFixtures(loaderData.now);
  const { settings, failures } = fixtures;

  return (
    <main className="page dash">
      <h1 style={pageTitleStyle}>Component playground</h1>
      <p style={{ ...hintStyle, maxWidth: "60ch", textWrap: "pretty" }}>
        Every component the add-on draws with, in the states that matter —
        including the ones a working installation never reaches. Nothing here
        reads or writes any settings: the data is made up, and the forms report
        what they would have posted instead of saving it.
      </p>

      <ViewportRuler />

      {actionData && <Posted fields={actionData.posted} />}

      <Index />

      <Group group={GROUPS[0]}>
        <Specimen
          {...ENTRIES.appHeader}
          note={
            <>
              Rendered once by <code>root.tsx</code> for every page, so it is
              already on screen — the blue bar at the top of this one. Shown
              here rather than drawn again because it is <code>sticky</code> and
              a second copy would fight the first for the same corner.
            </>
          }
        >
          <Variant label="Live, above">
            <p style={ruleStyle}>
              Its tab underline follows the route, so Home / Tools / Settings up
              there is the component's active state. This page is not one of its
              tabs, which is why none of the three is underlined right now.
            </p>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.tokens}
          note={
            <>
              The whole palette. Every colour in the app goes through one of
              these and never through a literal hex, which is what lets{" "}
              <code>light-dark()</code> switch the lot from the single{" "}
              <code>color-scheme</code> declaration. Switch Home Assistant — or
              the OS — between light and dark with this open: anything that
              stops being readable is a token that needs picking again.
            </>
          }
        >
          {TOKENS.map((group) => (
            <Variant key={group.group} label={group.group}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  gap: "0.5rem",
                }}
              >
                {group.names.map((name) => (
                  <Swatch key={name} name={name} />
                ))}
              </div>
            </Variant>
          ))}
        </Specimen>
      </Group>

      <Group group={GROUPS[1]}>
        <Specimen
          {...ENTRIES.field}
          note="A labelled input, with the hint replaced by the error when there is one — never both, so the row cannot grow a line as you fix it."
        >
          <Variant label="Text, with a hint">
            <Field
              name="playground-title"
              label="Title"
              placeholder="e.g. Home battery"
              hint="What this thing is called everywhere else."
            />
          </Variant>
          <Variant label="Number, with bounds">
            <Field
              name="playground-interval"
              label="Interval"
              type="number"
              defaultValue={5}
              min={1}
              max={3600}
              hint="Seconds between two passes of the loop."
            />
          </Variant>
          <Variant label="Rejected">
            <Field
              name="playground-capacity"
              label="Capacity (kWh)"
              type="number"
              defaultValue={0}
              error="Capacity has to be more than zero."
              hint="This hint is hidden while the error stands."
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.entityAutocomplete}
          note={
            <>
              The one specimen that talks to Home Assistant. It asks{" "}
              <code>/api/entities</code> as you type, so inside a real ingress
              panel it suggests your own sensors and outside one it shows the
              load failure — both of which are states worth seeing. The{" "}
              <code>domain</code> prop picks which half of the house it offers:
              readings by default, binary sensors for a field picking a state.
            </>
          }
        >
          <Variant label="Empty">
            <EntityAutocomplete
              name="playground-entity"
              label="Power — net grid exchange (W)"
              placeholder="e.g. sensor.grid_power"
              hint="Type to search; the list comes from Home Assistant."
            />
          </Variant>
          <Variant label="Pre-filled and rejected">
            <EntityAutocomplete
              name="playground-entity-error"
              label="Power — net grid exchange (W)"
              defaultValue="sensor.removed_months_ago"
              error="That entity no longer exists in Home Assistant."
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.eventNameField}
          note="Controlled, unlike Field: the event type an automation has to listen for is derived from the title as it is typed. Edit the second one and it warns that the rename breaks whatever was listening."
        >
          <Variant label="New battery">
            <EventNameField
              placeholder="e.g. Home battery"
              noun="battery"
              carries="target power"
              eventType={targetEventType}
            />
          </Variant>
          <Variant label="Renaming a saved array">
            <EventNameField
              defaultValue="Roof"
              savedTitle="Roof"
              placeholder="e.g. Roof"
              noun="PV array"
              carries="generation limit"
              eventType={pvLimitEventType}
            />
          </Variant>
          <Variant label="Rejected">
            <EventNameField
              defaultValue="home-battery"
              placeholder="e.g. Home battery"
              error="Another battery already makes the same event type."
              noun="battery"
              carries="target power"
              eventType={targetEventType}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.formStyles}
          note="Not components — the shared style objects every control above is built from. Here so a change to one can be seen against all of its users at once."
        >
          <Variant label="Specimens">
            <dl style={styleListStyle}>
              <StyleRow name="labelStyle">
                <span style={labelStyle}>Capacity (kWh)</span>
              </StyleRow>
              {/*
                `specimenInput` is the playground's own layout, not part of the
                style being shown: an input keeps a default intrinsic width of
                about 200px, and in the real forms it never matters because
                `fieldStyle` is a flex column that stretches it. Here it sits in
                a grid cell narrower than that on a phone, and without these two
                it pushes the page sideways.
              */}
              <StyleRow name="inputStyle(false)">
                <input
                  readOnly
                  value="sensor.grid_power"
                  style={{ ...inputStyle(false), ...specimenInput }}
                />
              </StyleRow>
              <StyleRow name="inputStyle(true)">
                <input
                  readOnly
                  value=""
                  style={{ ...inputStyle(true), ...specimenInput }}
                />
              </StyleRow>
              <StyleRow name="errorStyle">
                <p style={errorStyle}>Pick the grid power sensor.</p>
              </StyleRow>
              <StyleRow name="hintStyle">
                <p style={hintStyle}>Positive importing, negative exporting.</p>
              </StyleRow>
              <StyleRow name="headingStyle">
                <h5 style={headingStyle}>Batteries</h5>
              </StyleRow>
              <StyleRow name="pageTitleStyle">
                <span style={pageTitleStyle}>Settings</span>
              </StyleRow>
              {/*
                Two `cardStyle`s exist and they are not the same object: this
                one is the settings section's, and `chrome.ts` has the
                dashboard's under `Card styles` below. They agree today and
                both go through the same tokens; the difference is that this
                one carries its own padding.
              */}
              <StyleRow name="cardStyle">
                <div style={formCardStyle}>A settings section's card.</div>
              </StyleRow>
              <StyleRow name="linkButtonStyle(…)">
                <span
                  style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}
                >
                  <button
                    type="button"
                    style={linkButtonStyle("var(--color-text)")}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    style={linkButtonStyle("var(--color-danger)")}
                  >
                    Remove
                  </button>
                </span>
              </StyleRow>
              <StyleRow name="rowStyle">
                <div style={rowStyle}>One row of a list, with its rule.</div>
              </StyleRow>
            </dl>
          </Variant>
        </Specimen>
      </Group>

      <Group group={GROUPS[2]}>
        <Specimen
          {...ENTRIES.measurement}
          note="One reading with its label. Anything that is not a current value is drawn muted, so a sensor that died an hour ago cannot pass for a live number. Hover a value for when it last changed."
        >
          <Variant label="Every state">
            <div style={measurementRowStyle}>
              <Measurement label="Live" reading={fixtures.readings.live} />
              <Measurement
                label="Unchanged for hours"
                reading={fixtures.readings.stale}
              />
              <Measurement
                label="Unavailable"
                reading={fixtures.readings.unavailable}
              />
              <Measurement
                label="Entity is gone"
                reading={fixtures.readings.missing}
              />
              <Measurement
                label="Never read"
                reading={fixtures.readings.never}
              />
            </div>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.liveStatus}
          note="How the readings are arriving, in one line — quiet when all is well and wordy only when something is wrong. The relative times fill in after hydration, so they are blank for an instant on first paint by design."
        >
          <Variant label="Live, with recent changes">
            <LiveStatus health={fixtures.healths.live} streaming />
          </Variant>
          <Variant label="Live, quiet house">
            <LiveStatus health={fixtures.healths.quiet} streaming />
          </Variant>
          <Variant label="Connected, but the browser's stream isn't delivering">
            <LiveStatus health={fixtures.healths.live} streaming={false} />
          </Variant>
          <Variant label="Socket down">
            <LiveStatus
              health={fixtures.healths.reconnecting}
              streaming={false}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.liveHealthFacts}
          note="The detail behind that one line. Reconnects and the last error each earn their row only once there is one to show."
        >
          <Variant label="Healthy">
            <LiveHealthFacts health={fixtures.healths.live} />
          </Variant>
          <Variant label="After three drops">
            <LiveHealthFacts health={fixtures.healths.reconnecting} />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.diagnosticsBox}
          note={
            <>
              Polls <code>/api/diagnostics</code> every two seconds while it is
              open and costs nothing while it is closed. Opening one here shows
              the <em>real</em> log rather than the fixture — the fixture is
              only what the closed summary counts and what the first paint
              draws.
            </>
          }
        >
          <Variant label="Closed, under a feature's heading">
            <DiagnosticsBox
              origin="prices"
              initialEntries={fixtures.priceLog}
              subtitle="reading sensor.energi_epex_spot"
            />
          </Variant>
          <Variant label="Open, every origin, with extra detail above the log">
            <DiagnosticsBox
              initialEntries={fixtures.decisions}
              label="Entries"
              defaultOpen
            >
              <LiveHealthFacts health={fixtures.healths.live} />
            </DiagnosticsBox>
          </Variant>
        </Specimen>
      </Group>

      <Group group={GROUPS[3]}>
        <Specimen
          {...ENTRIES.icons}
          note="Inline SVG on a 24-unit grid, sized by the caller and coloured by currentColor. No emoji: those are a font away from being a different picture on every platform."
        >
          <Variant label="At 16, and at 28">
            <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
              {[16, 28].map((size) => (
                <div key={size} style={{ display: "flex", gap: "0.75rem" }}>
                  <SunIcon size={size} />
                  <BatteryIcon size={size} />
                  <ExchangeIcon size={size} />
                  <TagIcon size={size} />
                  <AlertIcon size={size} />
                </div>
              ))}
            </div>
          </Variant>
          <Variant label="Following the colour around them">
            <div
              style={{
                display: "flex",
                gap: "1rem",
                color: "var(--color-pv)",
              }}
            >
              <SunIcon size={20} />
              <span style={{ color: "var(--color-battery)" }}>
                <BatteryIcon size={20} />
              </span>
              <span style={{ color: "var(--color-danger)" }}>
                <AlertIcon size={20} />
              </span>
            </div>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.statePill}
          note="What a strategy is doing, in one word. The tone is the part that carries: filled means acting, outlined means armed with nothing to do, grey outlined means switched off — tellable apart without reading the word."
        >
          <Variant label="Every tone">
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <StatePill tone="pv">Curtailing</StatePill>
              <StatePill tone="battery">Discharging</StatePill>
              <StatePill tone="warn">Loop stopped</StatePill>
              <StatePill tone="idle">Armed</StatePill>
              <StatePill tone="off">Disabled</StatePill>
            </div>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.fillBar}
          note="A share of something, with a caption saying what. The caption is required rather than optional: the same bar shape is a published limit in one place and a state of charge in another."
        >
          <Variant label="Filled, empty, over, and nothing published">
            <div style={{ display: "grid", gap: "1rem", maxWidth: 320 }}>
              <FillBar
                percent={45}
                color="var(--color-pv)"
                label="Limit on Roof"
                caption="limit on Roof · 2,250 W of 5,000 W"
              />
              <FillBar
                percent={76}
                color="var(--color-battery)"
                label="Home battery state of charge"
                caption="Home battery · state of charge"
              />
              <FillBar
                percent={0}
                color="var(--color-battery)"
                label="Garage battery state of charge"
                caption="flat"
              />
              <FillBar
                percent={140}
                color="var(--color-export)"
                label="A sensor reporting more than full"
                caption="clamped: the fixture says 140%"
              />
              <FillBar
                percent={null}
                color="var(--color-pv)"
                label="Limit on Carport"
                caption="nothing published yet"
              />
            </div>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.cardStyles}
          note="The dashboard's shared style objects, the way form.ts holds the settings page's. Nothing but colour and type — every value is a token."
        >
          <Variant label="Specimens">
            <dl style={styleListStyle}>
              <StyleRow name="eyebrowStyle">
                <h5 style={eyebrowStyle}>
                  <TagIcon size={14} />
                  Price now
                </h5>
              </StyleRow>
              <StyleRow name="sectionLabelStyle">
                <h5 style={sectionLabelStyle}>Active strategies</h5>
              </StyleRow>
              <StyleRow name="monoStyle + unitStyle">
                <span style={{ ...monoStyle, fontSize: "2rem" }}>
                  -1,980
                  <span style={unitStyle}>W</span>
                </span>
              </StyleRow>
              <StyleRow name="ruleStyle">
                <p style={ruleStyle}>
                  Holding the arrays back whenever a kWh put on the grid earns
                  less than 0.0000 EUR/kWh.
                </p>
              </StyleRow>
              <StyleRow name="cardLinkStyle">
                <Link to="/settings" style={cardLinkStyle}>
                  Settings
                </Link>
              </StyleRow>
              <StyleRow name="captionStyle">
                <span style={captionStyle}>mean across 2 batteries</span>
              </StyleRow>
              <StyleRow name="tagStyle">
                <span style={tagStyle}>not curtailable</span>
              </StyleRow>
              <StyleRow name="accentTagStyle(…)">
                <span
                  style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                >
                  <span
                    style={accentTagStyle(
                      "var(--color-pv)",
                      "var(--color-pv-soft)",
                    )}
                  >
                    held at 45%
                  </span>
                  <span
                    style={accentTagStyle(
                      "var(--color-battery)",
                      "var(--color-battery-soft)",
                    )}
                  >
                    -1,980 W
                  </span>
                </span>
              </StyleRow>
              <StyleRow name="iconPlateStyle(…)">
                <span
                  style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                >
                  <span
                    style={iconPlateStyle(
                      "var(--color-pv)",
                      "var(--color-pv-soft)",
                    )}
                  >
                    <SunIcon size={16} />
                  </span>
                  <span
                    style={iconPlateStyle(
                      "var(--color-battery)",
                      "var(--color-battery-soft)",
                    )}
                  >
                    <BatteryIcon size={16} />
                  </span>
                </span>
              </StyleRow>
              <StyleRow name="cardStyle">
                <div style={{ ...cardStyle, padding: "0.75rem 1rem" }}>
                  A card on the page canvas.
                </div>
              </StyleRow>
            </dl>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.priceChart}
          note={
            <>
              Two plot geometries, not one scaled: the wide one is unreadable
              below about 560px, so the compact one draws a narrower plot and
              thins its labels. Both are shown here at once — the real card
              renders both and hides one with CSS. The wide one also redraws for
              the width it measures, so the two variants below are drawn at two
              different plot widths rather than one scaled to fit; resize the
              window and watch the axis labels stay the same size.
            </>
          }
        >
          <Variant label="Wide, threshold at 0" onCanvas>
            <PriceChart
              curve={fixtures.prices.curve}
              nowMinutes={fixtures.prices.nowMinutes}
              thresholdPerKwh={0}
              currency="EUR"
            />
          </Variant>
          <Variant label="Compact, threshold at 0.05" onCanvas>
            <div style={{ maxWidth: 300 }}>
              <PriceChart
                curve={fixtures.prices.curve}
                nowMinutes={fixtures.prices.nowMinutes}
                thresholdPerKwh={0.05}
                currency="EUR"
                compact
              />
            </div>
          </Variant>
          <Variant label="Nothing to draw" onCanvas>
            <PriceChart
              curve={[]}
              nowMinutes={null}
              thresholdPerKwh={0}
              currency="EUR"
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.priceCard}
          note="Splits into figures and chart above 1000px. Narrow the window past that to see the single-column version, and past 560px to see the chart swap geometry."
        >
          <Variant
            label="Selling price negative — the case curtailment exists for"
            onCanvas
          >
            <PriceCard
              prices={fixtures.priceStates.negative}
              thresholdPerKwh={0}
              thresholdDisplay="0.0000 EUR/kWh"
              strategyLabel="Graded export"
              curtailing
            />
          </Variant>
          <Variant label="Evening peak, curtailment switched off" onCanvas>
            <PriceCard
              prices={fixtures.priceStates.positive}
              thresholdPerKwh={0}
              thresholdDisplay="0.0000 EUR/kWh"
              strategyLabel={null}
              curtailing={false}
            />
          </Variant>
          <Variant label="The feed failed" onCanvas>
            <PriceCard
              prices={fixtures.priceStates.failed}
              thresholdPerKwh={0}
              thresholdDisplay="0.0000 EUR/kWh"
              strategyLabel={null}
              curtailing
            />
          </Variant>
          <Variant label="No source picked" onCanvas>
            <PriceCard
              prices={fixtures.priceStates.unconfigured}
              thresholdPerKwh={0}
              thresholdDisplay="0.0000 EUR/kWh"
              strategyLabel={null}
              curtailing={false}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.gridCard}
          note="The meter drawn against the deadband it is being judged by. The scale steps rather than glides, so the band holds still while the reading moves — compare the first two, which are the same deadband at two readings."
        >
          <Variant label="Importing, outside the deadband" onCanvas>
            <GridCard
              configured
              power={fixtures.gridStates.importing.power}
              powerW={fixtures.gridStates.importing.powerW}
              targetW={0}
              deadbandW={50}
              settleSeconds={30}
              minLimitPercent={5}
            />
          </Variant>
          <Variant label="Exporting, against a target of -200 W" onCanvas>
            <GridCard
              configured
              power={fixtures.gridStates.exporting.power}
              powerW={fixtures.gridStates.exporting.powerW}
              targetW={-200}
              deadbandW={50}
              settleSeconds={30}
              minLimitPercent={5}
            />
          </Variant>
          <Variant label="Sensor unreadable" onCanvas>
            <GridCard
              configured
              power={fixtures.gridStates.unreadable.power}
              powerW={null}
              targetW={0}
              deadbandW={50}
              settleSeconds={30}
              minLimitPercent={5}
            />
          </Variant>
          <Variant label="No sensor configured" onCanvas>
            <GridCard
              configured={false}
              power={null}
              powerW={null}
              targetW={0}
              deadbandW={50}
              settleSeconds={30}
              minLimitPercent={5}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.strategyRail}
          note={
            <>
              Both loops and the feed of what they decided, in one card. The
              summaries come from <code>dashboard-view.ts</code>, so these are
              the real rules applied to fixture readings rather than
              hand-written states. The feed inside it polls the live log — see
              DecisionFeed below.
            </>
          }
        >
          <Variant label="Both acting" onCanvas>
            <StrategyRail
              curtailment={{
                summary: curtailmentSummary(fixtures.arrays, {
                  enabled: true,
                  running: true,
                }),
                rule: (
                  <>
                    Holding the arrays back whenever a kWh put on the grid earns
                    less than <strong>0.0000 EUR/kWh</strong>, after 30 s off
                    target.
                  </>
                ),
              }}
              control={{
                summary: batteryControlSummary(fixtures.batteries, {
                  enabled: true,
                  running: true,
                }),
                rule: (
                  <>
                    Running the <strong>net-zero-energy</strong> strategy
                    whenever a reading changes, at most every 5 s.
                  </>
                ),
              }}
              initialEntries={fixtures.decisions}
            />
          </Variant>
          <Variant label="Both switched off" onCanvas>
            <StrategyRail
              curtailment={{
                summary: curtailmentSummary(fixtures.arrays, {
                  enabled: false,
                  running: false,
                }),
                rule: <>Switched off — no limit is published for any array.</>,
              }}
              control={{
                summary: batteryControlSummary(fixtures.batteries, {
                  enabled: false,
                  running: false,
                }),
                rule: (
                  <>Switched off — no target is published for any battery.</>
                ),
              }}
              initialEntries={[]}
            />
          </Variant>
          <Variant label="Enabled, but nothing is deciding" onCanvas>
            <StrategyRail
              curtailment={{
                summary: curtailmentSummary(fixtures.arrays, {
                  enabled: true,
                  running: false,
                }),
                rule: <>Enabled, but the loop is not running.</>,
              }}
              control={{
                summary: batteryControlSummary([], {
                  enabled: true,
                  running: true,
                }),
                rule: <>Enabled, with no battery to steer.</>,
              }}
              initialEntries={[]}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.decisionFeed}
          note={
            <>
              Polls <code>/api/diagnostics</code> on mount and every two seconds
              after, so the fixture below is replaced by the add-on's real log
              within a tick — on a machine that has decided nothing yet, that
              means the empty state. Below 640px it shows three rows and the
              link.
            </>
          }
        >
          <Variant label="With entries (until the first poll lands)" onCanvas>
            <div style={{ ...cardStyle, maxWidth: 340 }}>
              <DecisionFeed initialEntries={fixtures.decisions} />
            </div>
          </Variant>
          <Variant label="Nothing decided yet" onCanvas>
            <div style={{ ...cardStyle, maxWidth: 340 }}>
              <DecisionFeed initialEntries={[]} />
            </div>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.deviceTable}
          note="Two renderings with one hidden: a real table above 620px and a list of rows below it. Narrow the window past that line to swap them — restyling the table with `display` would have kept the markup and thrown the semantics away."
        >
          <Variant label="Arrays and batteries, mixed states" onCanvas>
            <DeviceTable
              arrays={fixtures.arrays}
              batteries={fixtures.batteries}
            />
          </Variant>
          <Variant label="Nothing configured" onCanvas>
            <DeviceTable arrays={[]} batteries={[]} />
          </Variant>
        </Specimen>
      </Group>

      <Group group={GROUPS[4]}>
        <p style={{ ...hintStyle, textWrap: "pretty" }}>
          These post to this page rather than to <code>/settings</code>, so
          Save, Add and Remove change nothing — the panel above the index
          reports what the form carried. The pending states are real: submitting
          one form puts every section on the page into "Saving…", because{" "}
          <code>useNavigation</code> describes the page and not the form.
        </p>

        <Specimen
          {...ENTRIES.section}
          note="The heading, the paragraph under it, and the + that opens a section's add form."
        >
          <Variant label="With an add toggle" onCanvas>
            <SectionDemo />
          </Variant>
          <Variant label="Heading only" onCanvas>
            <Section title="Grid">
              <p style={hintStyle}>
                A section with no description and no add button.
              </p>
            </Section>
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.editableList}
          note={
            <>
              The add / edit / remove mechanics the PV and battery sections
              share; only the fields and the summary line differ between them.
              Which row is open is the caller's state, held here by{" "}
              <code>useSectionEditor</code>'s equivalent — click Edit and Add to
              drive it.
            </>
          }
        >
          <Variant label="Two records" onCanvas>
            <EditableListDemo />
          </Variant>
          <Variant label="Empty" onCanvas>
            <EditableList
              records={[]}
              intent="playground-empty"
              emptyMessage="No records yet."
              showAdd={false}
              onCloseAdd={() => {}}
              editingId={null}
              onEdit={() => {}}
              renderSummary={() => null}
              renderFields={() => null}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.pvSection}
          note="Arrays, each with a rating and whether curtailment may hold it back. The second fixture is watched but not steerable, which the summary line says outright."
        >
          <Variant label="Two arrays" onCanvas>
            <PvSection pvEntities={settings.pvEntities} />
          </Variant>
          <Variant label="None yet, with the add form rejected" onCanvas>
            <PvSection pvEntities={[]} actionData={failures.pv} />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.gridSection}
          note="One field, and the longest description on the settings page — the sign convention is the thing everything else is written against."
        >
          <Variant label="Configured" onCanvas>
            <GridSection grid={settings.grid} />
          </Variant>
          <Variant label="Rejected" onCanvas>
            <GridSection grid={settings.emptyGrid} actionData={failures.grid} />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.batteriesSection}
          note="The widest form in the app: a charge window, two optional power caps, three entities and the event name."
        >
          <Variant label="Two batteries" onCanvas>
            <BatteriesSection batteries={settings.batteries} />
          </Variant>
          <Variant label="None yet, with the add form rejected" onCanvas>
            <BatteriesSection batteries={[]} actionData={failures.battery} />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.pricesSection}
          note="The formula preview runs the same evaluator the server will, in the browser, as you type — so editing a formula here really does re-cost the fixture's spot price."
        >
          <Variant label="Reading a Home Assistant sensor" onCanvas>
            <PricesSection
              config={settings.prices}
              summary={settings.priceSummary}
            />
          </Variant>
          <Variant
            label="Source picked, but the read failed, and a formula was rejected"
            onCanvas
          >
            <PricesSection
              config={settings.prices}
              summary={settings.failedPriceSummary}
              actionData={failures.prices}
            />
          </Variant>
          <Variant
            label="Switched off — the rest of the form hides itself"
            onCanvas
          >
            <PricesSection
              config={{ ...settings.prices, source: "none" }}
              summary={settings.noPriceSummary}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.controlSection}
          note="Enabling is blocked until at least one battery is steered, because a loop that decides correctly and commands nothing looks exactly like a broken one from outside."
        >
          <Variant label="Ready and enabled" onCanvas>
            <ControlSection
              config={settings.control}
              ready={{ grid: true, batteries: true, steerable: true }}
            />
          </Variant>
          <Variant label="Nothing configured yet" onCanvas>
            <ControlSection
              config={{ ...settings.control, enabled: false }}
              ready={{ grid: false, batteries: false, steerable: false }}
            />
          </Variant>
          <Variant label="Rejected interval" onCanvas>
            <ControlSection
              config={settings.control}
              ready={{ grid: true, batteries: true, steerable: true }}
              actionData={failures.control}
            />
          </Variant>
        </Specimen>

        <Specimen
          {...ENTRIES.curtailmentSection}
          note="Picking a strategy other than Threshold reveals the band editor — three rows sharing one set of bands, so switching between the two graded strategies keeps whatever was tuned."
        >
          <Variant label="Graded export, enabled" onCanvas>
            <CurtailmentSection
              config={settings.curtailment}
              ready={{ grid: true, arrays: true, prices: true }}
            />
          </Variant>
          <Variant label="Threshold only, with nothing in place" onCanvas>
            <CurtailmentSection
              config={{
                ...settings.curtailment,
                enabled: false,
                strategy: "threshold",
              }}
              ready={{ grid: false, arrays: false, prices: false }}
            />
          </Variant>
          <Variant label="Rejected" onCanvas>
            <CurtailmentSection
              config={settings.curtailment}
              ready={{ grid: true, arrays: true, prices: true }}
              actionData={failures.curtailment}
            />
          </Variant>
        </Specimen>
      </Group>
    </main>
  );
}

/** The jump list. Fragment-only hrefs, so ingress has no prefix to get wrong. */
function Index() {
  return (
    <nav
      aria-label="Components"
      style={{ ...cardStyle, padding: "1rem 1.125rem" }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
        }}
      >
        {GROUPS.map((group) => (
          <div key={group.id}>
            <h2 style={eyebrowStyle}>{group.title}</h2>
            <ul
              style={{
                listStyle: "none",
                margin: "0.5rem 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "0.2rem",
              }}
            >
              {group.keys.map((key) => (
                <li key={key}>
                  <a
                    href={`#${ENTRIES[key].id}`}
                    style={{ ...cardLinkStyle, fontSize: "0.8125rem" }}
                  >
                    {ENTRIES[key].name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function Group({
  group,
  children,
}: {
  group: (typeof GROUPS)[number];
  children: ReactNode;
}) {
  return (
    <section
      id={group.id}
      style={{
        scrollMarginTop: 80,
        display: "flex",
        flexDirection: "column",
        gap: "1.125rem",
      }}
    >
      <h2 style={{ ...sectionLabelStyle, marginTop: "0.75rem" }}>
        {group.title}
      </h2>
      {children}
    </section>
  );
}

/** What the last form posted, so a submission is visibly absorbed rather than lost. */
function Posted({ fields }: { fields: string[] }) {
  return (
    <div
      style={{
        ...cardStyle,
        padding: "0.75rem 1rem",
        borderColor: "var(--color-border-strong)",
      }}
    >
      <p style={{ ...eyebrowStyle, marginBottom: "0.4rem" }}>
        Posted — and discarded
      </p>
      <ul
        style={{
          ...monoStyle,
          listStyle: "none",
          margin: 0,
          padding: 0,
          fontSize: "0.75rem",
          lineHeight: 1.6,
        }}
      >
        {fields.map((field) => (
          <li key={field} style={{ wordBreak: "break-all" }}>
            {field}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Swatch({ name }: { name: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          flex: "none",
          borderRadius: 6,
          background: `var(${name})`,
          // So a token that resolves to the page's own background is still a
          // visible square rather than a hole.
          border: "1px solid var(--color-border-strong)",
        }}
      />
      <code style={{ fontSize: "0.6875rem", border: "none", padding: 0 }}>
        {name}
      </code>
    </div>
  );
}

function StyleRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ ...monoStyle, ...captionStyle }}>{name}</dt>
      <dd style={{ margin: 0, minWidth: 0 }}>{children}</dd>
    </>
  );
}

/** `Section`'s add toggle needs somewhere to keep its open state. */
function SectionDemo() {
  const [open, setOpen] = useState(false);

  return (
    <Section
      title="PV arrays"
      description="Each inverter or string you want watched. The rating and the curtailable box are what let this array be held back."
      add={{
        label: "Add a PV array",
        open,
        onToggle: () => setOpen((was) => !was),
      }}
    >
      <p style={{ ...hintStyle, marginTop: "0.75rem" }}>
        {open
          ? "Open — a real section would render its add form here."
          : "Closed. The + above is the toggle."}
      </p>
    </Section>
  );
}

type DemoRecord = { id: string; label: string };

const DEMO_RECORDS: DemoRecord[] = [
  { id: "first", label: "Roof" },
  { id: "second", label: "Carport" },
];

/**
 * The list with its editor state, which the real sections keep in
 * `useSectionEditor` — the one module under `components/` with no specimen of
 * its own, because a hook has nothing to draw.
 */
function EditableListDemo() {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Section
      title="Records"
      add={{
        label: "Add a record",
        open: showAdd,
        onToggle: () => setShowAdd((was) => !was),
      }}
    >
      <EditableList
        records={DEMO_RECORDS}
        intent="playground"
        emptyMessage="Nothing here yet."
        showAdd={showAdd}
        onCloseAdd={() => setShowAdd(false)}
        editingId={editingId}
        onEdit={setEditingId}
        renderSummary={(record) => (
          <>
            <strong>{record.label}</strong>
            <p style={hintStyle}>sensor.{record.id}_power</p>
          </>
        )}
        renderFields={(record) => (
          <Field
            name="label"
            label="Label"
            defaultValue={record?.label}
            placeholder="e.g. Roof"
          />
        )}
      />
    </Section>
  );
}

const measurementRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1.5rem",
};

/** See the note beside the two `inputStyle` specimens. */
const specimenInput: CSSProperties = {
  width: "100%",
  // `inputStyle` sets padding and a border and the app declares no global
  // `box-sizing`, so a plain `width: 100%` would overflow its cell by both.
  boxSizing: "border-box",
};

const styleListStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, auto) minmax(0, 1fr)",
  alignItems: "center",
  gap: "0.75rem 1rem",
  margin: 0,
};
