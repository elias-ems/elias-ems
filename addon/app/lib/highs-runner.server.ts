/**
 * Runs the HiGHS engine for the add-on, on a worker thread.
 *
 * The engine is a separate project (`engine/`) whose Node entry spawns a
 * worker per solve and enforces its own wall-clock deadline, so a slow or
 * stuck solve never blocks the server's event loop. It is imported at runtime
 * from its own directory rather than bundled: Vite would otherwise inline
 * `node.mjs` and lose the worker file it resolves next to itself, and the
 * WASM solver ships inside the engine's own `node_modules/highs`.
 *
 * `ENGINE_DIR` overrides where it lives; the default is the repository layout,
 * `../engine` beside the add-on, which the Docker image reproduces as
 * `/app/engine` beside `/app/addon`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Input } from "../../../engine/src/types.ts";
import type { HighsSolveResult } from "./strategies/types.ts";

type EngineModule = {
  plan: (
    input: Input,
    options?: { signal?: AbortSignal },
  ) => Promise<HighsSolveResult>;
};

let engine: Promise<EngineModule> | undefined;

export function engineDir(): string {
  return process.env.ENGINE_DIR
    ? path.resolve(process.env.ENGINE_DIR)
    : path.resolve(process.cwd(), "..", "engine");
}

function loadEngine(): Promise<EngineModule> {
  engine ??= import(
    /* @vite-ignore */ pathToFileURL(path.join(engineDir(), "node.mjs")).href
  ).catch((error: unknown) => {
    engine = undefined;
    throw new Error(
      `The HiGHS planning engine is not available at ${engineDir()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }) as Promise<EngineModule>;
  return engine;
}

/** Solve on a worker thread; rejects on timeout, cancellation or a crash. */
export async function solveHighs(
  input: Input,
  signal?: AbortSignal,
): Promise<HighsSolveResult> {
  const { plan } = await loadEngine();
  return plan(input, { signal });
}
