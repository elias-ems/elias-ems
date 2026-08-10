/**
 * Everything the add-on remembers lives as JSON under the add-on's data
 * directory — `/data` in Home Assistant, which Supervisor persists across
 * restarts and updates. One file per concern, so a corrupt or hand-edited file
 * can only take out the feature it belongs to.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolved per call rather than at module load. The alternative bites in two
 * places: Vitest sets DATA_DIR per test file after ESM has already hoisted the
 * imports, and the control loop keeps this module alive for the whole life of
 * the process. Reading an environment variable is not worth caching.
 */
function dataDir(): string {
  return (
    process.env.DATA_DIR ||
    (process.env.NODE_ENV === "production"
      ? "/data"
      : path.join(process.cwd(), "data"))
  );
}

/** The stored contents of `fileName`, or `fallback` when it doesn't exist yet. */
export async function readJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const contents = await fs.readFile(path.join(dataDir(), fileName), "utf-8");
    return JSON.parse(contents) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(
  fileName: string,
  value: unknown,
): Promise<void> {
  const directory = dataDir();
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, fileName),
    JSON.stringify(value, null, 2),
  );
}

/** A stored record, identified by a generated id the UI edits and removes by. */
export type Identified = { id: string };

export type JsonCollection<TFields> = {
  list(): Promise<Array<TFields & Identified>>;
  add(fields: TFields): Promise<TFields & Identified>;
  /** Null when no record carries that id — it may have been removed already. */
  update(id: string, fields: TFields): Promise<(TFields & Identified) | null>;
  remove(id: string): Promise<void>;
};

/**
 * A list of records in one JSON file, addressed by id.
 *
 * `normalize` runs on every record as it is read. Fields get added to these
 * shapes over time, and records written before that are still on disk, so it is
 * where a missing field is given something sensible to be.
 */
export function createJsonCollection<TFields>(
  fileName: string,
  normalize: (record: TFields & Identified) => TFields & Identified = (
    record,
  ) => record,
): JsonCollection<TFields> {
  type Record = TFields & Identified;

  async function list(): Promise<Record[]> {
    const records = await readJson<Record[]>(fileName, []);
    return records.map(normalize);
  }

  return {
    list,

    async add(fields) {
      const records = await list();
      const record = { id: crypto.randomUUID(), ...fields } as Record;
      records.push(record);
      await writeJson(fileName, records);
      return record;
    },

    async update(id, fields) {
      const records = await list();
      const record = records.find((candidate) => candidate.id === id);
      if (!record) return null;

      Object.assign(record, fields);
      await writeJson(fileName, records);
      return record;
    },

    async remove(id) {
      const records = await list();
      await writeJson(
        fileName,
        records.filter((record) => record.id !== id),
      );
    },
  };
}
