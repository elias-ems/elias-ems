# PV onboarding through HA-MCP

Use a disposable Home Assistant OS install running this build and a mock inverter. In Home Assistant, create a template **Number** entity named `number.mock_inverter_limit`, or substitute a mock inverter's 0–100 number. Use mock power and energy sensor IDs. Keep PV curtailment and battery control disabled for this check.

In Developer Tools → Events, listen to `*` before starting and leave the listener open through the final read. Look for zero `elias_ems_*_pv_limit` events and zero `call_service` events targeting the mock inverter. Preview returns an initially disabled automation for review. Apply saves to Elias EMS Settings only. The example automation assumes that writing 100% releases the inverter.

## Tool calls

Call [community HA-MCP](https://homeassistant-ai.github.io/ha-mcp/tools/) through the test instance. Each line shows the tool name and arguments. Substitute the installed slug for `SLUG` and copy the revision and preview token from the preceding responses.

```text
ha_get_app       {"source":"installed"}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/settings","method":"GET"}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/onboarding/pv-curtailment","method":"GET"}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/onboarding/pv-curtailment/preview","method":"POST","body":{"revision":"REV","limitEntityId":"number.mock_inverter_limit","fields":{"title":"Mock inverter","powerEntityId":"sensor.inverter_power","energyEntityId":"sensor.inverter_energy_total","ratedPowerW":4000,"controlMode":"stepped","stepLimitPercent":25}}}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/settings","method":"GET"}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/onboarding/pv-curtailment/apply","method":"POST","body":{"revision":"REV","previewToken":"TOKEN","limitEntityId":"number.mock_inverter_limit","fields":{"title":"Mock inverter","powerEntityId":"sensor.inverter_power","energyEntityId":"sensor.inverter_energy_total","ratedPowerW":4000,"controlMode":"stepped","stepLimitPercent":25}}}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/settings","method":"GET"}
```

After preview, Settings should have the same revision and values as before. Review the diff and the automation listening for `elias_ems_mock_inverter_pv_limit`. After apply, expect a new revision, the saved array with `curtailable: false`, and global curtailment still disabled. `limitEntityId` is used in the proposed automation. Grid and price inputs are saved through their respective Settings forms.

Use the returned array ID and the latest revision to test a partial update. After preview, save a distinct grid power entity in **Elias EMS → Settings**, then apply the old request:

```text
ha_manage_app    {"slug":"SLUG","path":"/api/v1/onboarding/pv-curtailment/preview","method":"POST","body":{"arrayId":"ID","revision":"NEW_REV","limitEntityId":"number.mock_inverter_limit","fields":{"ratedPowerW":4200}}}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/onboarding/pv-curtailment/apply","method":"POST","body":{"arrayId":"ID","revision":"NEW_REV","previewToken":"NEW_TOKEN","limitEntityId":"number.mock_inverter_limit","fields":{"ratedPowerW":4200}}}
ha_manage_app    {"slug":"SLUG","path":"/api/v1/settings","method":"GET"}
```

Expect HTTP 409 from apply, the new grid sensor, and the original 4000 W rating. Preview again after any Settings change or app restart. For local verification, run `npm run test:integration` from `addon/`. The onboarding test checks the mock Home Assistant event log for zero commands.
