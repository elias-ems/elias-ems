/**
 * The fast inner loop: the Vite dev server with hot reload, backed by a mock
 * Home Assistant so entities and readings actually appear.
 *
 * Deliberately *not* behind the ingress proxy. In dev, Vite serves modules and
 * HMR on its own terms and `server.js` isn't in the picture at all, so the
 * ingress prefix handling this project cares about doesn't exist here to be
 * exercised. Use `npm run start:ingress` (or the tests) for that.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHaMock } from "./ha-mock.js";

const addonDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// 4003, not the 4002 `npm run start:ingress` uses, so both can be up at once —
// a hot dev loop in one terminal and an ingress check in another is a normal
// way to work, and each stack wants its own mock anyway since tests and manual
// pokes both mutate its state.
// A port clash is an operator mistake, not a bug worth a stack trace.
const ha = await startHaMock({
  port: Number(process.env.HA_MOCK_PORT) || 4003,
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
console.log(`Mock Home Assistant Core API on ${ha.apiUrl}`);

const child = spawn(
  process.execPath,
  [
    path.join(addonDir, "node_modules", "@react-router", "dev", "bin.cjs"),
    "dev",
  ],
  {
    cwd: addonDir,
    env: {
      ...process.env,
      SUPERVISOR_API: ha.apiUrl,
      SUPERVISOR_WS: ha.wsUrl,
      SUPERVISOR_TOKEN: ha.token,
    },
    stdio: "inherit",
  },
);

child.on("exit", (code) => {
  ha.close().then(() => process.exit(code ?? 0));
});
