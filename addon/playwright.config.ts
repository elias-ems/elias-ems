import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { DEFAULT_INGRESS_TOKEN } from "./test/ingress-proxy.js";

const INGRESS_PORT = 4000;
const BASE_URL = `http://127.0.0.1:${INGRESS_PORT}/api/hassio_ingress/${DEFAULT_INGRESS_TOKEN}/`;

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : [["list"], ["html", { open: "never" }]],

  use: {
    // Every test navigates relative to this, so the ingress prefix is always in
    // play — a test that accidentally hit the app directly would prove nothing.
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Not `npm run dev`: the ingress handling under test lives in server.js and
    // in the built asset manifest, neither of which the Vite dev server uses.
    command: "node test/stack.js",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      INGRESS_PORT: String(INGRESS_PORT),
      APP_PORT: "4001",
      HA_MOCK_PORT: "4002",
      // Its own directory, so a test run never touches whatever you've been
      // clicking together in `npm run start:ingress`.
      DATA_DIR: path.join(process.cwd(), "test", ".tmp", "e2e-data"),
    },
  },
});
