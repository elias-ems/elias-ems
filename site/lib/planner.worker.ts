import wasmUrl from "../../engine/src/browser-wasm.ts";
import { compare } from "./comparison.ts";

self.onmessage = async (event) => {
  try {
    self.postMessage({
      comparison: await compare(
        event.data.dataset,
        event.data.options,
        wasmUrl,
      ),
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
