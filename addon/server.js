import { createRequestHandler } from "@react-router/express";
import express from "express";
import * as build from "./build/server/index.js";

const app = express();

// Note on CSRF: React Router compares an action request's Origin header against
// the request URL's host and rejects mismatches — and *only* for actions, which
// is why a deployment where the two disagree serves every page perfectly and
// fails every save. What the browser sees in that case is the app's error
// boundary over "Unexpected Server Error"; what the log gets is `Error: Bad
// Request` from `singleFetchAction`, with nothing in either naming an origin.
//
// Usually the two agree, because Home Assistant's proxy forwards the browser's
// original Host untouched (it filters Content-Length, Transfer-Encoding, its own
// auth tokens and the WebSocket headers — not Host). But that is not universal:
// reached through Nabu Casa or a reverse proxy in front of HA, the Host that
// arrives here can be the internal one while the browser posts from the public
// name. Where that happens the proxy says so in `X-Forwarded-Host`, so an
// ingress request also allows the host named there.
//
// Trusting that header is safe *here* and would not be in general: config.yaml
// declares `ingress: true` with no `ports:`, so this server is reachable only
// from Supervisor's proxy, which is what sets it. Nothing a browser sends can
// reach this port to forge it.
//
// Do not turn on Express's `trust proxy` to do the same job. That would make
// Express prefer X-Forwarded-Host for `req.url` itself, so Origin would be
// compared against a header instead of against Host, and the check would pass
// by construction rather than by agreeing.

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

// `basename` fixes routing, but not assets: Vite bakes the client bundle URLs
// into the manifest at build time using `publicPath`, which is a fixed "/" and
// cannot know the per-session ingress prefix. Left alone they render as
// `/assets/x.js`, which the browser resolves against the Home Assistant origin
// rather than the ingress path — HA has nothing there, so every script 404s and
// the page never hydrates. Rewrite the manifest per prefix so the browser asks
// for `<prefix>/assets/x.js`; HA then strips the prefix back off and the static
// middleware above serves it. `routeDiscovery.manifestPath` is deliberately not
// rewritten — React Router already resolves that one against `basename`.
const ingressBuilds = new Map();

function buildForIngress(ingressPath, allowedActionOrigins) {
  const key = `${ingressPath}\n${allowedActionOrigins.join(",")}`;
  let ingressBuild = ingressBuilds.get(key);
  if (ingressBuild) return ingressBuild;

  const prefix = (url) =>
    typeof url === "string" && url.startsWith("/") ? ingressPath + url : url;
  const prefixModule = (mod) => ({
    ...mod,
    module: prefix(mod.module),
    imports: mod.imports?.map(prefix),
    css: mod.css?.map(prefix),
  });

  ingressBuild = {
    ...build,
    // The browser-facing host, when the proxy in front of us reports one that
    // differs from the Host it forwarded. See the CSRF note at the top.
    allowedActionOrigins,
    // Trailing slash on purpose. React Router derives the `to="/"` link href
    // from the basename verbatim, and Home Assistant only routes ingress URLs
    // that keep the trailing slash — a bare `/api/hassio_ingress/<token>` 404s
    // at HA before it ever reaches this server. Without the slash the Home link
    // points at exactly that dead URL, so the app works until someone reloads
    // on it. The cost is that this build no longer matches the slashless form,
    // which is fine precisely because HA never forwards it.
    basename: `${ingressPath}/`,
    publicPath: `${ingressPath}${build.publicPath}`,
    assets: {
      ...build.assets,
      url: prefix(build.assets.url),
      entry: prefixModule(build.assets.entry),
      routes: Object.fromEntries(
        Object.entries(build.assets.routes).map(([id, route]) => [
          id,
          prefixModule(route),
        ]),
      ),
    },
  };
  ingressBuilds.set(key, ingressBuild);
  return ingressBuild;
}

/**
 * The host the browser actually asked for, as the proxy reports it, or "" when
 * it reports nothing.
 *
 * Only the first entry: a chain of proxies appends to this header, and the
 * leftmost is the one the browser used. Port included, because that is what
 * React Router compares an Origin's host against.
 */
function forwardedHostOf(req) {
  return String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
}

/**
 * Says out loud what an action's Origin was compared against, the first time
 * each distinct disagreement is seen.
 *
 * Without this the whole failure is one `Error: Bad Request` with a stack trace
 * into React Router's internals — no origin, no host, no hint that the two are
 * even the subject. Once per distinct triple rather than per request, because a
 * page whose every save fails will produce this on every attempt.
 */
const reportedOriginMismatches = new Set();

function warnOnUnmatchedOrigin(req, forwardedHost) {
  if (req.method === "GET" || req.method === "HEAD") return;

  const origin = req.headers.origin;
  if (!origin || origin === "null") return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return;
  }

  const host = String(req.headers.host || "");
  if (originHost === host || originHost === forwardedHost) return;

  const key = `${originHost}|${host}|${forwardedHost}`;
  if (reportedOriginMismatches.has(key)) return;
  reportedOriginMismatches.add(key);

  console.warn(
    `Refusing an action: the browser posted from "${originHost}", but this request arrived with Host "${host}" and ` +
      (forwardedHost
        ? `X-Forwarded-Host "${forwardedHost}"`
        : "no X-Forwarded-Host") +
      '. React Router rejects that as cross-origin, which the page shows as "Unexpected Server Error". ' +
      "Every page still loads; only saving fails. Please report these three values.",
  );
}

// Home Assistant serves this app at a path that's only known at request time,
// and strips that prefix before forwarding here — so the browser's real URL
// (and thus what React Router needs as its `basename` to hydrate without a
// mismatch) is otherwise invisible to us. Add the prefix back onto the request
// so React Router's server-side matching and the basename it embeds for client
// hydration both agree with what the browser sees.
const handlers = new Map();

function handlerFor(ingressPath, forwardedHost) {
  const key = `${ingressPath}\n${forwardedHost}`;
  let handler = handlers.get(key);
  if (!handler) {
    handler = createRequestHandler({
      build: ingressPath
        ? buildForIngress(ingressPath, forwardedHost ? [forwardedHost] : [])
        : build,
    });
    handlers.set(key, handler);
  }
  return handler;
}

app.use((req, res, next) => {
  const ingressPath = String(req.headers["x-ingress-path"] || "").replace(
    /\/+$/,
    "",
  );
  const forwardedHost = ingressPath ? forwardedHostOf(req) : "";
  if (ingressPath) {
    // @react-router/express builds the Request URL from req.originalUrl, not req.url.
    req.url = ingressPath + req.url;
    req.originalUrl = ingressPath + req.originalUrl;
    warnOnUnmatchedOrigin(req, forwardedHost);
  }
  return handlerFor(ingressPath, forwardedHost)(req, res, next);
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
