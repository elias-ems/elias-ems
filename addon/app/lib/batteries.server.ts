import { type BatteryFields, normalizeBattery } from "./batteries";
import { createJsonCollection } from "./store.server";

const collection = createJsonCollection<BatteryFields>(
  "batteries.json",
  normalizeBattery,
);

export const listBatteries = collection.list;
export const addBattery = async (fields: BatteryFields) =>
  normalizeBattery(await collection.add(fields));
export const updateBattery = collection.update;
export const removeBattery = collection.remove;
