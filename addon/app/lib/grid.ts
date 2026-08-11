/**
 * The grid connection: the one meter reading every control strategy starts
 * from. It is *instantaneous power in W, signed* — positive when the house is
 * drawing from the grid, negative when it is pushing back. That signed number
 * *is* the net exchange the strategies balance, with no arithmetic in between.
 *
 * One sensor rather than an import/export pair, because that is what the common
 * meters publish: P1/DSMR readers, Shelly EM and friends, and most hybrid
 * inverters all expose a single signed power sensor. An installation that only
 * has the unsigned pair Home Assistant's energy dashboard wants can subtract one
 * from the other in a template sensor and point this at that.
 *
 * Pure, so the settings UI can share these types and the validation can be
 * tested without touching disk. Reading and writing live in `grid.server.ts`.
 */

export type Grid = {
  /** Net grid power in W: positive importing, negative exporting. */
  powerEntityId: string;
};

export type GridErrors = Partial<Record<keyof Grid, string>>;

export const EMPTY_GRID: Grid = { powerEntityId: "" };

export function normalizeGrid(stored: Partial<Grid> | null): Grid {
  return { powerEntityId: stored?.powerEntityId?.trim() ?? "" };
}

/** The sensor is needed before a net exchange can be worked out at all. */
export function isGridConfigured(grid: Grid): boolean {
  return Boolean(grid.powerEntityId);
}

export function parseGrid(
  formData: FormData,
): { ok: true; grid: Grid } | { ok: false; errors: GridErrors } {
  const powerEntityId = formData.get("powerEntityId")?.toString().trim() ?? "";

  if (!powerEntityId) {
    return {
      ok: false,
      errors: { powerEntityId: "Pick the grid power sensor." },
    };
  }

  return { ok: true, grid: { powerEntityId } };
}
