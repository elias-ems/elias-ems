<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { compare } from "../lib/comparison";
import type { PlannerDataset } from "../lib/planner";
import { parseDataset } from "../lib/planner";
import type { PlannerPreset } from "../lib/presets";
// biome-ignore lint/correctness/noUnusedImports: Used by the Vue template.
import { presets } from "../lib/presets";

const dataset = shallowRef<PlannerDataset>();
const comparison = shallowRef<Awaited<ReturnType<typeof compare>>>();
/** Every registered strategy that produced a schedule, in registry order. */
const scored = computed(
  () => comparison.value?.runs.filter((run) => run.scenarios) ?? [],
);
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
// One chart per registered strategy, nominal solar, side by side.
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const strategies = computed(() =>
  scored.value.flatMap((run) => {
    const nominal = run.scenarios?.[0];
    if (!nominal) return [];
    const target = (
      run.result?.details as
        | { target?: { requestedSoc: number; reachableSoc: number[] } }
        | undefined
    )?.target;
    return {
      id: run.id,
      name: run.label,
      cost: nominal.cost,
      finalSoc: nominal.finalSoc,
      curve: polyline(nominal.points.map((p) => p.soc)),
      baseline: polyline(
        run.result?.plan.points.map((p) => p.baselineSoc) ?? [],
      ),
      target,
    };
  }),
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
          <legend>Capability assumptions for every strategy (not established by this export)</legend>
          <label>Comparison<select aria-label="Comparison capabilities" v-model="options.expanded"><option :value="false">Equivalent: balance + existing boundaries</option><option :value="true">Expanded: assume all four modes</option></select></label>
          <template v-if="options.expanded">
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
      <ul>
        <li v-for="run in comparison.runs" :key="run.id"><strong>{{ run.label }}</strong>: {{ run.error ?? run.result?.status }} · {{ run.runtimeMs.toFixed(0) }} ms<template v-if="run.result?.notes.length"> · {{ run.result.notes.join(" ") }}</template></li>
      </ul>
      <div class="planner-charts">
        <figure v-for="strategy in strategies" :key="strategy.id">
          <h3>{{ strategy.name }}</h3>
          <svg viewBox="0 0 600 230" role="img" :aria-label="`${strategy.name}: end-of-interval battery state of charge, solid planned, dashed unrestricted baseline`">
            <g class="planner-grid"><line v-for="soc in [0, 50, 100]" :key="soc" x1="40" :y1="200 - soc * 1.8" x2="590" :y2="200 - soc * 1.8" /></g>
            <text v-for="soc in [0, 50, 100]" :key="soc" x="34" :y="204 - soc * 1.8" text-anchor="end">{{ soc }}%</text>
            <text x="40" y="222">{{ axisTime(dataset!.slots[0].start) }}</text>
            <text x="590" y="222" text-anchor="end">{{ axisTime(dataset!.slots.at(-1)!.end) }}</text>
            <polyline :points="strategy.baseline" fill="none" stroke="currentColor" stroke-dasharray="6 5" stroke-width="1.5" />
            <polyline :points="strategy.curve" fill="none" stroke="var(--vp-c-brand-1)" stroke-width="2.5" />
          </svg>
          <figcaption>Cost incl. wear <strong>{{ strategy.cost.toFixed(3) }} {{ dataset!.currency }}</strong> · final SoC {{ strategy.finalSoc.toFixed(1) }}%<template v-if="strategy.target"> · reachable at deadline (forecast / reduced solar) {{ strategy.target.reachableSoc.map(s => s.toFixed(1) + "%").join(" / ") }} of {{ strategy.target.requestedSoc }}%</template></figcaption>
        </figure>
      </div>
      <p>Battery SoC across the horizon at nominal solar: solid = planned; dashed = unrestricted baseline. Exact values per interval are in the schedule below.</p>
      <p>Every registered strategy plans the same snapshot under the same capabilities and is scored by the same physical replay, for nominal and reduced solar: import charges minus export revenue plus battery wear. Evening target keeps balance mode and aims for its deadline and reserve; HiGHS minimizes that mean cost directly and, at equal cost, prefers balance. HiGHS has no evening target or terminal-reserve value, so a lower final SoC can explain a lower cost. These are forecast simulations, not measured savings, and costs exclude Evening target’s switching and buffer penalties.</p>
      <div class="planner-table" tabindex="0">
        <table><thead><tr><th>Scenario / strategy</th><th>Cost incl. wear</th><th>Final SoC</th><th>PV generated / curtailed kWh</th></tr></thead>
          <tbody><template v-for="i in [0, 1]" :key="i">
            <tr v-for="run in scored" :key="run.id"><td>{{ i ? 'Reduced solar' : 'Nominal' }} / {{ run.label }}</td><td>{{ run.scenarios![i].cost.toFixed(3) }}</td><td>{{ run.scenarios![i].finalSoc.toFixed(1) }}%</td><td>{{ run.scenarios![i].generatedKwh.toFixed(2) }} / {{ run.scenarios![i].curtailedKwh.toFixed(2) }}</td></tr>
          </template></tbody>
        </table>
      </div>
      <template v-if="scored.length">
        <h3>Interval controls and predictions (nominal)</h3>
        <p>Times are in {{ dataset!.timeZone }}. Prices are the snapshot’s configured consumption/import and production/export tariffs, including pricing formulas—not raw EPEX spot prices. Expected load and solar are the snapshot’s forecasts, before curtailment and the solar reduction. Positive battery power means charging; negative means discharging. “—” means balance has no requested setpoint. Balance only moves the battery within its limits: with a 0 W discharge limit it cannot discharge, so check predicted battery power rather than the mode alone.</p>
        <button type="button" @click="download">Download inputs and every strategy’s result</button>
        <div class="planner-table" tabindex="0" role="region" aria-label="Side-by-side interval comparison"><table>
          <thead>
            <tr>
              <th scope="col" rowspan="2">Interval</th>
              <th scope="col" rowspan="2">Consumption<br />{{ dataset!.currency }}/kWh</th>
              <th scope="col" rowspan="2">Production<br />{{ dataset!.currency }}/kWh</th>
              <th scope="col" rowspan="2">Expected<br />load W</th>
              <th scope="col" rowspan="2">Expected<br />solar W</th>
              <th v-for="run in scored" :key="run.id" scope="colgroup" colspan="6">{{ run.label }}</th>
            </tr>
            <tr>
              <template v-for="run in scored" :key="run.id">
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
              <template v-for="run in scored" :key="run.id">
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

