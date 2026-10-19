---
layout: doc
pageClass: planner-page
sidebar: false
aside: false
---

<script setup>
import PlannerSandbox from './components/PlannerSandbox.vue'
</script>

# Planner sandbox

Download **Export planner data** from the add-on’s Plans or Tools page, then import that JSON here. Your file stays in this browser: nothing is uploaded or sent to Home Assistant.

This compares the production **Evening target** algorithm with the experimental **HiGHS** engine, using the versions shipped with this documentation site. Both run in a local Web Worker. The export preserves the battery model, forecast intervals, tariffs and modeled curtailment. Other devices are included for inspection; the calculation plans for the export’s selected battery.

HiGHS optimizes cost only, with no evening target or reserve penalty. The existing Evening target planner keeps its deadline and configured maximum-SoC target. Expanded capabilities are selected by default and assume all four modes, with grid charging and battery export permitted. Select equivalent capabilities to restrict HiGHS to balance plus existing boundaries. See [Planning engine](./internals/planning-engine) for objectives, physical assumptions and solver status.

No export to hand? Load one of the four **synthetic presets** instead. They are generated from fixed timestamps and smooth curves, not copied from any household, and each targets one behaviour of HiGHS against Evening target:

- **Marginal autumn surplus** — solar beats load by at most 12 W for a few intervals. HiGHS should widen those balance boundaries to the device maximum rather than match the forecast surplus.
- **Sunny summer, curtailment** — negative midday export prices with a curtailable inverter carrying 70 % of PV: the battery fills and PV is held back.
- **Negative night, dear evening** — buy prices below zero overnight before an expensive peak, which only expanded capabilities can exploit by charging from the grid.
- **Cloudy winter spread** — almost no solar, so cycling has to pay for losses and wear: the first day's spread does, the narrower second day's should not.

With expanded capabilities HiGHS often uses its whole solver budget on these 24–48 hour horizons and reports a feasible plan it has not proven optimal; that label is the honest result, not an error.

Change the settings and rerun to explore the result. Import the original file, or click the preset again, to restore its settings. A snapshot reproduces forecast planning, not future live control or actual household behavior. Older exports may produce different plans after the algorithm changes.

<ClientOnly>
  <PlannerSandbox />
</ClientOnly>
