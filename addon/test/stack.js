/**
 * Boots the whole add-on the way Home Assistant does: a mock Core API, the real
 * production server (`node server.js` against a real build, not the Vite dev
 * server), and an ingress proxy in front of it.
 *
 * Used two ways:
 *   - `node test/stack.js` — a local Home Assistant simulation to click through.
 *   - `startStack()` — the fixture behind the integration and end-to-end tests.
 *
 * The app is spawned as a child process rather than imported so that what gets
 * tested is the same entry point the Dockerfile runs.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHaMock } from "./ha-mock.js";
import { DEFAULT_INGRESS_TOKEN, startIngressProxy } from "./ingress-proxy.js";

const addonDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SERVER_BUILD = path.join(addonDir, "build", "server", "index.js");

/** Ask the OS for a port, then hand it to the child that will actually bind it. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * server.js logs one line once it is bound. Waiting for that beats polling the
 * port: a startup crash (a missing build, a port clash) rejects immediately
 * with the child's own stderr instead of timing out with nothing to show.
 */
function waitForListening(child, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `server.js did not start within ${timeout}ms\n${stderr || stdout}`,
        ),
      );
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
      if (stdout.includes("Server listening on")) finish(resolve, undefined);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("exit", (code) => {
      finish(
        reject,
        new Error(`server.js exited with code ${code}\n${stderr}`),
      );
    });
  });
}

/**
 * SIGTERM, then SIGKILL if the app is still there.
 *
 * `kill()` and a bare wait for `exit` is not enough, and the reason is worth
 * knowing before shortening this. Once battery control has been switched on,
 * `armShutdownRelease()` in control-loop.server.ts installs a `process.once`
 * handler for SIGTERM so the batteries get released on the way out — and
 * installing a handler *replaces* Node's default terminate. That handler
 * deliberately does not call `process.exit`, so what actually ends the process
 * is the event loop draining, which it never does: the Express listener and the
 * Home Assistant WebSocket are both still open. The app then ignores SIGTERM
 * for good.
 *
 * None of this shows on Windows, where `child.kill()` goes to `TerminateProcess`
 * and no handler ever runs. On Linux it hung `afterAll` until Vitest's 60s hook
 * timeout, in exactly the two suites that enable control — with every
 * assertion in them already passed.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} [grace] How long SIGTERM gets before SIGKILL follows.
 */
function stopApp(child, grace = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), grace);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.kill();
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.dataDir] Where pv-entities.json lives. Give tests
 *   their own so they don't scribble on the directory used for manual clicking.
 * @param {number} [options.appPort] Defaults to a free port.
 * @param {number} [options.haPort]
 * @param {number} [options.proxyPort]
 * @param {string} [options.ingressToken]
 * @param {Array<object>} [options.haStates] Overrides the fixture states.
 */
export async function startStack({
  dataDir = path.join(addonDir, "data"),
  appPort,
  haPort = 0,
  proxyPort = 0,
  ingressToken = DEFAULT_INGRESS_TOKEN,
  haStates,
} = {}) {
  if (!existsSync(SERVER_BUILD)) {
    throw new Error(
      `No production build found at ${SERVER_BUILD}.\n` +
        `Ingress behaviour only exists in the built server, so run \`npm run build\` first.`,
    );
  }

  const ha = await startHaMock({ port: haPort, states: haStates });
  const port = appPort ?? (await freePort());

  const app = spawn(process.execPath, ["server.js"], {
    cwd: addonDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      SUPERVISOR_API: ha.apiUrl,
      SUPERVISOR_WS: ha.wsUrl,
      SUPERVISOR_TOKEN: ha.token,
      DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForListening(app);
  } catch (error) {
    app.kill();
    await ha.close();
    throw error;
  }

  const proxy = await startIngressProxy({
    target: `http://127.0.0.1:${port}`,
    port: proxyPort,
    token: ingressToken,
  });

  return {
    ha,
    proxy,
    dataDir,
    /** The URL a browser would use, prefix and trailing slash included. */
    baseUrl: proxy.baseUrl,
    prefix: proxy.prefix,
    origin: proxy.origin,
    /** The app with no ingress in front of it — where none of the bugs show. */
    directUrl: `http://127.0.0.1:${port}`,
    /**
     * The reverse of the startup order, and the app has to be gone before the
     * mock it reconnects to.
     */
    async close() {
      await proxy.close();
      await stopApp(app);
      await ha.close();
    },
  };
}

// CLI mode: fixed ports, so the URL printed here stays the same between runs
// and can be bookmarked.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // A port clash or a missing build is an operator mistake, and both already
  // explain themselves — a stack trace would only bury the explanation.
  const stack = await startStack({
    proxyPort: Number(process.env.INGRESS_PORT) || 4000,
    appPort: Number(process.env.APP_PORT) || 4001,
    haPort: Number(process.env.HA_MOCK_PORT) || 4002,
    dataDir: process.env.DATA_DIR || undefined,
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });

  console.log(
    [
      "",
      "  Home Assistant simulation running:",
      "",
      `    Open this            ${stack.baseUrl}`,
      `    Mock HA Core API     ${stack.ha.apiUrl}`,
      `    App without ingress  ${stack.directUrl}  (bugs hide here — don't test against it)`,
      `    Data directory       ${stack.dataDir}`,
      "",
      "  Ctrl-C to stop.",
      "",
    ].join("\n"),
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stack.close().then(() => process.exit(0));
    });
  }
}
