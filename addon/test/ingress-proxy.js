/**
 * Mimics the Home Assistant ingress proxy in front of a locally running
 * `node server.js`, because loading the app directly on its own port hides
 * every ingress-specific bug: the prefix is what breaks asset URLs, link hrefs
 * and hydration, and without a proxy there is no prefix.
 *
 * What it reproduces, and why each part matters:
 *
 * - Serves the app only under `/api/hassio_ingress/<token>/`, and 404s anything
 *   outside it — including the bare prefix with no trailing slash, which real
 *   HA also refuses. That refusal is the entire reason `server.js` gives its
 *   basename a trailing slash, so a mock that quietly accepted it would make
 *   the regression test pass while the add-on stayed broken.
 * - Strips the prefix before forwarding, then announces it in `X-Ingress-Path`
 *   — the only channel through which the app can learn its own public URL.
 * - Forwards the browser's original `Host` untouched and sets no `X-Forwarded-*`
 *   headers, matching HA. React Router's action-origin CSRF check compares
 *   Origin against that Host, so getting this wrong would either mask a real
 *   CSRF failure or invent one that production never sees.
 *
 * Plain JavaScript on purpose — see the note in test/ha-mock.js.
 */
import http from "node:http";
import { listen } from "./listen.js";

/** Stands in for the per-session token HA mints; any opaque string will do. */
export const DEFAULT_INGRESS_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * @param {object} options
 * @param {string} options.target Origin of the app server, e.g. http://127.0.0.1:3000
 * @param {number} [options.port] 0 (the default) picks a free port.
 * @param {string} [options.token] Ingress session token to serve under.
 */
export async function startIngressProxy({
  target,
  port = 0,
  token = DEFAULT_INGRESS_TOKEN,
}) {
  const upstream = new URL(target);
  const prefix = `/api/hassio_ingress/${token}`;

  const server = http.createServer((req, res) => {
    const queryAt = req.url.indexOf("?");
    const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
    const search = queryAt === -1 ? "" : req.url.slice(queryAt);

    // Also rejects the bare prefix, which is deliberate — see the header comment.
    if (!pathname.startsWith(`${prefix}/`)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404: Not Found (nothing is served outside the ingress prefix)");
      return;
    }

    const headers = { ...req.headers };
    // HA filters these; leaving a stale content-length on a piped body would
    // hang the upstream request.
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    // `host` is deliberately left alone: it carries the browser's origin, which
    // is what the CSRF check needs to see.
    headers["x-ingress-path"] = prefix;

    const forwarded = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: pathname.slice(prefix.length) + search,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    forwarded.on("error", (error) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`502: ingress upstream unreachable (${error.message})`);
    });

    req.pipe(forwarded);
  });

  const boundPort = await listen(server, port, "The ingress proxy");
  const origin = `http://127.0.0.1:${boundPort}`;

  return {
    port: boundPort,
    token,
    prefix,
    origin,
    /** Trailing slash included — the form a browser must actually use. */
    baseUrl: `${origin}${prefix}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
