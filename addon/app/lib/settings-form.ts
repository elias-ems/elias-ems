/**
 * The settings page posts to one action from six independent sections, so its
 * result has to say which section it belongs to. Without that discriminator a
 * failed battery form would light up the grid form's fields, and a successful
 * save in one section would look like a reason to close the editor in another.
 */
import type { BatteryErrors } from "./batteries";
import type { ControlErrors } from "./control";
import type { CurtailmentErrors } from "./curtailment";
import type { GridErrors } from "./grid";
import type { PriceErrors } from "./prices";
import type { PvEntityErrors } from "./pv-entities";

export type SettingsSection =
  | "pv"
  | "grid"
  | "battery"
  | "control"
  | "curtailment"
  | "prices";

export type SettingsActionData =
  | { section: SettingsSection; ok: true }
  /** `recordId` is the row being edited, or null for that section's add form. */
  | {
      section: "pv";
      recordId: string | null;
      errors: PvEntityErrors;
    }
  | { section: "grid"; recordId: null; errors: GridErrors }
  | { section: "battery"; recordId: string | null; errors: BatteryErrors }
  | { section: "control"; recordId: null; errors: ControlErrors }
  | { section: "curtailment"; recordId: null; errors: CurtailmentErrors }
  | { section: "prices"; recordId: null; errors: PriceErrors };

/** The failure for `section`, or null when the last action was something else. */
export function failureFor<TSection extends SettingsSection>(
  actionData: SettingsActionData | undefined,
  section: TSection,
): Extract<SettingsActionData, { section: TSection; errors: unknown }> | null {
  if (!actionData || !("errors" in actionData)) return null;
  if (actionData.section !== section) return null;
  return actionData as Extract<
    SettingsActionData,
    { section: TSection; errors: unknown }
  >;
}

/** True when `section` just saved successfully — the cue to leave edit mode. */
export function succeededFor(
  actionData: SettingsActionData | undefined,
  section: SettingsSection,
): boolean {
  return Boolean(
    actionData && "ok" in actionData && actionData.section === section,
  );
}
