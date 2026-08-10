/**
 * The grid connection: the two meter readings every control strategy starts
 * from. Both are *instantaneous power in W and never negative* — `import` is
 * what the house draws from the grid, `export` is what it pushes back. The net
 * exchange the strategies balance is `import - export`.
 *
 * Home Assistant's own energy model splits the two the same way, so an
 * installation already set up for the energy dashboard has both. Meters that
 * publish a single *signed* sensor instead are not supported yet, and putting
 * that one entity in both fields is rejected below rather than silently netting
 * to zero forever.
 *
 * Pure, so the settings UI can share these types and the validation can be
 * tested without touching disk. Reading and writing live in `grid.server.ts`.
 */

export type Grid = {
  /** Power drawn from the grid, in W. */
  importEntityId: string;
  /** Power fed back into the grid, in W. */
  exportEntityId: string;
};

export type GridErrors = Partial<Record<keyof Grid, string>>;

export const EMPTY_GRID: Grid = { importEntityId: "", exportEntityId: "" };

export function normalizeGrid(stored: Partial<Grid> | null): Grid {
  return {
    importEntityId: stored?.importEntityId?.trim() ?? "",
    exportEntityId: stored?.exportEntityId?.trim() ?? "",
  };
}

/** Both sensors are needed before a net exchange can be worked out at all. */
export function isGridConfigured(grid: Grid): boolean {
  return Boolean(grid.importEntityId && grid.exportEntityId);
}

export function parseGrid(
  formData: FormData,
): { ok: true; grid: Grid } | { ok: false; errors: GridErrors } {
  const importEntityId =
    formData.get("importEntityId")?.toString().trim() ?? "";
  const exportEntityId =
    formData.get("exportEntityId")?.toString().trim() ?? "";

  const errors: GridErrors = {};
  if (!importEntityId) {
    errors.importEntityId = "Pick the grid consumption sensor.";
  }
  if (!exportEntityId) {
    errors.exportEntityId = "Pick the grid production sensor.";
  }
  if (importEntityId && importEntityId === exportEntityId) {
    // One signed sensor in both fields nets to zero on every tick, so the loop
    // would quietly decide to do nothing forever. Better to say why up front.
    errors.exportEntityId =
      "Consumption and production must be two different sensors.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return { ok: true, grid: { importEntityId, exportEntityId } };
}
