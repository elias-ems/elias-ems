import fs from "node:fs/promises";
import path from "node:path";
import type { Battery } from "./batteries";
import { listBatteries } from "./batteries.server";
import {
  type ChargeLimitStatus,
  type ChargeLimitsData,
  chargeLimitControl,
} from "./charge-limit-status";
import { calculateChargePlan, numericState } from "./charge-planner.server";
import { readControlConfig } from "./control-config.server";
import { appendDiagnostic } from "./diagnostics.server";
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
const statuses = new Map<string, ChargeLimitStatus>();
let queue: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let recovered = false;
let nextPlan = 0;
const PLAN_MS = 300_000;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const close = (a: number | null, b: number) =>
  a !== null && Math.abs(a - b) < 0.001;

/** Serialize settings changes with actuation so a disabled battery cannot receive an old plan. */
export function withChargeLimitLock<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
}

export function invalidateChargePlans() {
  nextPlan = 0;
  for (const status of statuses.values()) {
    status.state = "waiting";
    status.validUntil = null;
    status.message = "Settings changed; calculating a new plan.";
  }
}

async function leases(): Promise<Lease[]> {
  const records = await readJson<Lease[]>("charge-limit-leases.json", []);
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
      "Charge-limit recovery data is invalid. No limit will be written.",
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
  const file = path.join(directory, "charge-limit-leases.json");
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
  await fs.rename(`${file}.tmp`, file);
}

