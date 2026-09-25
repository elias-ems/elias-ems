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

This runs the same **Evening target** algorithm as the production add-on, using the version shipped with this documentation site. The export preserves the battery model, forecast intervals, tariffs and modeled curtailment. Other devices are included for inspection; the calculation plans for the export’s selected battery.

Change the settings and rerun to explore the result. Import the original file again to restore its settings. A snapshot reproduces forecast planning, not future live control or actual household behavior. Older exports may produce different plans after the algorithm changes.

<ClientOnly>
  <PlannerSandbox />
</ClientOnly>
