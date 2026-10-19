<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { compare } from "../lib/comparison";
import type { PlannerDataset, runPlanner } from "../lib/planner";
import { parseDataset } from "../lib/planner";
import type { PlannerPreset } from "../lib/presets";
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import { presets } from "../lib/presets";

const dataset = shallowRef<PlannerDataset>();
const plan = shallowRef<Awaited<ReturnType<typeof runPlanner>>>();
const comparison = shallowRef<Awaited<ReturnType<typeof compare>>>();
const options = ref({
  expanded: true,
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
function invalidate() {
  stop();
  plan.value = undefined;
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
      plan.value = data.comparison?.legacy;
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
// Plot area of each SoC chart, in viewBox units: x 40–590, y 200 (0%) to 20 (100%).
function polyline(socs: number[]) {
  return socs
    .map(
      (soc, i) =>
        `${40 + (i / Math.max(1, socs.length - 1)) * 550},${200 - soc * 1.8}`,
    )
    .join(" ");
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const baseline = computed(() =>
  plan.value ? polyline(plan.value.points.map((p) => p.baselineSoc)) : "",
);
// One chart per calculated strategy, nominal solar, side by side.
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const strategies = computed(() => {
  const c = comparison.value;
  if (!c) return [];
  const list = [{ name: "Evening target", scenario: c.legacyScenarios[0] }];
  const engine = c.engine?.scenarios?.[0];
  if (engine) list.push({ name: "HiGHS", scenario: engine });
  return list.map(({ name, scenario }) => ({
    name,
    cost: scenario.cost,
    finalSoc: scenario.finalSoc,
    curve: polyline(scenario.points.map((p) => p.soc)),
  }));
});
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
  if (!dataset.value || !plan.value) return;
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            dataset: { ...dataset.value, settings: settings.value },
            algorithm: "evening-target",
            plan: plan.value,
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
  <section class="planner" aria-label="Planner sandbox">
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
          <legend>HiGHS capability assumptions (not established by this export)</legend>
          <label>Comparison<select aria-label="Comparison capabilities" v-model="options.expanded"><option :value="false">Equivalent: balance + existing boundaries</option><option :value="true">Expanded: assume all four modes</option></select></label>
          <template v-if="options.expanded">
            <p>Hypothetical direct control with signed AC setpoints and native SoC protection. Grid charging and battery export are always permitted in this expanded simulation. No device compatibility is inferred from limit entities.</p>
            <label>Assumed setpoint step (W)<input v-model.number="options.setpointStepW" type="number" min="1" required /></label>
          </template>
          <label>Solver budget (seconds)<input v-model.number="options.timeLimitSeconds" type="number" min="1" max="120" required /></label>
        </fieldset>
        <button type="submit" :disabled="busy">{{ busy ? "Calculating…" : "Compare planners" }}</button>
        <button v-if="busy" type="button" @click="stop">Cancel</button>
      </form>
      <p role="status" aria-live="polite">{{ busy ? "Running both planners in a local worker…" : plan ? "Comparison calculated." : "Ready to calculate." }}</p>
    </template>
    <template v-if="comparison && plan">
      <h2>Evening target / HiGHS comparison</h2>
      <p>HiGHS: {{ comparison.engine?.status ?? comparison.engineError }}. {{ comparison.engine?.balancePreference }}</p>
      <p>Runtime: Evening target {{ comparison.legacyRuntimeMs.toFixed(0) }} ms; HiGHS {{ comparison.engine?.runtimeMs.toFixed(0) ?? '—' }} ms (including solver initialization). Solver statuses (cost, then balance preference when attempted): {{ comparison.engine?.statuses.join(' / ') }}.</p>
      <div class="planner-charts">
        <figure v-for="strategy in strategies" :key="strategy.name">
          <h3>{{ strategy.name }}</h3>
          <svg viewBox="0 0 600 230" role="img" :aria-label="`${strategy.name}: end-of-interval battery state of charge, solid planned, dashed unrestricted baseline`">
            <g class="planner-grid"><line v-for="soc in [0, 50, 100]" :key="soc" x1="40" :y1="200 - soc * 1.8" x2="590" :y2="200 - soc * 1.8" /></g>
            <text v-for="soc in [0, 50, 100]" :key="soc" x="34" :y="204 - soc * 1.8" text-anchor="end">{{ soc }}%</text>
            <text x="40" y="222">{{ axisTime(dataset!.slots[0].start) }}</text>
            <text x="590" y="222" text-anchor="end">{{ axisTime(dataset!.slots.at(-1)!.end) }}</text>
            <polyline :points="baseline" fill="none" stroke="currentColor" stroke-dasharray="6 5" stroke-width="1.5" />
            <polyline :points="strategy.curve" fill="none" stroke="var(--vp-c-brand-1)" stroke-width="2.5" />
          </svg>
          <figcaption>Cost incl. wear <strong>{{ strategy.cost.toFixed(3) }} {{ dataset!.currency }}</strong> · final SoC {{ strategy.finalSoc.toFixed(1) }}%</figcaption>
        </figure>
      </div>
      <p>Battery SoC across the horizon at nominal solar: solid = planned; dashed = unrestricted baseline. Exact values per interval are in the schedule below.</p>
      <p>Evening target: {{ plan.reason }} Requested target {{ plan.target.requestedSoc }}%; reachable at deadline (forecast / reduced solar): {{ plan.target.reachableSoc.map(s => s.toFixed(1) + "%").join(" / ") }}. Unrestricted baseline cost: {{ plan.baselineCost.toFixed(3) }} {{ dataset!.currency }}.</p>
      <p>HiGHS minimizes mean nominal/reduced-solar cost: import charges minus export revenue plus battery wear. At equal cost, it prefers more time in balance mode, within the selected power boundaries. It has no evening target or terminal-reserve penalty. Evening target retains its deadline, reserve, switching and spike-buffer preferences. Lower final SoC can explain lower cost. These are forecast simulations, not measured savings, and costs exclude the planner’s switching and buffer penalties.</p>
      <div class="planner-table" tabindex="0">
        <table><thead><tr><th>Scenario / algorithm</th><th>Cost incl. wear</th><th>Final SoC</th><th>PV generated / curtailed kWh</th></tr></thead>
          <tbody><template v-for="(old, i) in comparison.legacyScenarios" :key="i">
            <tr><td>{{ i ? 'Reduced solar' : 'Nominal' }} / Evening target</td><td>{{ old.cost.toFixed(3) }}</td><td>{{ old.finalSoc.toFixed(1) }}%</td><td>{{ old.generatedKwh.toFixed(2) }} / {{ old.curtailedKwh.toFixed(2) }}</td></tr>
            <tr v-if="comparison.engine?.scenarios"><td>{{ i ? 'Reduced solar' : 'Nominal' }} / HiGHS</td><td>{{ comparison.engine.scenarios[i].cost.toFixed(3) }}</td><td>{{ comparison.engine.scenarios[i].finalSoc.toFixed(1) }}%</td><td>{{ comparison.engine.scenarios[i].generatedKwh.toFixed(2) }} / {{ comparison.engine.scenarios[i].curtailedKwh.toFixed(2) }}</td></tr>
          </template></tbody>
        </table>
      </div>
      <h3>Interval controls and predictions (nominal)</h3>
      <p>Times are in {{ dataset!.timeZone }}. Prices are the snapshot’s configured consumption/import and production/export tariffs, including pricing formulas—not raw EPEX spot prices. Expected load and solar are the snapshot’s forecasts, before curtailment and the solar reduction. Positive battery power means charging; negative means discharging. “—” means balance has no requested setpoint. Balance only moves the battery within its limits: with a 0 W discharge limit it cannot discharge, so check predicted battery power rather than the mode alone.</p>
      <button type="button" @click="download">Download inputs and calculated plan</button>
      <div class="planner-table" tabindex="0" role="region" aria-label="Side-by-side interval comparison"><table>
        <thead>
          <tr>
            <th scope="col" rowspan="2">Interval</th>
            <th scope="col" rowspan="2">Consumption<br />{{ dataset!.currency }}/kWh</th>
            <th scope="col" rowspan="2">Production<br />{{ dataset!.currency }}/kWh</th>
            <th scope="col" rowspan="2">Expected<br />load W</th>
            <th scope="col" rowspan="2">Expected<br />solar W</th>
            <th v-for="strategy in strategies" :key="strategy.name" scope="colgroup" colspan="6">{{ strategy.name }}</th>
          </tr>
          <tr>
            <template v-for="strategy in strategies" :key="strategy.name">
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
          <tr v-for="(p, i) in comparison.legacyScenarios[0].points" :key="p.start">
            <td :title="`${time(p.start)} – ${time(p.end)}`">{{ intervalTime(p.start, p.end) }}</td>
            <td>{{ comparison.input.slots[i].buy.toFixed(4) }}{{ comparison.input.slots[i].estimatedPrice ? ' *' : '' }}</td>
            <td>{{ comparison.input.slots[i].sell.toFixed(4) }}{{ comparison.input.slots[i].estimatedPrice ? ' *' : '' }}</td>
            <td>{{ comparison.input.slots[i].loadW.toFixed(0) }}</td>
            <td>{{ comparison.input.slots[i].solarW.toFixed(0) }}</td>
            <template v-for="(q, j) in comparison.engine?.scenarios ? [p, comparison.engine.scenarios[0].points[i]] : [p]" :key="j">
              <td>{{ q.mode }}</td>
              <td>{{ q.chargeLimitW }} / {{ q.dischargeLimitW }}</td>
              <td>{{ q.setpointW ?? '—' }}</td>
              <td>{{ q.batteryW.toFixed(0) }}</td>
              <td>{{ q.soc.toFixed(1) }}</td>
              <td>{{ q.cost.toFixed(3) }}</td>
            </template>
          </tr>
        </tbody>
      </table></div>
      <p v-if="comparison.input.slots.some(slot => slot.estimatedPrice)">* Estimated price in the imported snapshot.</p>
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
.planner-table table { display: table; width: 100%; font-size: 0.85rem; white-space: nowrap; }
.planner-table th, .planner-table td { padding: 6px 8px; }
.planner-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 1rem 2rem; }
.planner-charts figure { margin: 0; min-width: 0; }
.planner-charts h3 { margin: 0 0 0.25rem; }
.planner-charts figcaption { font-size: 0.9rem; color: var(--vp-c-text-2); }
.planner-grid line { stroke: var(--vp-c-divider); }
.planner svg { width: 100%; color: var(--vp-c-text-2); }
.planner svg text { fill: currentColor; font-size: 12px; }
.planner [role="alert"] { color: var(--vp-c-danger-1); }
</style>

