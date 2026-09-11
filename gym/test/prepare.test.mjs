import assert from "node:assert/strict";
import test from "node:test";
import { averagePrice, kwhFactor, payload, stateAt } from "../prepare.mjs";

test("normalizes accounting Wh without inflating it a thousandfold", () => {
  assert.equal(1 * kwhFactor("Wh"), 0.001);
  assert.equal(kwhFactor("kWh"), 1);
  assert.throws(() => kwhFactor(undefined));
});
test("tariffs are integrated by duration and unavailable history is rejected", () => {
  const rows = [
    { last_updated: "2026-09-10T00:00:00Z", state: "0.1" },
    { last_updated: "2026-09-10T00:05:00Z", state: "0.4" },
  ];
  assert.ok(
    Math.abs(
      averagePrice(
        rows,
        Date.parse("2026-09-10T00:00:00Z"),
        Date.parse("2026-09-10T00:15:00Z"),
      ) - 0.3,
    ) < 1e-9,
  );
  assert.throws(() => stateAt(rows, 0));
  assert.throws(() =>
    stateAt(
      [{ last_updated: "2026-09-10T00:00:00Z", state: "unavailable" }],
      Date.parse("2026-09-10T00:01:00Z"),
    ),
  );
});
test("truncated captures cannot silently form a dataset", () => {
  assert.throws(() =>
    payload({
      result: {
        structuredContent: {
          data: { success: true, entities: [{ has_more: true }] },
        },
      },
    }),
  );
});
