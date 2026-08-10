import { useState } from "react";
import type {
  SettingsActionData,
  SettingsSection,
} from "../../lib/settings-form";
import { succeededFor } from "../../lib/settings-form";

/**
 * Which of a section's forms is open. A save that succeeded should put the row
 * back into its read-only state and close the add form — but only for the
 * section the action actually belonged to, which is why this needs the
 * discriminator and not just "an action finished".
 *
 * Adjusted during render against the last `actionData` this hook saw, rather
 * than in an effect. That is React's documented way to react to a changed prop:
 * it settles before the browser paints, so a saved row never flashes its editor
 * open for a frame, and it sidesteps having to name a dependency array that
 * describes "a *new* result object, even if it says the same thing".
 */
export function useSectionEditor(
  actionData: SettingsActionData | undefined,
  section: SettingsSection,
) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [handled, setHandled] = useState(actionData);

  if (actionData !== handled) {
    setHandled(actionData);
    if (succeededFor(actionData, section)) {
      setEditingId(null);
      setShowAdd(false);
    }
  }

  return { showAdd, setShowAdd, editingId, setEditingId };
}
