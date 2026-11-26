import {
  isCurtailable,
  type PvEntity,
  pvLimitEventType,
  pvSlug,
} from "./pv-entities";

export const PV_REVIEW_ERROR =
  "Complete the setup review for all curtailable arrays before enabling.";

export function pvReviewKey(arrays: PvEntity[]) {
  return JSON.stringify(
    arrays
      .filter(isCurtailable)
      .map((array) => [
        array.id,
        pvLimitEventType(pvSlug(array)),
        array.powerEntityId,
        array.ratedPowerW,
        array.controlMode,
        array.stepLimitPercent,
      ]),
  );
}

export function pvAutomationYaml(array: PvEntity) {
  const eventType = pvLimitEventType(pvSlug(array));
  return `alias: ${JSON.stringify(`${array.title} PV curtailment`)}
triggers:
  - trigger: event
    event_type: ${eventType}
actions:
  - if:
      - condition: template
        value_template: "{{ trigger.event.data.released }}"
    then:
      - action: number.set_value
        target:
          entity_id: number.replace_with_inverter_limit
        data:
          value: 100
    else:
      - action: number.set_value
        target:
          entity_id: number.replace_with_inverter_limit
        data:
          value: "{{ trigger.event.data.limit_percent }}"
`;
}
