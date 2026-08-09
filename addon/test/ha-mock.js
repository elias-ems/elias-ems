/**
 * A stand-in for the Home Assistant Core API that the Supervisor proxies at
 * `http://supervisor/core/api` — a hostname that only resolves inside a real
 * add-on container, which is why the app renders nothing useful outside Home
 * Assistant. Point `SUPERVISOR_API` at this server's `/core/api` instead.
 *
 * It serves the same path shape as the real thing rather than a bare `/states`
 * so that a URL built for one works against the other unchanged, and it checks
 * the bearer token because sending the wrong one (or none) is exactly the
 * failure this is meant to catch before it reaches Home Assistant.
 *
 * Plain JavaScript for the same reason as server.js: it is spawned directly by
 * node, with no build step in front of it.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SUPERVISOR_TOKEN = "test-supervisor-token";

/** The fixture the mock serves when a caller doesn't supply its own states. */
export async function defaultStates() {
  const contents = await readFile(
    path.join(here, "fixtures", "ha-states.json"),
    "utf-8",
  );
  return JSON.parse(contents);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 (the default) picks a free port.
 * @param {string} [options.token] Bearer token the mock will accept.
 * @param {Array<object>} [options.states] Overrides the fixture.
 */
export async function startHaMock({
  port = 0,
  token = DEFAULT_SUPERVISOR_TOKEN,
  states,
} = {}) {
  let current = states ?? (await defaultStates());

  /** Every request seen, so tests can assert the app actually called out. */
  const requests = [];

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: pathname });

    if (req.headers.authorization !== `Bearer ${token}`) {
      return sendJson(res, 401, { message: "Unauthorized" });
    }

    if (pathname === "/core/api/states") {
      return sendJson(res, 200, current);
    }

    const match = pathname.match(/^\/core\/api\/states\/(.+)$/);
    if (match) {
      const entityId = decodeURIComponent(match[1]);
      const state = current.find((entity) => entity.entity_id === entityId);
      return state
        ? sendJson(res, 200, state)
        : sendJson(res, 404, { message: "Entity not found." });
    }

    return sendJson(res, 404, { message: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const boundPort = server.address().port;

  return {
    port: boundPort,
    token,
    url: `http://127.0.0.1:${boundPort}`,
    /** What SUPERVISOR_API should be set to. */
    apiUrl: `http://127.0.0.1:${boundPort}/core/api`,
    requests,
    /** Swap the whole state list — for testing unavailable or missing entities. */
    setStates(next) {
      current = next;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
