/**
 * Writing a setpoint to a battery — the half that makes this control rather
 * than observation.
 *
 * Kept apart from the strategy, which stays pure, and from the loop, which is
 * about *when* to decide rather than how to act on a decision. What arrives
 * here is already a number in watts with the sign convention applied; what
 * leaves is a Home Assistant service call.
 */
import { callHaService, type HaState } from "./ha.server";

/**
 * How far the entity may already be from what we want before it is worth
 * writing again.
 *
 * The loop can tick every second, and a house is never still, so a strategy
 * that recalculates 4 W lower each time would otherwise produce a service call
 * every tick — thousands an hour, against hardware that on some brands commits
 * setpoints to flash. Wide enough to swallow that noise, narrow enough that it
 * is a rounding error against a battery worth steering at all.
 */
export const WRITE_DEADBAND_W = 50;

/**
 * The domains we know how to set, against the service that does it. Both take
 * the same `{ entity_id, value }`, which is why one table covers them.
 *
 * Anything else is refused rather than guessed at: this writes to hardware,
 * and a service invented from an entity id is exactly the kind of guess that
 * should fail loudly and change nothing.
 */
const SET_VALUE_DOMAINS = new Set(["number", "input_number"]);

export type WriteStatus =
  /** The service call went through. */
  | "written"
  /** The entity already reads what we want, within the deadband. */
  | "unchanged"
  /** Nothing to say to this battery — the decision was to leave it alone. */
  | "skipped"
  /** We don't know how to write to this entity's domain. */
  | "unsupported"
  /** Home Assistant refused, or could not be reached. */
  | "failed";

export type SetpointWrite = {
  batteryId: string;
  title: string;
  entityId: string;
  /** What was asked for, after rounding to the entity's step. Null when nothing was. */
  valueW: number | null;
  status: WriteStatus;
  /** Why, when the status alone doesn't say it. */
  detail?: string;
};

/** What the loop knows about one battery's target entity when it comes to write. */
export type SetpointTarget = {
  batteryId: string;
  title: string;
  entityId: string;
  /** The entity as last read, for its current value and its `step`. Null when missing. */
  state: HaState | null;
  /** What the strategy wants written, or null to leave the last setpoint alone. */
  commandW: number | null;
};

function attributeNumber(state: HaState | null, name: string): number | null {
  const raw = state?.attributes?.[name];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Snapped to the entity's own `step`, when it publishes one.
 *
 * Not cosmetic. A device that quantises 582 W to 580 W and reports the rounded
 * value back would otherwise leave a permanent difference between what we
 * asked for and what we read — small enough here that the deadband hides it,
 * but only by luck, and on a coarser step it would not. Rounding first makes
 * the read-back comparison exact.
 */
function toStep(value: number, state: HaState | null): number {
  const step = attributeNumber(state, "step");
  if (step === null || step <= 0) return Math.round(value);
  return Math.round(value / step) * step;
}

/** The `domain` half of an entity id. */
function domainOf(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}

/**
 * Writes one battery's setpoint, reporting what happened rather than throwing.
 *
 * Every outcome is a value, because every outcome is something the log should
 * be able to say out loud: a caller that only learned about failures could not
 * tell a quiet loop from one whose writes are all being skipped.
 */
async function writeOne(target: SetpointTarget): Promise<SetpointWrite> {
  const base = {
    batteryId: target.batteryId,
    title: target.title,
    entityId: target.entityId,
  };

  if (target.commandW === null) {
    return { ...base, valueW: null, status: "skipped" };
  }

  const domain = domainOf(target.entityId);
  if (!SET_VALUE_DOMAINS.has(domain)) {
    return {
      ...base,
      valueW: null,
      status: "unsupported",
      detail: `no set_value service for the ${domain || "unknown"} domain`,
    };
  }

  const valueW = toStep(target.commandW, target.state);
  const current = target.state ? Number(target.state.state) : Number.NaN;

  // Skipped when the entity already says what we want. This is also what makes
  // the write self-correcting: something else moving the entity shows up as a
  // difference on the next tick and is written back, with no memory of what we
  // last sent needed to notice.
  if (
    Number.isFinite(current) &&
    Math.abs(current - valueW) < WRITE_DEADBAND_W
  ) {
    return { ...base, valueW, status: "unchanged" };
  }

  try {
    await callHaService(domain, "set_value", {
      entity_id: target.entityId,
      value: valueW,
    });
    return { ...base, valueW, status: "written" };
  } catch (error) {
    return {
      ...base,
      valueW,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Writes every battery's setpoint, in parallel and independently.
 *
 * One battery's inverter being unreachable must not stop its neighbour being
 * told what to do, so nothing here rejects: each write resolves to its own
 * outcome and the caller decides what is worth logging.
 */
export async function writeSetpoints(
  targets: SetpointTarget[],
): Promise<SetpointWrite[]> {
  return Promise.all(targets.map(writeOne));
}

/**
 * The one line a tick's writes are worth in the log, or null when there is
 * nothing to say.
 *
 * Skips and unchanged writes are counted rather than named: on a balanced house
 * every tick produces a full set of them, and spelling each one out would bury
 * the writes that did happen under lines saying nothing happened.
 */
export function describeWrites(writes: SetpointWrite[]): string | null {
  const written = writes.filter((write) => write.status === "written");
  const trouble = writes.filter(
    (write) => write.status === "failed" || write.status === "unsupported",
  );

  const parts = written.map(
    (write) => `${write.title} → ${Math.round(write.valueW ?? 0)} W`,
  );

  for (const write of trouble) {
    parts.push(`${write.title}: write ${write.status} (${write.detail})`);
  }

  if (parts.length === 0) return null;
  return `Wrote: ${parts.join("; ")}`;
}
