import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";
import express from "express";
import * as build from "./build/server/index.js";

installGlobals();

const app = express();

// remix-serve derives its static-file mount path from Vite's `base` config,
// which breaks once `base` is relative (needed for ingress compatibility).
// Serving assets ourselves at a fixed path sidesteps that.
app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

app.all("*", createRequestHandler({ build }));

const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
