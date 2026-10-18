/**
 * Putting back the power limits an earlier version wrote directly.
 *
 * Before the battery command event, Optimize charge limits called
 * `number.set_value` on a battery's charge and AC output limit entities and
 * journalled each entity's original value in `charge-limit-leases.json` first.
 * The strategy now only publishes commands, so nothing will ever restore those
 * values unless this does: an upgrade mid-plan would otherwise leave the
 * battery capped at whatever the last plan asked for, indefinitely.
 *
 * This module only ever *restores*. It never writes a new lease, and once the
 * journal is empty it does nothing at all. A battery with a lease still
 * outstanding gets no command until its limits are back — two controllers
 * steering one battery is the failure the migration exists to avoid.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { numericState } from "./charge-planner.server";
import { fetchHaState, setHaChargeLimit } from "./ha.server";
import { readJson } from "./store.server";

type Lease = {
  batteryId: string;
  entityId: string;
  originalW: number;
  requestedW: number;
  previousW: number;
  at: number;
  paused?: boolean;
  restoring?: boolean;
};

const FILE = "charge-limit-leases.json";
const close = (a: number | null, b: number) =>
  a !== null && Math.abs(a - b) < 0.001;

async function leases(): Promise<Lease[]> {
  const records = await readJson<Lease[]>(FILE, []);
  if (
    !Array.isArray(records) ||
    records.some(
      (l) =>
        !l ||
        typeof l.batteryId !== "string" ||
        typeof l.entityId !== "string" ||
        !/^number\.[a-z0-9_]+$/.test(l.entityId) ||
        ![l.originalW, l.requestedW, l.previousW, l.at].every(
          (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
        ),
    )
  ) {
    throw new Error(
      "Charge-limit recovery data from an earlier version is invalid; restore the battery's power limits by hand and delete charge-limit-leases.json.",
    );
  }
  return records;
}

async function saveLeases(value: Lease[]) {
  const directory =
    process.env.DATA_DIR ||
    (process.env.NODE_ENV === "production"
      ? "/data"
      : path.join(process.cwd(), "data"));
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, FILE);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Restore one entity — but only a value we still own. If the entity no longer
 * reads what we last wrote, somebody changed it since, and their edit wins.
 */
async function restore(lease: Lease) {
  const state = await fetchHaState(lease.entityId);
  const current = numericState(state);
  if (current === null)
    throw new Error(
      `Cannot restore ${lease.entityId}: the entity is unavailable.`,
    );
  if (close(current, lease.requestedW) || close(current, lease.previousW)) {
    const min = state?.attributes?.min;
    const max = state?.attributes?.max;
    if (
      state?.attributes?.unit_of_measurement !== "W" ||
      typeof min !== "number" ||
      typeof max !== "number" ||
      lease.originalW < min ||
      lease.originalW > max
    ) {
      throw new Error(
        `Cannot restore ${lease.entityId}: its range or unit changed.`,
      );
    }
    if (!close(current, lease.originalW)) {
      await setHaChargeLimit(lease.entityId, lease.originalW);
      const confirmed = numericState(await fetchHaState(lease.entityId));
      if (!close(confirmed, lease.originalW))
        throw new Error(
          `Waiting for ${lease.entityId} to confirm restoration to ${lease.originalW} W.`,
        );
    }
  }
  await saveLeases(
    (await leases()).filter((l) => l.entityId !== lease.entityId),
  );
}

export type LegacyRestore = {
  /** Batteries with a limit still waiting to be put back. */
  pending: Set<string>;
  /** What went wrong on the way, one message per entity. */
  errors: string[];
  /** Entities put back (or found already let go) during this call. */
  restored: string[];
};

/**
 * Restore every journalled limit, each independently: one unreachable entity
 * must not keep the other direction capped. Failures stay in the journal and
 * are retried on the next call.
 */
export async function restoreLegacyLimits(): Promise<LegacyRestore> {
  const result: LegacyRestore = {
    pending: new Set(),
    errors: [],
    restored: [],
  };
  let records: Lease[];
  try {
    records = await leases();
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    // Unreadable journal: assume every battery might still be capped.
    result.pending.add("*");
    return result;
  }
  for (const lease of records) {
    try {
      await restore(lease);
      result.restored.push(lease.entityId);
    } catch (error) {
      result.pending.add(lease.batteryId);
      result.errors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return result;
}
