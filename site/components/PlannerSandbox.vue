<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { PlannerDataset, runPlanner } from "../lib/planner";
import { parseDataset } from "../lib/planner";

const dataset = shallowRef<PlannerDataset>();
const plan = shallowRef<Awaited<ReturnType<typeof runPlanner>>>();
const error = ref("");
const busy = ref(false);
const filename = ref("");
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
function stop() {
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
  error.value = "";
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const sequence = ++importSequence;
  invalidate();
  dataset.value = undefined;
  filename.value = "";
  try {
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Please choose a JSON export smaller than 10 MB.");
    const parsed = parseDataset(JSON.parse(await file.text()));
    if (sequence !== importSequence) return;
    dataset.value = parsed;
    settings.value = {
      targetSoc: parsed.settings.targetSoc,
      solarHaircut: parsed.settings.solarHaircut,
      switchCost: parsed.settings.switchCost,
      passes: parsed.settings.passes,
      deadline: new Date(parsed.settings.deadline).toISOString(),
      spikeBufferKwh: parsed.settings.spikeBufferKwh ?? 0.54,
    };
    filename.value = file.name;
  } catch (e) {
    if (sequence === importSequence)
      error.value = e instanceof Error ? e.message : String(e);
  }
}
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
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
    worker.onmessage = ({ data }) => {
      plan.value = data.plan;
      error.value = data.error ?? "";
      stop();
    };
    worker.onerror = () => {
      error.value = "The planner could not finish. Try fewer search passes.";
      stop();
    };
    worker.postMessage(input);
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
const curve = computed(() =>
  plan.value?.points
    .map(
      (p, i, points) =>
        `${40 + (i / Math.max(1, points.length - 1)) * 720},${220 - p.soc * 2}`,
    )
    .join(" "),
);
// biome-ignore lint/correctness/noUnusedVariables: Used by the Vue template.
const baseline = computed(() =>
  plan.value?.points
    .map(
      (p, i, points) =>
        `${40 + (i / Math.max(1, points.length - 1)) * 720},${220 - p.baselineSoc * 2}`,
    )
    .join(" "),
);
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
    <label>Import planner export <input type="file" accept=".json,application/json" @change="importFile" /></label>
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
          <label>Evening deadline<select v-model="settings.deadline"><option v-for="slot in dataset.slots" :key="slot.end" :value="new Date(slot.end).toISOString()">{{ time(slot.end) }}</option></select></label>
          <label>Target SoC (%)<input v-model.number="settings.targetSoc" type="number" :min="dataset.model.minSoc" :max="dataset.model.maxSoc" step="any" required /></label>
          <label>Solar reduction (0–1)<input v-model.number="settings.solarHaircut" type="number" min="0" max="0.999" step="any" required /></label>
          <label>Cost per limit change<input v-model.number="settings.switchCost" type="number" min="0" step="any" required /></label>
          <label>Search passes<input v-model.number="settings.passes" type="number" min="1" max="20" required /></label>
          <label>Spike buffer (kWh)<input v-model.number="settings.spikeBufferKwh" type="number" min="0" step="any" required /></label>
        </div>
        <button type="submit" :disabled="busy">{{ busy ? "Calculating…" : "Run production planner" }}</button>
        <button v-if="busy" type="button" @click="stop">Cancel</button>
      </form>
      <p role="status" aria-live="polite">{{ busy ? "Running Evening target locally…" : plan ? "Plan calculated." : "Ready to calculate." }}</p>
    </template>
    <template v-if="plan">
      <h2>Calculated plan</h2>
      <p>{{ plan.reason }}</p>
      <p>Forecast energy cost: <strong>{{ plan.cost.toFixed(3) }} {{ dataset!.currency }}</strong>. Unrestricted baseline: {{ plan.baselineCost.toFixed(3) }} {{ dataset!.currency }}. Difference: {{ (plan.baselineCost - plan.cost).toFixed(3) }} {{ dataset!.currency }}.</p>
      <p>Requested target: {{ plan.target.requestedSoc }}%. Reachable at deadline (forecast / reduced solar): {{ plan.target.reachableSoc.map(s => s.toFixed(1) + "%").join(" / ") }}.</p>
      <p>These are forecast simulations, not measured savings. Costs exclude the planner’s switching and buffer penalties.</p>
      <svg viewBox="0 0 800 250" role="img" aria-label="End-of-interval battery state of charge: solid planned, dashed unrestricted baseline">
        <text x="0" y="24">100%</text><text x="10" y="220">0%</text>
        <line x1="40" y1="220" x2="760" y2="220" stroke="currentColor" />
        <polyline :points="baseline" fill="none" stroke="currentColor" stroke-dasharray="6 5" stroke-width="2" />
        <polyline :points="curve" fill="none" stroke="var(--vp-c-brand-1)" stroke-width="3" />
      </svg>
      <p>Battery SoC across the imported horizon: solid = planned; dashed = unrestricted. Exact timestamps and values are below.</p>
      <button type="button" @click="download">Download inputs and calculated plan</button>
      <div class="planner-table" tabindex="0" role="region" aria-label="Interval schedule">
        <table><thead><tr><th>Interval start</th><th>Solar W</th><th>Load W</th><th>Buy / kWh</th><th>Sell / kWh</th><th>Charge ceiling W</th><th>Output ceiling W</th><th>Charging W</th><th>Discharging W</th><th>SoC %</th><th>Baseline SoC %</th></tr></thead>
          <tbody><tr v-for="p in plan.points" :key="p.start"><td>{{ time(p.start) }}{{ p.estimatedPrice ? " (estimated price)" : "" }}</td><td>{{ (p.generatedSolarW ?? p.solarW).toFixed(0) }}</td><td>{{ p.loadW.toFixed(0) }}</td><td>{{ p.buy.toFixed(4) }}</td><td>{{ p.sell.toFixed(4) }}</td><td>{{ p.limitW }}</td><td>{{ p.dischargeLimitW ?? "Native" }}</td><td>{{ p.chargeW.toFixed(0) }}</td><td>{{ p.dischargeW.toFixed(0) }}</td><td>{{ p.soc.toFixed(1) }}</td><td>{{ p.baselineSoc.toFixed(1) }}</td></tr></tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.planner label { display: grid; gap: 0.4rem; }
.planner input, .planner select, .planner button { border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 0.5rem; color: var(--vp-c-text-1); background: var(--vp-c-bg-soft); }
.planner button { cursor: pointer; margin: 1rem 0.5rem 0 0; }
.planner button:disabled { opacity: 0.6; cursor: wait; }
.planner-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin-top: 1rem; }
.planner pre { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.planner-table { overflow-x: auto; }
.planner-table table { font-size: 0.85rem; white-space: nowrap; }
.planner svg { width: 100%; color: var(--vp-c-text-2); }
.planner svg text { fill: currentColor; font-size: 12px; }
.planner [role="alert"] { color: var(--vp-c-danger-1); }
</style>



