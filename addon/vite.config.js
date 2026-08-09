import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs so they resolve correctly when served through Home
  // Assistant's ingress proxy at an arbitrary, dynamic sub-path.
  base: "./",
  plugins: [remix()],
});
