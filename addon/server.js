import { createRequestHandler } from "@react-router/express";
import express from "express";
import * as build from "./build/server/index.js";

const app = express();

// Note on CSRF: React Router compares an action request's Origin header against
// the request URL's host and rejects mismatches. That works unchanged behind
// ingress because Home Assistant's proxy forwards the browser's original Host
// header untouched (it filters Content-Length, Transfer-Encoding, its own auth
// tokens and the WebSocket headers — not Host). Do not turn on Express's
// `trust proxy` to "fix" this: HA sets no X-Forwarded-Host, and it passes
// client-supplied headers through, so trusting them would only widen what an
// attacker controls.

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

function buildForIngress(ingressPath) {
  let ingressBuild = ingressBuilds.get(ingressPath);
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
    // Trailing slash on purpose. React Router derives the `to="/"` link href
    // from the basename verbatim, and Home Assistant only routes ingress URLs
    // that keep the trailing slash — a bare `/api/hassio_ingress/<token>` 404s
    // at HA before it ever reaches this server. Without the slash the Home link
    // points at exactly that dead URL, so the app works until someone reloads
    // on it. The cost is that this build no longer matches the slashless form,
    // which is fine precisely because HA never forwards it.
    basename: ingressPath + "/",
    publicPath: ingressPath + build.publicPath,
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
  ingressBuilds.set(ingressPath, ingressBuild);
  return ingressBuild;
}

// Home Assistant serves this app at a path that's only known at request time,
// and strips that prefix before forwarding here — so the browser's real URL
// (and thus what React Router needs as its `basename` to hydrate without a
// mismatch) is otherwise invisible to us. Add the prefix back onto the request
// so React Router's server-side matching and the basename it embeds for client
// hydration both agree with what the browser sees.
const handlers = new Map();

function handlerFor(ingressPath) {
  let handler = handlers.get(ingressPath);
  if (!handler) {
    handler = createRequestHandler({
      build: ingressPath ? buildForIngress(ingressPath) : build,
    });
    handlers.set(ingressPath, handler);
  }
  return handler;
}

app.use((req, res, next) => {
  const ingressPath = String(req.headers["x-ingress-path"] || "").replace(/\/+$/, "");
  if (ingressPath) {
    // @react-router/express builds the Request URL from req.originalUrl, not req.url.
    req.url = ingressPath + req.url;
    req.originalUrl = ingressPath + req.originalUrl;
  }
  return handlerFor(ingressPath)(req, res, next);
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
