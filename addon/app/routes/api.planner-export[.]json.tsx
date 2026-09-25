import { exportPlannerData } from "../lib/planner-export.server";
import type { Route } from "./+types/api.planner-export[.]json";

/** `2026-08-13T20-50-57`: a filename-safe ISO stamp, seconds resolution. */
function fileStamp(at: Date): string {
  return at.toISOString().slice(0, 19).replaceAll(":", "-");
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url);
  const batteryId = url.searchParams.get("batteryId") || undefined;
  try {
    const dataset = await exportPlannerData(batteryId);
    return new Response(JSON.stringify(dataset, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="elias-planner-export-${fileStamp(new Date())}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }, null, 2), {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}
