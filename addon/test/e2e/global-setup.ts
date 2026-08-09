import { rm } from "node:fs/promises";
import path from "node:path";

/**
 * Clears the directory the end-to-end run stores PV entities in. A run that
 * fails partway leaves entries behind, and the next run would then start from a
 * dashboard that already has arrays on it.
 */
export default async function globalSetup() {
  await rm(path.join(process.cwd(), "test", ".tmp", "e2e-data"), {
    recursive: true,
    force: true,
  });
}