/** Restore only a value we still own. A user's intervening edit wins. */
async function restore(lease: Lease) {
  lease.restoring = true;
  await saveLeases(
    (await leases()).map((l) => (l.entityId === lease.entityId ? lease : l)),
  );
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

/** Called inside the lock, before updating/removing a battery. */
export async function releaseChargeLimit(batteryId: string) {
  await restoreAll((await leases()).filter((l) => l.batteryId === batteryId));
  statuses.delete(batteryId);
  nextPlan = 0;
}

/** A failed direction must not prevent recovery of the other direction. */
async function restoreAll(records: Lease[]) {
  const errors: string[] = [];
  for (const lease of records) {
    try {
      await restore(lease);
    } catch (error) {
      errors.push(messageOf(error));
    }
  }
  if (errors.length) throw new Error(errors.join(" "));
}

function empty(b: Battery): ChargeLimitStatus {
  return {
    batteryId: b.id,
    title: b.title,
    mode: "preview",
    state: "waiting",
    message: "Waiting for the Energy dashboard forecast and household history.",
    calculatedAt: null,
    validUntil: null,
    reportedW: null,
    requestedW: null,
    reportedDischargeW: null,
    requestedDischargeW: null,
    plan: null,
    currency: "EUR",
    timeZone: "UTC",
    times: {},
    forecastEnd: null,
    sources: 0,
    historyHours: 0,
    solarMarginPercent: b.solarMarginPercent ?? 20,
    checks: {
      solar: "Waiting",
      history: "Waiting",
      prices: "Waiting",
      battery: "Waiting",
    },
  };
}

export async function readChargeLimits(): Promise<ChargeLimitsData> {
  // Do not take the execution lock: a cold history fetch can hold it for minutes.
  const [batteries, control, records] = await Promise.all([
    listBatteries(),
    readControlConfig(),
    leases(),
  ]);
  return {
    batteries: batteries
      .filter((b) => Boolean(b.chargeLimitEntityId))
      .map((b) => ({
        ...(statuses.get(b.id) || empty(b)),
        control: chargeLimitControl(
          control,
          b,
          batteries.length,
          records.some((l) => l.batteryId === b.id && l.paused),
        ),
      })),
  };
}

async function apply(
  b: Battery,
  entityId: string,
  desiredW: number,
  now: number,
) {
  const all = await leases();
  let lease = all.find((l) => l.entityId === entityId);
  const entity = await fetchHaState(entityId);
  const current = numericState(entity);
  const a = entity?.attributes;
  if (
    entity?.entity_id !== entityId ||
    !Number.isFinite(desiredW) ||
    a?.unit_of_measurement !== "W" ||
    typeof a.min !== "number" ||
    typeof a.max !== "number" ||
    typeof a.step !== "number" ||
    ![a.min, a.max, a.step].every(Number.isFinite) ||
    a.step <= 0 ||
    desiredW < a.min ||
    desiredW > a.max ||
    Math.abs(
      (desiredW - a.min) / a.step - Math.round((desiredW - a.min) / a.step),
    ) > 1e-6
  ) {
    throw new Error(
      `Power-limit unit or range changed for ${entityId} while calculating the plan.`,
    );
  }
  if (current === null)
    throw new Error(`Power-limit readback is unavailable for ${entityId}.`);
  if (lease?.paused)
    throw new Error(
      "Charge-limit control paused after an external change. Save the battery settings to resume.",
    );
  if (lease && !close(current, lease.requestedW)) {
    lease.paused = true;
    await saveLeases(all);
    throw new Error(
      `The power limit ${entityId} changed externally or was not accepted. Control is paused; save battery settings to resume.`,
    );
  }
  if (close(current, desiredW))
    return { reportedW: current, requestedW: current, throttled: false };
  if (lease && now - lease.at < PLAN_MS) {
    nextPlan = Math.min(nextPlan, lease.at + PLAN_MS);
    return {
      reportedW: current,
      requestedW: lease.requestedW,
      throttled: true,
    };
  }
  if (!lease) {
    lease = {
      batteryId: b.id,
      entityId,
      originalW: current,
      previousW: current,
      requestedW: desiredW,
      at: now,
    };
    all.push(lease);
  } else {
    lease.previousW = current;
    lease.requestedW = desiredW;
    lease.at = now;
  }
  // Persist before sending: even an ambiguous network failure has a recovery record.
  await saveLeases(all);
  await setHaChargeLimit(lease.entityId, desiredW);
  return { reportedW: current, requestedW: desiredW, throttled: false };
}

export async function chargeLimitTick(now = Date.now()) {
  const control = await readControlConfig();
  const active = control.enabled && control.strategy === "charge-limit";
  const batteries = await listBatteries();
  const enabled = batteries.filter((b) => Boolean(b.chargeLimitEntityId));
  const recover: Lease[] = [];
  for (const lease of await leases()) {
    const battery = batteries.find((b) => b.id === lease.batteryId);
    if (
      (!recovered && !lease.paused) ||
      lease.restoring ||
      !battery ||
      !active ||
      ![battery.chargeLimitEntityId, battery.dischargeLimitEntityId].includes(
        lease.entityId,
      )
    )
      recover.push(lease);
  }
  await restoreAll(recover);
  recovered = true;
  if (!enabled.length) return;
  if (now < nextPlan) {
    for (const b of enabled) {
      const status = statuses.get(b.id);
      if (!status) continue;
      for (const [entityId, field] of [
        [b.chargeLimitEntityId, "reportedW"],
        [b.dischargeLimitEntityId, "reportedDischargeW"],
      ] as const) {
        if (!entityId) continue;
        const reported = numericState(await fetchHaState(entityId));
        status[field] = reported;
        if (reported === null)
          throw new Error(
            "Power-limit readback is unavailable; restoring previous limits when reachable.",
          );
        const all = await leases();
        const lease = all.find((l) => l.entityId === entityId);
        if (
          lease &&
          !lease.paused &&
          now - lease.at > 60_000 &&
          !close(reported, lease.requestedW)
        ) {
          lease.paused = true;
          await saveLeases(all);
          status.state = "error";
          status.message =
            "A power limit was changed externally or not accepted. Save battery settings to resume.";
          status.validUntil = null;
          // Stop controlling the other direction too, preserving the user's edit.
          for (const other of (await leases()).filter(
            (l) => l.batteryId === b.id && !l.paused,
          ))
            await restore(other);
        }
      }
    }
    return;
  }
  nextPlan = now + PLAN_MS;
  for (const b of enabled) {
    const status = empty(b);
    statuses.set(b.id, status);
    try {
      status.reportedW = numericState(
        await fetchHaState(b.chargeLimitEntityId || ""),
      );
      if (b.dischargeLimitEntityId)
        status.reportedDischargeW = numericState(
          await fetchHaState(b.dischargeLimitEntityId),
        );
      // Independent single-battery plans would allocate the same solar twice.
      if (batteries.length !== 1)
        throw new Error(
          "Charge-limit planning currently supports one configured household battery.",
        );
      let blocked = [
        control.enabled &&
          control.strategy !== "charge-limit" &&
          "Hypothetical preview: assumes native self-consumption while another battery strategy is active.",
        b.steered &&
          "Turn off target-power steering for this battery before activating charge-limit control.",
        (await leases()).some((l) => l.batteryId === b.id && l.paused) &&
          "Control is paused after an external change. Save battery settings to resume.",
      ]
        .filter(Boolean)
        .join(" ");
      const result = await calculateChargePlan(b, now, (key, message) => {
        status.checks = { ...status.checks, [key]: message };
      });
      blocked = [blocked, result.controlBlocker].filter(Boolean).join(" ");
      const mayWrite = active && !blocked;
      const current = result.plan.points[0];
      nextPlan = Math.min(nextPlan, current.end);
      Object.assign(status, {
        mode: mayWrite ? "active" : "preview",
        plan: result.plan,
        calculatedAt: now,
        validUntil: Math.min(now + PLAN_MS, current.end),
        reportedW: result.reportedW,
        reportedDischargeW: result.reportedDischargeW ?? null,
        currency: result.currency,
        timeZone: result.timeZone,
        forecastEnd: result.forecastEnd,
        sources: result.sources,
        historyHours: result.historyHours,
        solarMarginPercent: result.solarMarginPercent,
        message: [blocked, result.planningNote, result.plan.reason]
          .filter(Boolean)
          .join(" "),
      });
      if (!result.reserveCovered) {
        status.message +=
          " Beyond the price horizon, a full reserve is valued because the next solar recovery is not covered.";
      }
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: result.timeZone,
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const end = result.plan.points[result.plan.points.length - 1].end;
      status.times = Object.fromEntries(
        [
          now,
          result.forecastEnd,
          current.start + (end - current.start) / 2,
          ...result.plan.points.flatMap((p) => [p.start, p.end]),
        ].map((t) => [String(t), formatter.format(t)]),
      );
      if (!mayWrite) {
        for (const lease of (await leases()).filter(
          (l) => l.batteryId === b.id && !l.paused,
        ))
          await restore(lease);
      }
      if (mayWrite) {
        // Do not publish a plan whose current interval ended while inputs were read.
        if (Date.now() >= current.end)
          throw new Error(
            "Plan expired during calculation; waiting for the next update.",
          );
        const applied = await apply(
          b,
          b.chargeLimitEntityId || "",
          current.limitW,
          Date.now(),
        );
        status.reportedW = applied.reportedW;
        status.requestedW = applied.requestedW;
        if (b.dischargeLimitEntityId) {
          if (current.dischargeLimitW === undefined)
            throw new Error(
              "The plan has no AC output limit; restoring previous limits.",
            );
          const output = await apply(
            b,
            b.dischargeLimitEntityId,
            current.dischargeLimitW,
            Date.now(),
          );
          status.reportedDischargeW = output.reportedW;
          status.requestedDischargeW = output.requestedW;
          applied.throttled ||= output.throttled;
        }
        status.message += applied.throttled
          ? " Holding the previous limit until the five-minute write interval has elapsed."
          : " Readback is checked every 30 seconds.";
      }
      // Readers can poll during apply/restore; publish readiness only once done.
      status.state = mayWrite ? "active" : "preview";
      appendDiagnostic(
        "charge-limit",
        "info",
        `${b.title}: ${status.mode}, maximum charge ${current.limitW} W${current.dischargeLimitW === undefined ? "" : `, maximum AC output ${current.dischargeLimitW} W`}. ${status.message}`,
      );
    } catch (error) {
      status.state = "error";
      status.message = messageOf(error);
      status.validUntil = null;
      for (const lease of (await leases()).filter(
        (l) => l.batteryId === b.id && !l.paused,
      )) {
        try {
          await restore(lease);
          status.message += " Previous power limit restored.";
        } catch (failure) {
          status.message += ` ${messageOf(failure)} Restoration will be retried.`;
        }
      }
      appendDiagnostic("charge-limit", "warn", `${b.title}: ${status.message}`);
    }
  }
}

export function startChargeLimitLoop() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      await withChargeLimitLock(() => chargeLimitTick());
    } catch (error) {
      for (const s of statuses.values()) {
        s.state = "error";
        s.validUntil = null;
        s.message = messageOf(error);
      }
      appendDiagnostic("charge-limit", "error", messageOf(error));
      await withChargeLimitLock(async () => {
        try {
          await restoreAll((await leases()).filter((lease) => !lease.paused));
        } catch (failure) {
          appendDiagnostic(
            "charge-limit",
            "error",
            `Charge-limit restoration will be retried: ${messageOf(failure)}`,
          );
        }
      });
    } finally {
      timer = setTimeout(run, 30_000);
      timer.unref?.();
    }
  };
  void run();
}
