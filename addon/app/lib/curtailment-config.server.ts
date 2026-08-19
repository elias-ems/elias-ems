import {
  type CurtailmentConfig,
  DEFAULT_CURTAILMENT_CONFIG,
  normalizeCurtailmentConfig,
} from "./curtailment";
import { readJson, writeJson } from "./store.server";

const FILE_NAME = "curtailment.json";

export async function readCurtailmentConfig(): Promise<CurtailmentConfig> {
  return normalizeCurtailmentConfig(
    await readJson<Partial<CurtailmentConfig>>(
      FILE_NAME,
      DEFAULT_CURTAILMENT_CONFIG,
    ),
  );
}

export async function saveCurtailmentConfig(
  config: CurtailmentConfig,
): Promise<void> {
  await writeJson(FILE_NAME, config);
}
