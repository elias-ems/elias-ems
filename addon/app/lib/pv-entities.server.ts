import { normalizePvEntity, type PvEntityFields } from "./pv-entities";
import { createJsonCollection } from "./store.server";

const collection = createJsonCollection<PvEntityFields>(
  "pv-entities.json",
  normalizePvEntity,
);

export const listPvEntities = collection.list;
export const addPvEntity = collection.add;
export const updatePvEntity = collection.update;
export const removePvEntity = collection.remove;
