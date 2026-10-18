<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { compare } from "../lib/comparison";
import type { PlannerDataset, runPlanner } from "../lib/planner";
import { parseDataset } from "../lib/planner";

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
      targetSoc: parsed.model.maxSoc,
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
      <p role="status" aria-live="polite">{{ busy ? "Running both planners in a local worker…" : plan ? "Plan calculated." : "Ready to calculate." }}</p>
    </template>
    <template v-if="comparison">
      <h2>Evening target / HiGHS comparison</h2>
      <p>HiGHS: {{ comparison.engine?.status ?? comparison.engineError }}. {{ comparison.engine?.balancePreference }}</p>
      <p>Runtime: Evening target {{ comparison.legacyRuntimeMs.toFixed(0) }} ms; HiGHS {{ comparison.engine?.runtimeMs.toFixed(0) ?? '—' }} ms (including solver initialization). Solver statuses (cost, then balance preference when attempted): {{ comparison.engine?.statuses.join(' / ') }}.</p>
      <p>HiGHS minimizes mean nominal/reduced-solar cost: import charges minus export revenue plus battery wear. At equal cost, it prefers more time in balance mode, within the selected power boundaries. It has no evening target or terminal-reserve penalty. Evening target retains its deadline, reserve, switching and spike-buffer preferences. Lower final SoC can explain lower cost. Neither forecast guarantees live savings.</p>
      <div class="planner-table" tabindex="0">
        <table><thead><tr><th>Scenario / algorithm</th><th>Cost incl. wear</th><th>Final SoC</th><th>PV generated / curtailed kWh</th></tr></thead>
          <tbody><template v-for="(old, i) in comparison.legacyScenarios" :key="i">
            <tr><td>{{ i ? 'Reduced solar' : 'Nominal' }} / Evening target</td><td>{{ old.cost.toFixed(3) }}</td><td>{{ old.finalSoc.toFixed(1) }}%</td><td>{{ old.generatedKwh.toFixed(2) }} / {{ old.curtailedKwh.toFixed(2) }}</td></tr>
            <tr v-if="comparison.engine?.scenarios"><td>{{ i ? 'Reduced solar' : 'Nominal' }} / HiGHS</td><td>{{ comparison.engine.scenarios[i].cost.toFixed(3) }}</td><td>{{ comparison.engine.scenarios[i].finalSoc.toFixed(1) }}%</td><td>{{ comparison.engine.scenarios[i].generatedKwh.toFixed(2) }} / {{ comparison.engine.scenarios[i].curtailedKwh.toFixed(2) }}</td></tr>
          </template></tbody>
        </table>
      </div>
      <details v-if="comparison.engine?.scenarios"><summary>Side-by-side interval controls and predictions (nominal)</summary>
        <p>Times are in {{ dataset!.timeZone }}. Prices are the snapshot’s configured consumption/import and production/export tariffs, including pricing formulas—not raw EPEX spot prices. Expected load and solar are the snapshot’s forecasts, before curtailment and the solar reduction. Positive battery power means charging; negative means discharging. “—” means balance has no requested setpoint.</p>
        <div class="planner-table" tabindex="0" role="region" aria-label="Side-by-side interval comparison"><table>
          <thead>
            <tr>
              <th scope="col" rowspan="2">Interval</th>
              <th scope="col" rowspan="2">Consumption<br />{{ dataset!.currency }}/kWh</th>
              <th scope="col" rowspan="2">Production<br />{{ dataset!.currency }}/kWh</th>
              <th scope="col" rowspan="2">Expected<br />load W</th>
              <th scope="col" rowspan="2">Expected<br />solar W</th>
              <th scope="colgroup" colspan="6">Evening target</th>
              <th scope="colgroup" colspan="6">HiGHS</th>
            </tr>
            <tr>
              <template v-for="algorithm in ['Evening target', 'HiGHS']" :key="algorithm">
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
            <tr v-for="(p, i) in comparison.engine.scenarios[0].points" :key="p.start">
              <td :title="`${time(p.start)} – ${time(p.end)}`">{{ intervalTime(p.start, p.end) }}</td>
              <td>{{ comparison.input.slots[i].buy.toFixed(4) }}{{ comparison.input.slots[i].estimatedPrice ? ' *' : '' }}</td>
              <td>{{ comparison.input.slots[i].sell.toFixed(4) }}{{ comparison.input.slots[i].estimatedPrice ? ' *' : '' }}</td>
              <td>{{ comparison.input.slots[i].loadW.toFixed(0) }}</td>
              <td>{{ comparison.input.slots[i].solarW.toFixed(0) }}</td>
              <template v-for="(q, j) in [comparison.legacyScenarios[0].points[i], p]" :key="j">
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
      </details>
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
        <table><thead><tr>
          <th scope="col" title="Interval start" aria-label="Interval start">Start</th>
          <th scope="col" title="Solar power (W)" aria-label="Solar power (W)">Solar W</th>
          <th scope="col" title="Household load (W)" aria-label="Household load (W)">Load W</th>
          <th scope="col" title="Buy price per kWh" aria-label="Buy price per kWh">Buy/kWh</th>
          <th scope="col" title="Sell price per kWh" aria-label="Sell price per kWh">Sell/kWh</th>
          <th scope="col" title="Charge ceiling (W)" aria-label="Charge ceiling (W)">In cap W</th>
          <th scope="col" title="Output ceiling (W)" aria-label="Output ceiling (W)">Out cap W</th>
          <th scope="col" title="Charging power (W)" aria-label="Charging power (W)">In W</th>
          <th scope="col" title="Discharging power (W)" aria-label="Discharging power (W)">Out W</th>
          <th scope="col" title="Battery state of charge (%)" aria-label="Battery state of charge (%)">SoC %</th>
          <th scope="col" title="Unrestricted baseline state of charge (%)" aria-label="Unrestricted baseline state of charge (%)">Base %</th>
        </tr></thead>
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
.planner-table table { display: table; width: 100%; font-size: 0.85rem; white-space: nowrap; }
.planner-table th, .planner-table td { padding: 6px 8px; }
.planner svg { width: 100%; color: var(--vp-c-text-2); }
.planner svg text { fill: currentColor; font-size: 12px; }
.planner [role="alert"] { color: var(--vp-c-danger-1); }
</style>

