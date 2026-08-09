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

// The ingress proxy also serves this app at a path that's only known at request
// time, and strips that prefix before forwarding here — so the browser's real
// URL (and thus what React Router needs as its `basename` to hydrate without a
// mismatch) is otherwise invisible to us. Add the prefix back onto the request
// so React Router's server-side matching and the basename it embeds for client
// hydration both agree with what the browser sees.
app.use((req, res, next) => {
  const ingressPath = String(req.headers["x-ingress-path"] || "").replace(/\/+$/, "");
  if (!ingressPath) {
    return createRequestHandler({ build })(req, res, next);
  }
  // @react-router/express builds the Request URL from req.originalUrl, not req.url.
  req.url = ingressPath + req.url;
  req.originalUrl = ingressPath + req.originalUrl;
  return createRequestHandler({ build: { ...build, basename: ingressPath } })(
    req,
    res,
    next,
  );
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
