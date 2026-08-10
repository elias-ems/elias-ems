import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type PvEntity = {
  id: string;
  title: string;
  powerEntityId: string;
  energyEntityId: string;
};

/** What callers may change — everything except the generated id. */
export type PvEntityFields = Omit<PvEntity, "id">;

const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.NODE_ENV === "production"
    ? "/data"
    : path.join(process.cwd(), "data"));
const FILE_PATH = path.join(DATA_DIR, "pv-entities.json");

/**
 * `title` was added after the first entries were already on disk, so stored
 * records may not have one. Fall back to the power entity id, which at least
 * tells two arrays apart, rather than showing every one of them as "Untitled".
 */
function normalize(entity: PvEntity): PvEntity {
  return { ...entity, title: entity.title?.trim() || entity.powerEntityId };
}

export async function listPvEntities(): Promise<PvEntity[]> {
  try {
    const contents = await fs.readFile(FILE_PATH, "utf-8");
    return (JSON.parse(contents) as PvEntity[]).map(normalize);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writePvEntities(entities: PvEntity[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE_PATH, JSON.stringify(entities, null, 2));
}

export async function addPvEntity(fields: PvEntityFields): Promise<PvEntity> {
  const entities = await listPvEntities();
  const entity: PvEntity = { id: crypto.randomUUID(), ...fields };
  entities.push(entity);
  await writePvEntities(entities);
  return entity;
}

export async function updatePvEntity(
  id: string,
  fields: PvEntityFields,
): Promise<PvEntity | null> {
  const entities = await listPvEntities();
  const entity = entities.find((candidate) => candidate.id === id);
  if (!entity) return null;

  Object.assign(entity, fields);
  await writePvEntities(entities);
  return entity;
}

export async function removePvEntity(id: string): Promise<void> {
  const entities = await listPvEntities();
  await writePvEntities(entities.filter((entity) => entity.id !== id));
}
