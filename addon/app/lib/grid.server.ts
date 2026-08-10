import { EMPTY_GRID, type Grid, normalizeGrid } from "./grid";
import { readJson, writeJson } from "./store.server";

const FILE_NAME = "grid.json";

export async function readGrid(): Promise<Grid> {
  return normalizeGrid(await readJson<Partial<Grid>>(FILE_NAME, EMPTY_GRID));
}

export async function saveGrid(grid: Grid): Promise<void> {
  await writeJson(FILE_NAME, grid);
}
