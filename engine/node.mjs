import { Worker } from "node:worker_threads";
export function plan(input, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Planning cancelled"));
    const timeLimit = input?.timeLimitSeconds;
    if (!Number.isFinite(timeLimit) || timeLimit <= 0 || timeLimit > 120)
      return reject(new Error("Invalid solve budget"));
    const worker = new Worker(new URL("./node-worker.mjs", import.meta.url), {
      workerData: input,
      execArgv: [],
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error("Planning cancelled"));
    const timer = setTimeout(
      () => finish(new Error("Planning worker exceeded wall-clock deadline")),
      (timeLimit + 15) * 1000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) =>
      finish(message.error ? new Error(message.error) : null, message.result),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!finished) finish(new Error(`Planning worker exited ${code}`));
    });
  });
}
