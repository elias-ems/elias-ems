import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.NODE_ENV === "production"
    ? "/data"
    : path.join(process.cwd(), "data"));
const FILE_PATH = path.join(DATA_DIR, "pv-entities.json");

export async function listPvEntities() {
  try {
    const contents = await fs.readFile(FILE_PATH, "utf-8");
    return JSON.parse(contents);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writePvEntities(entities) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE_PATH, JSON.stringify(entities, null, 2));
}

export async function addPvEntity({ powerEntityId, energyEntityId }) {
  const entities = await listPvEntities();
  const entity = { id: crypto.randomUUID(), powerEntityId, energyEntityId };
  entities.push(entity);
  await writePvEntities(entities);
  return entity;
}

export async function removePvEntity(id) {
  const entities = await listPvEntities();
  await writePvEntities(entities.filter((entity) => entity.id !== id));
}
