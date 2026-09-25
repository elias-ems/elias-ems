import { runPlanner } from "./planner";

self.onmessage = async (event: MessageEvent<unknown>) => {
  try {
    self.postMessage({ plan: await runPlanner(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
