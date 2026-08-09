import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";
import express from "express";
import * as build from "./build/server/index.js";

installGlobals();

const app = express();

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

// Home Assistant's ingress proxy serves this app at a path that's only known
// at request time, and strips that prefix before forwarding here — so the
// browser's real URL (and thus what React Router needs as its `basename` to
// hydrate without a mismatch) is otherwise invisible to us. Add the prefix
// back onto the request so Remix's server-side matching and the basename it
// embeds for client hydration both agree with what the browser sees.
app.all("*", (req, res, next) => {
  const ingressPath = (req.headers["x-ingress-path"] || "").replace(/\/+$/, "");
  if (!ingressPath) {
    return createRequestHandler({ build })(req, res, next);
  }
  // @remix-run/express builds the Request URL from req.originalUrl, not req.url.
  req.url = ingressPath + req.url;
  req.originalUrl = ingressPath + req.originalUrl;
  return createRequestHandler({ build: { ...build, basename: ingressPath } })(
    req,
    res,
    next,
  );
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
