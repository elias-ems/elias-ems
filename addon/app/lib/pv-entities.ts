/** A PV array: its two live readings, plus a name to tell it from the next one. */

export type PvEntityFields = {
  title: string;
  /** Current power, in W. */
  powerEntityId: string;
  /** Total energy generated, in kWh. */
  energyEntityId: string;
};

export type PvEntity = PvEntityFields & { id: string };

export type PvEntityErrors = Partial<Record<keyof PvEntityFields, string>>;

/**
 * `title` was added after the first entries were already on disk, so stored
 * records may not have one. Fall back to the power entity id, which at least
 * tells two arrays apart, rather than showing every one of them as "Untitled".
 */
export function normalizePvEntity(entity: PvEntity): PvEntity {
  return { ...entity, title: entity.title?.trim() || entity.powerEntityId };
}

export function parsePvEntity(
  formData: FormData,
):
  | { ok: true; fields: PvEntityFields }
  | { ok: false; errors: PvEntityErrors } {
  const title = formData.get("title")?.toString().trim() ?? "";
  const powerEntityId = formData.get("powerEntityId")?.toString().trim() ?? "";
  const energyEntityId =
    formData.get("energyEntityId")?.toString().trim() ?? "";

  if (!title || !powerEntityId || !energyEntityId) {
    const errors: PvEntityErrors = {};
    if (!title) errors.title = "Give this array a name.";
    if (!powerEntityId) errors.powerEntityId = "Pick the current power entity.";
    if (!energyEntityId) {
      errors.energyEntityId = "Pick the total energy entity.";
    }
    return { ok: false, errors };
  }

  return { ok: true, fields: { title, powerEntityId, energyEntityId } };
}
