---
layout: doc
sidebar: false
aside: false
---

<script setup>
import PlannerSandbox from './components/PlannerSandbox.vue'
</script>

# Planner sandbox

Download **Export planner data** from the add-on’s Plans or Tools page, then import that JSON here. Your file stays in this browser: nothing is uploaded or sent to Home Assistant.

This compares the production **Evening target** algorithm with the experimental **HiGHS** engine, using the versions shipped with this documentation site. Both run in a local Web Worker. The export preserves the battery model, forecast intervals, tariffs and modeled curtailment. Other devices are included for inspection; the calculation plans for the export’s selected battery.

HiGHS optimizes cost only, with no evening target or reserve penalty. The existing Evening target planner keeps its deadline and configured maximum-SoC target. Choose equivalent capabilities or explicitly assume expanded control modes; grid charging and battery export stay opt-in. See [Planning engine](./internals/planning-engine) for objectives, physical assumptions and solver status.

Change the settings and rerun to explore the result. Import the original file again to restore its settings. A snapshot reproduces forecast planning, not future live control or actual household behavior. Older exports may produce different plans after the algorithm changes.

<ClientOnly>
  <PlannerSandbox />
</ClientOnly>
