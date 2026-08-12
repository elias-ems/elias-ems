/**
 * What the debug box on the home page polls while it is open.
 *
 * Separate from the home loader on purpose: that one reads every configured
 * Home Assistant entity, which is far too much work to repeat every couple of
 * seconds, and its ten-second cadence is far too slow to watch a five-second
 * loop with. This route touches nothing but memory.
 */
import type { ControlLogData } from "../lib/control";
import { readControlLog } from "../lib/control-log.server";
import { controlLoopStatus } from "../lib/control-loop.server";

export async function loader(): Promise<ControlLogData> {
  return { status: controlLoopStatus(), entries: readControlLog() };
}
