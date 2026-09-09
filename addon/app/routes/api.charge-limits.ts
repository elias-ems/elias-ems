import { readChargeLimits } from "../lib/charge-limit-loop.server";

export async function loader() {
  return Response.json(await readChargeLimits(), {
    headers: { "Cache-Control": "no-store" },
  });
}
