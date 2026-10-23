<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import type { ComparisonOptions, compare } from "../lib/comparison";
import { exportedBattery } from "../lib/comparison";
import type { PlannerDataset } from "../lib/planner";
import { parseDataset } from "../lib/planner";
import type { PlannerPreset } from "../lib/presets";
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import { presets } from "../lib/presets";

const dataset = shallowRef<PlannerDataset>();
const comparison = shallowRef<Awaited<ReturnType<typeof compare>>>();
/** The exported battery's own modes, which is what Home Assistant planned with. */
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const battery = computed(() =>
  dataset.value ? exportedBattery(dataset.value) : undefined,
);
/** Every registered strategy that produced a schedule, in registry order. */
const scored = computed(
  () => comparison.value?.runs.filter((run) => run.scenarios) ?? [],
);
const options = ref<ComparisonOptions>({
  capabilities: "expanded",
  setpointStepW: 100,
  timeLimitSeconds: 30,
});
const error = ref("");
const busy = ref(false);
const filename = ref("");
const presetKey = ref("");
const fileInput = ref<HTMLInputElement>();
const settings = ref({
  deadline: "",
  targetSoc: 100,
  solarHaircut: 0.2,
  switchCost: 0.002,
  passes: 4,
  spikeBufferKwh: 0.54,
});
let worker: Worker | undefined;
let importSequence = 0;
let runSequence = 0;
function stop() {
  runSequence++;
  worker?.terminate();
  worker = undefined;
  busy.value = false;
}
onBeforeUnmount(() => {
  importSequence++;
  stop();
});
// The tables are wider than the page and scroll sideways, and a box that
// scrolls sideways is what `position: sticky` binds to — so a sticky heading
// would only pin to the top of a box that never scrolls vertically. Capping the
// box's height instead gave every table a scrollbar of its own. Rather than
// either, the headings follow the page: on each scroll, each table's heading
// cells are shifted down to sit under the fixed nav, until its table's last row passes.
const root = ref<HTMLElement>();
function pinHeadings() {
  const top = Math.max(
    0,
    ...[...document.querySelectorAll(".VPNav, .VPLocalNav")].map(
      (bar) => bar.getBoundingClientRect().bottom,
    ),
  );
  for (const box of root.value?.querySelectorAll(".planner-table") ?? []) {
    const head = box.querySelector("thead");
    const body = box.querySelector("tbody");
    if (!head || !body) continue;
    // The cells are what move — a shifted thead left a band of its own text
    // behind in Chrome — so the thead's box still marks where they belong.
    const from = head.getBoundingClientRect().top;
    const shift = Math.min(
      Math.max(top - from, 0),
      Math.max(
        body.getBoundingClientRect().bottom - from - head.offsetHeight,
        0,
      ),
    );
    for (const cell of head.querySelectorAll("th"))
      cell.style.transform = shift ? `translateY(${shift}px)` : "";
  }
}
onMounted(() => {
  addEventListener("scroll", pinHeadings, { passive: true });
  addEventListener("resize", pinHeadings, { passive: true });
  // Opening the side-by-side details or loading a run moves the tables.
  root.value?.addEventListener("toggle", pinHeadings, true);
});
onBeforeUnmount(() => {
  removeEventListener("scroll", pinHeadings);
  removeEventListener("resize", pinHeadings);
});
function invalidate() {
  stop();
  comparison.value = undefined;
  error.value = "";
}
function load(parsed: PlannerDataset, name: string) {
  dataset.value = parsed;
  settings.value = {
    targetSoc: parsed.model.maxSoc,
    solarHaircut: parsed.settings.solarHaircut,
    switchCost: parsed.settings.switchCost,
    passes: parsed.settings.passes,
    deadline: new Date(parsed.settings.deadline).toISOString(),
    spikeBufferKwh: parsed.settings.spikeBufferKwh ?? 0.54,
  };
  // Start from what Home Assistant planned with when the export says so.
  options.value.capabilities = exportedBattery(parsed) ? "battery" : "expanded";
  filename.value = name;
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const sequence = ++importSequence;
  invalidate();
  dataset.value = undefined;
  filename.value = "";
  presetKey.value = "";
  try {
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Please choose a JSON export smaller than 10 MB.");
    const parsed = parseDataset(JSON.parse(await file.text()));
    if (sequence !== importSequence) return;
    load(parsed, file.name);
    run();
  } catch (e) {
    if (sequence === importSequence)
      error.value = e instanceof Error ? e.message : String(e);
  }
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function loadPreset(preset: PlannerPreset) {
  // Supersede a file import still being read, exactly as a new import would.
  importSequence++;
  invalidate();
  if (fileInput.value) fileInput.value.value = "";
  try {
    // Clone so edits in the form never reach the shared preset object.
    load(parseDataset(structuredClone(preset.dataset)), preset.name);
    presetKey.value = preset.key;
    run();
  } catch (e) {
    dataset.value = undefined;
    filename.value = "";
    presetKey.value = "";
    error.value = e instanceof Error ? e.message : String(e);
  }
}
function run() {
  invalidate();
  try {
    const input = parseDataset({
      ...dataset.value,
      settings: { ...settings.value },
    });
    worker = new Worker(new URL("../lib/planner.worker.ts", import.meta.url), {
      type: "module",
    });
    busy.value = true;
    const sequence = runSequence;
    worker.onmessage = ({ data }) => {
      if (sequence !== runSequence) return;
      comparison.value = data.comparison;
      error.value = data.error ?? "";
      stop();
    };
    worker.onerror = () => {
      if (sequence !== runSequence) return;
      error.value =
        "The planning worker failed. Check the inputs and try again.";
      stop();
    };
    worker.postMessage({ dataset: input, options: { ...options.value } });
  } catch (e) {
    stop();
    error.value = e instanceof Error ? e.message : String(e);
  }
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function time(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: dataset.value?.timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function intervalTime(start: number, end: number) {
  const timeZone = dataset.value?.timeZone;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  });
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const offset = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const zone = (value: number) =>
    offset.formatToParts(value).find((p) => p.type === "timeZoneName")?.value;
  const changesOffset = zone(start) !== zone(end);
  const from = `${date.format(start)}, ${clock.format(start)}${changesOffset ? ` ${zone(start)}` : ""}`;
  const to = `${day.format(start) === day.format(end) ? "" : `${date.format(end)}, `}${clock.format(end)}${changesOffset ? ` ${zone(end)}` : ""}`;
  return `${from} – ${to}`;
}
// Plot area of the SoC chart, in viewBox units: x 40–520, y 200 (0%) to 20
// (100%). The 200 units right of it hold each line's direct label, which is
// long enough for "HiGHS cost optimizer 100%".
const VIEW_WIDTH = 720;
const PLOT_LEFT = 40;
const PLOT_RIGHT = 520;
function plotX(i: number, count: number) {
  return PLOT_LEFT + (i / Math.max(1, count - 1)) * (PLOT_RIGHT - PLOT_LEFT);
}
function plotY(soc: number) {
  return 200 - soc * 1.8;
}
function polyline(socs: number[]) {
  return socs
    .map((soc, i) => `${plotX(i, socs.length)},${plotY(soc)}`)
    .join(" ");
}
/**
 * A strategy's colour follows its place in the registry, never its rank, so a
 * rerun that reorders the scoreboard repaints nothing. Slots in `--series-*`.
 */
function series(id: string) {
  const slot = comparison.value?.runs.findIndex((run) => run.id === id) ?? 0;
  return `var(--planner-series-${(slot % 8) + 1})`;
}
// The scenario table's row groups, each labelled with its solar adjustment.
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const replays = computed(() => {
  const margin = Math.round((comparison.value?.input.solarHaircut ?? 0) * 100);
  const group = (
    name: string,
    pick: (run: (typeof scored.value)[number]) => typeof run.excess,
  ) => ({
    name,
    rows: scored.value.flatMap((run) => {
      const result = pick(run);
      return result ? [{ id: run.id, label: run.label, result }] : [];
    }),
  });
  return [
    group("Nominal", (run) => run.scenarios?.[0]),
    group(`Reduced solar (−${margin}%)`, (run) => run.scenarios?.[1]),
    group(`Excess solar (+${margin}%)`, (run) => run.excess),
  ];
});
// Every strategy's nominal SoC on one chart, each labelled at its end. Labels
// are nudged apart so two plans ending at the same SoC stay readable.
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const chart = computed(() => {
  const lines = scored.value.flatMap((run) => {
    const nominal = run.scenarios?.[0];
    if (!nominal) return [];
    return {
      id: run.id,
      name: run.label,
      color: series(run.id),
      socs: nominal.points.map((p) => p.soc),
      curve: polyline(nominal.points.map((p) => p.soc)),
      finalSoc: nominal.finalSoc,
      labelY: plotY(nominal.finalSoc) + 4,
    };
  });
  const byY = [...lines].sort((a, b) => a.labelY - b.labelY);
  for (const [i, line] of byY.entries())
    if (i) line.labelY = Math.max(line.labelY, byY[i - 1].labelY + 14);
  // Then back up from the axis labels, for plans that all end near empty.
  for (let i = byY.length - 1; i >= 0; i--)
    byY[i].labelY = Math.min(
      byY[i].labelY,
      i === byY.length - 1 ? 204 : byY[i + 1].labelY - 14,
    );
  // The unrestricted baseline is the same battery left alone, whoever plans.
  const baseline = scored.value[0]?.result?.plan.points.map(
    (p) => p.baselineSoc,
  );
  return { lines, baseline: baseline ? polyline(baseline) : "" };
});
// The hovered interval on the chart, for its crosshair and readout.
const hover = ref<number>();
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function track(event: PointerEvent) {
  const svg = event.currentTarget as SVGSVGElement;
  const box = svg.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * VIEW_WIDTH;
  const count = comparison.value?.input.slots.length ?? 0;
  if (!count || x < PLOT_LEFT - 10 || x > PLOT_RIGHT + 10) {
    hover.value = undefined;
    return;
  }
  hover.value = Math.max(
    0,
    Math.min(
      count - 1,
      Math.round(
        ((x - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)) * Math.max(1, count - 1),
      ),
    ),
  );
}
/**
 * One row per strategy, cheapest mean cost first; a strategy that failed on
 * this snapshot keeps its row at the foot, so it never silently disappears.
 */
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const board = computed(() => {
  const runs = comparison.value?.runs ?? [];
  const ranked = runs
    .filter((run) => run.meanCost !== undefined)
    .sort((a, b) => (a.meanCost ?? 0) - (b.meanCost ?? 0));
  const best = ranked[0]?.meanCost ?? 0;
  return [
    ...ranked.map((run, i) => ({
      run,
      rank: i + 1,
      delta: (run.meanCost ?? 0) - best,
    })),
    ...runs
      .filter((run) => run.meanCost === undefined)
      .map((run) => ({ run, rank: undefined, delta: undefined })),
  ];
});
/**
 * The interval table carries six columns per strategy, so past two it is a
 * wall. Two cheapest by default; any set can be ticked.
 */
const tableIds = ref<string[]>([]);
watch(comparison, () => {
  tableIds.value = [...scored.value]
    .sort((a, b) => (a.meanCost ?? 0) - (b.meanCost ?? 0))
    .slice(0, 2)
    .map((run) => run.id);
});
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const tabled = computed(() =>
  scored.value.filter((run) => tableIds.value.includes(run.id)),
);
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function axisTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: dataset.value?.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
function download() {
  if (!dataset.value || !comparison.value) return;
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            dataset: { ...dataset.value, settings: settings.value },
            strategies: comparison.value?.runs.map((run) => run.id),
            comparison: comparison.value,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "planner-result.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section ref="root" class="planner" aria-label="Planner sandbox">
    <label>Import planner export <input ref="fileInput" type="file" accept=".json,application/json" @change="importFile" /></label>
    <fieldset class="planner-presets">
      <legend>Or load a synthetic preset</legend>
      <div class="planner-preset" v-for="preset in presets" :key="preset.key">
        <button type="button" :aria-pressed="presetKey === preset.key" :aria-describedby="`preset-${preset.key}`" @click="loadPreset(preset)">{{ preset.name }}</button>
        <p :id="`preset-${preset.key}`">{{ preset.description }}</p>
      </div>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="dataset">
      <h2>{{ dataset.id }}</h2>
      <p>{{ filename }} · {{ dataset.slots.length }} intervals · {{ dataset.model.capacityKwh }} kWh · Initial SoC {{ dataset.model.soc }}% · {{ dataset.timeZone }}</p>
      <p>{{ time(dataset.slots[0].start) }} – {{ time(dataset.slots.at(-1)!.end) }}</p>
      <details><summary>Imported assumptions, devices and model</summary>
        <ul><li v-for="(assumption, i) in dataset.assumptions" :key="i">{{ assumption }}</li></ul>
        <pre>{{ JSON.stringify({ model: dataset.model, devices: dataset.devices, context: dataset.context }, null, 2) }}</pre>
      </details>
      <form @submit.prevent="run" @input="invalidate" @change="invalidate">
        <div class="planner-fields">
          <label>Evening target deadline<select v-model="settings.deadline"><option v-for="slot in dataset.slots" :key="slot.end" :value="new Date(slot.end).toISOString()">{{ time(slot.end) }}</option></select></label>
          <p>Evening target only: configured maximum SoC {{ dataset.model.maxSoc }}% (imported target {{ dataset.settings.targetSoc }}%).</p>
          <label>Solar reduction (0–1)<input v-model.number="settings.solarHaircut" type="number" min="0" max="0.999" step="any" required /></label>
          <label>Cost per limit change<input v-model.number="settings.switchCost" type="number" min="0" step="any" required /></label>
          <label>Search passes<input v-model.number="settings.passes" type="number" min="1" max="20" required /></label>
          <label>Spike buffer (kWh)<input v-model.number="settings.spikeBufferKwh" type="number" min="0" step="any" required /></label>
        </div>
        <fieldset>
          <legend>Capabilities for every strategy</legend>
          <label>Comparison<select aria-label="Comparison capabilities" v-model="options.capabilities"><option v-if="battery" value="battery">As in Home Assistant: {{ battery.controlModes.join(", ") }}</option><option value="balance">Balance + existing boundaries</option><option value="expanded">Expanded: assume all four modes</option></select></label>
          <p v-if="options.capabilities === 'battery'">The modes ticked for this battery in Settings, which is what the add-on planned with. Charge allows grid charging and discharge allows battery export; setpoints in its {{ battery?.powerStepW }} W power step.</p>
          <p v-else-if="!battery">This export does not record the battery's modes, so what Home Assistant would plan with is unknown.</p>
          <template v-if="options.capabilities === 'expanded'">
            <p>Hypothetical direct control with signed AC setpoints and native SoC protection. Grid charging and battery export are always permitted in this expanded simulation. No device compatibility is inferred from limit entities.</p>
            <label>Assumed setpoint step (W)<input v-model.number="options.setpointStepW" type="number" min="1" required /></label>
          </template>
          <label>Solver budget (seconds)<input v-model.number="options.timeLimitSeconds" type="number" min="1" max="120" required /></label>
        </fieldset>
        <button type="submit" :disabled="busy">{{ busy ? "Calculating…" : "Compare strategies" }}</button>
        <button v-if="busy" type="button" @click="stop">Cancel</button>
      </form>
      <p role="status" aria-live="polite">{{ busy ? "Running every registered strategy in a local worker…" : comparison ? "Comparison calculated." : "Ready to calculate." }}</p>
    </template>
    <template v-if="comparison">
      <h2>Strategy comparison</h2>
      <div class="planner-table" tabindex="0" role="region" aria-label="Strategy scoreboard">
        <table>
          <thead><tr><th scope="col">Rank</th><th scope="col">Strategy</th><th scope="col">Mean cost</th><th scope="col">vs best</th><th scope="col">Nominal</th><th scope="col">Reduced solar</th><th scope="col">Excess solar</th><th scope="col">Final SoC<br />nominal / reduced</th><th scope="col">Runtime</th><th scope="col">Status</th></tr></thead>
          <tbody>
            <tr v-for="row in board" :key="row.run.id" :class="{ 'planner-best': row.rank === 1 }">
              <td>{{ row.rank ?? "—" }}</td>
              <th scope="row"><span class="planner-swatch" :style="{ background: series(row.run.id) }" aria-hidden="true"></span>{{ row.run.label }}</th>
              <template v-if="row.run.scenarios">
                <td>{{ row.run.meanCost!.toFixed(3) }}</td>
                <td>{{ row.rank === 1 ? "best" : `+${row.delta!.toFixed(3)}` }}</td>
                <td>{{ row.run.scenarios[0].cost.toFixed(3) }}</td>
                <td>{{ row.run.scenarios[1].cost.toFixed(3) }}</td>
                <td>{{ row.run.excess!.cost.toFixed(3) }}</td>
                <td>{{ row.run.scenarios[0].finalSoc.toFixed(1) }}% / {{ row.run.scenarios[1].finalSoc.toFixed(1) }}%</td>
              </template>
              <td v-else colspan="6">—</td>
              <td>{{ row.run.runtimeMs.toFixed(0) }} ms</td>
              <td class="planner-status">{{ row.run.error ?? row.run.result?.status }}<template v-if="row.run.result?.notes.length"> · {{ row.run.result.notes.join(" ") }}</template></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Costs in {{ dataset!.currency }}, including battery wear. Ranked by mean cost over nominal and reduced solar, which is what every strategy is scored on; excess solar is reported only. Mean cost puts no value on energy left at the end, so read final SoC beside it: a plan that ends fuller has kept something back for after the horizon.</p>
      <figure v-if="chart.lines.length" class="planner-chart">
        <h3>Battery SoC at nominal solar</h3>
        <ul class="planner-legend">
          <li v-for="line in chart.lines" :key="line.id"><span class="planner-swatch" :style="{ background: line.color }" aria-hidden="true"></span>{{ line.name }}</li>
          <li><span class="planner-swatch planner-swatch-dashed" aria-hidden="true"></span>Unrestricted baseline</li>
        </ul>
        <svg :viewBox="`0 0 ${VIEW_WIDTH} 230`" role="img" :aria-label="`End-of-interval battery state of charge for ${chart.lines.map(l => l.name).join(', ')}; dashed unrestricted baseline. Exact values are in the scoreboard and the interval table.`" @pointermove="track" @pointerleave="hover = undefined">
          <g class="planner-grid"><line v-for="soc in [0, 50, 100]" :key="soc" :x1="PLOT_LEFT" :y1="plotY(soc)" :x2="PLOT_RIGHT" :y2="plotY(soc)" /></g>
          <text v-for="soc in [0, 50, 100]" :key="soc" x="34" :y="plotY(soc) + 4" text-anchor="end">{{ soc }}%</text>
          <text :x="PLOT_LEFT" y="222">{{ axisTime(dataset!.slots[0].start) }}</text>
          <text :x="PLOT_RIGHT" y="222" text-anchor="end">{{ axisTime(dataset!.slots.at(-1)!.end) }}</text>
          <polyline :points="chart.baseline" fill="none" stroke="currentColor" stroke-dasharray="6 5" stroke-width="1.5" />
          <polyline v-for="line in chart.lines" :key="line.id" :points="line.curve" fill="none" :stroke="line.color" stroke-width="2" stroke-linejoin="round" />
          <g v-for="line in chart.lines" :key="line.id">
            <line :x1="PLOT_RIGHT + 6" :y1="line.labelY - 4" :x2="PLOT_RIGHT + 18" :y2="line.labelY - 4" :stroke="line.color" stroke-width="2" />
            <text class="planner-label" :x="PLOT_RIGHT + 22" :y="line.labelY">{{ line.name }} {{ line.finalSoc.toFixed(0) }}%</text>
          </g>
          <template v-if="hover !== undefined">
            <line class="planner-crosshair" :x1="plotX(hover, comparison.input.slots.length)" y1="20" :x2="plotX(hover, comparison.input.slots.length)" y2="200" />
            <circle v-for="line in chart.lines" :key="line.id" :cx="plotX(hover, comparison.input.slots.length)" :cy="plotY(line.socs[hover])" r="4" :fill="line.color" class="planner-dot" />
          </template>
        </svg>
        <figcaption>
          <template v-if="hover !== undefined">{{ intervalTime(comparison.input.slots[hover].start, comparison.input.slots[hover].end) }}: <template v-for="(line, i) in chart.lines" :key="line.id">{{ i ? " · " : "" }}{{ line.name }} {{ line.socs[hover].toFixed(1) }}%</template></template>
          <template v-else>End-of-interval SoC: solid lines are each strategy's plan, dashed is the battery left to its own self-consumption. Hover for every strategy's value at one interval.</template>
        </figcaption>
      </figure>
      <details class="planner-details"><summary>Per-scenario detail, with PV generated and curtailed</summary>
        <div class="planner-table" tabindex="0">
          <table><thead><tr><th>Scenario</th><th>Strategy</th><th>Cost incl. wear</th><th>Final SoC</th><th>PV generated / curtailed kWh</th></tr></thead>
            <tbody><template v-for="scenario in replays" :key="scenario.name">
              <tr v-for="(row, j) in scenario.rows" :key="row.id"><th v-if="j === 0" scope="rowgroup" :rowspan="scenario.rows.length">{{ scenario.name }}</th><td>{{ row.label }}</td><td>{{ row.result.cost.toFixed(3) }}</td><td>{{ row.result.finalSoc.toFixed(1) }}%</td><td>{{ row.result.generatedKwh.toFixed(2) }} / {{ row.result.curtailedKwh.toFixed(2) }}</td></tr>
            </template></tbody>
          </table>
        </div>
      </details>
      <p>Every registered strategy plans the same snapshot under the same capabilities and is scored by the same physical replay, for nominal and reduced solar: import charges minus export revenue plus battery wear. Excess solar replays the same schedule with solar raised by the same margin, to show what each plan leaves on the table on a sunnier day; it is reported only, and no strategy plans for it. Evening target keeps balance mode and aims for its deadline and reserve; HiGHS minimizes that mean cost directly and, at equal cost, prefers balance, with no evening target or terminal-reserve value, so a lower final SoC can explain a lower cost. Dynamic programming minimizes the same cost over a grid of battery levels and values the terminal reserve like Evening target does, so it ends fuller when the add-on expects demand before solar recovers. These are forecast simulations, not measured savings, and costs exclude Evening target’s switching and buffer penalties.</p>
      <template v-if="scored.length">
        <h3>Interval controls and predictions (nominal)</h3>
        <p>Times are in {{ dataset!.timeZone }}. Prices are the snapshot’s configured consumption/import and production/export tariffs, including pricing formulas—not raw EPEX spot prices. Expected load and solar are the snapshot’s forecasts, before curtailment and the solar reduction. Positive battery power means charging; negative means discharging. “—” means balance has no requested setpoint. Balance only moves the battery within its limits: with a 0 W discharge limit it cannot discharge, so check predicted battery power rather than the mode alone.</p>
        <button type="button" @click="download">Download inputs and every strategy’s result</button>
        <fieldset class="planner-picker">
          <legend>Strategies in the interval table</legend>
          <label v-for="run in scored" :key="run.id"><input v-model="tableIds" type="checkbox" :value="run.id" /><span class="planner-swatch" :style="{ background: series(run.id) }" aria-hidden="true"></span>{{ run.label }}</label>
        </fieldset>
        <div class="planner-table" tabindex="0" role="region" aria-label="Side-by-side interval comparison"><table>
          <thead>
            <tr>
              <th scope="col" rowspan="2">Interval</th>
              <th scope="col" rowspan="2">Consumption<br />{{ dataset!.currency }}/kWh</th>
              <th scope="col" rowspan="2">Production<br />{{ dataset!.currency }}/kWh</th>
              <th scope="col" rowspan="2">Expected<br />load W</th>
              <th scope="col" rowspan="2">Expected<br />solar W</th>
              <th v-for="run in tabled" :key="run.id" scope="colgroup" colspan="6"><span class="planner-swatch" :style="{ background: series(run.id) }" aria-hidden="true"></span>{{ run.label }}</th>
            </tr>
            <tr>
              <template v-for="run in tabled" :key="run.id">
                <th scope="col">Mode</th>
                <th scope="col">Limits W<br />charge / discharge</th>
                <th scope="col">Requested<br />setpoint W</th>
                <th scope="col">Predicted<br />battery W</th>
                <th scope="col">End SoC %</th>
                <th scope="col">Cost {{ dataset!.currency }}</th>
              </template>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(slot, i) in comparison.input.slots" :key="slot.start">
              <td :title="`${time(slot.start)} – ${time(slot.end)}`">{{ intervalTime(slot.start, slot.end) }}</td>
              <td>{{ slot.buy.toFixed(4) }}{{ slot.estimatedPrice ? ' *' : '' }}</td>
              <td>{{ slot.sell.toFixed(4) }}{{ slot.estimatedPrice ? ' *' : '' }}</td>
              <td>{{ slot.loadW.toFixed(0) }}</td>
              <td>{{ slot.solarW.toFixed(0) }}</td>
              <template v-for="run in tabled" :key="run.id">
                <td>{{ run.scenarios![0].points[i].mode }}</td>
                <td>{{ run.scenarios![0].points[i].chargeLimitW }} / {{ run.scenarios![0].points[i].dischargeLimitW }}</td>
                <td>{{ run.scenarios![0].points[i].setpointW ?? '—' }}</td>
                <td>{{ run.scenarios![0].points[i].batteryW.toFixed(0) }}</td>
                <td>{{ run.scenarios![0].points[i].soc.toFixed(1) }}</td>
                <td>{{ run.scenarios![0].points[i].cost.toFixed(3) }}</td>
              </template>
            </tr>
          </tbody>
        </table></div>
        <p v-if="comparison.input.slots.some(slot => slot.estimatedPrice)">* Estimated price in the imported snapshot.</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.planner label { display: grid; gap: 0.4rem; }
.planner input, .planner select, .planner button { border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 0.5rem; color: var(--vp-c-text-1); background: var(--vp-c-bg-soft); }
.planner button { cursor: pointer; margin: 1rem 0.5rem 0 0; }
.planner button:disabled { opacity: 0.6; cursor: wait; }
.planner-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin-top: 1rem; }
.planner-presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin: 1rem 0 0; border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 0.75rem 1rem 1rem; min-width: 0; }
.planner-presets legend { padding: 0 0.25rem; }
.planner-preset p { margin: 0.5rem 0 0; font-size: 0.85rem; color: var(--vp-c-text-2); }
.planner .planner-preset button { margin: 0; width: 100%; font-weight: 600; text-align: left; }
.planner .planner-preset button[aria-pressed="true"] { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.planner pre { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.planner-table { overflow-x: auto; }
/* Shifted by pinHeadings(); raised so the rows they slide over stay beneath. */
.planner-table th { position: relative; z-index: 1; background: var(--vp-c-bg-soft); }
.planner-table table { display: table; width: 100%; font-size: 0.85rem; white-space: nowrap; }
.planner-table th, .planner-table td { padding: 6px 8px; }
/*
 * Strategy colours, slots in registry order. Validated as a categorical set
 * against VitePress's light (#ffffff) and dark (#1b1b1f) surfaces; the first
 * three also pass all-pairs. Aqua is under 3:1 on white, which is why every
 * line is labelled directly and the scoreboard repeats the numbers.
 */
.planner { --planner-series-1: #2a78d6; --planner-series-2: #eb6834; --planner-series-3: #1baf7a; --planner-series-4: #eda100; --planner-series-5: #e87ba4; --planner-series-6: #008300; --planner-series-7: #6250d6; --planner-series-8: #e34948; }
:global(.dark) .planner { --planner-series-1: #3987e5; --planner-series-2: #d95926; --planner-series-3: #199e70; --planner-series-4: #c98500; --planner-series-5: #d55181; --planner-series-6: #008300; --planner-series-7: #9085e9; --planner-series-8: #e66767; }
.planner-swatch { display: inline-block; width: 0.75rem; height: 0.75rem; border-radius: 2px; margin-right: 0.4rem; vertical-align: -0.05rem; }
.planner-swatch-dashed { height: 0; border-top: 2px dashed var(--vp-c-text-2); border-radius: 0; vertical-align: 0.2rem; }
.planner-best td, .planner-best th { font-weight: 600; }
.planner-table td.planner-status { white-space: normal; min-width: 16rem; text-align: left; }
.planner-chart { margin: 1rem 0 0; min-width: 0; }
.planner-chart h3 { margin: 0 0 0.25rem; }
.planner-chart figcaption { font-size: 0.9rem; color: var(--vp-c-text-2); min-height: 2.8em; }
.planner-legend { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; list-style: none; padding: 0; margin: 0.25rem 0 0.5rem; font-size: 0.9rem; }
.planner-legend li { margin: 0; }
.planner-label { fill: var(--vp-c-text-1); }
.planner-crosshair { stroke: var(--vp-c-text-3); stroke-width: 1; }
.planner-dot { stroke: var(--vp-c-bg); stroke-width: 2; }
.planner-details { margin: 1rem 0; }
.planner-picker { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 0.5rem 1rem 0.75rem; margin: 1rem 0; }
.planner .planner-picker label { display: flex; align-items: center; gap: 0.4rem; }
.planner .planner-picker input { padding: 0; }
.planner-grid line { stroke: var(--vp-c-divider); }
.planner svg { width: 100%; color: var(--vp-c-text-2); }
.planner svg text { fill: currentColor; font-size: 12px; }
.planner [role="alert"] { color: var(--vp-c-danger-1); }
</style>

