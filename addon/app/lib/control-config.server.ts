import {
  type ControlConfig,
  DEFAULT_CONTROL_CONFIG,
  normalizeControlConfig,
} from "./control";
import { readJson, writeJson } from "./store.server";

const FILE_NAME = "control.json";

export async function readControlConfig(): Promise<ControlConfig> {
  return normalizeControlConfig(
    await readJson<Partial<ControlConfig>>(FILE_NAME, DEFAULT_CONTROL_CONFIG),
  );
}

export async function saveControlConfig(config: ControlConfig): Promise<void> {
  await writeJson(FILE_NAME, config);
}
