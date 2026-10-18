import { parentPort, workerData } from "node:worker_threads";
import { solve } from "./src/solve.ts";

try {
  parentPort.postMessage({ result: await solve(workerData) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
