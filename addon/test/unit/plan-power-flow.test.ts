import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import PlanPowerFlow from "../../app/components/dashboard/PlanPowerFlow";
import type { ChargePlanPoint } from "../../app/lib/charge-plan";

it("shows the modeled grid balance and the three requested forecast series", () => {
  const point: ChargePlanPoint = {
    start: 0,
    end: 900_000,
    solarW: 4000,
    generatedSolarW: 3000,
    loadW: 2000,
    chargeW: 1500,
    dischargeW: 0,
    limitW: 2500,
    soc: 50,
    baselineSoc: 50,
    buy: 0.2,
    sell: 0.1,
    estimatedPrice: false,
  };
  const html = renderToStaticMarkup(
    createElement(PlanPowerFlow, {
      points: [point],
      times: { "0": "12:00", "900000": "12:15" },
    }),
  );

  expect(html).toContain("Import 500 W");
  expect(html).toContain("Solar");
  expect(html).toContain("3,000 W");
  expect(html).toContain("2,000 W");
  expect(html).toContain("Charging 1,500 W");
  expect(html).toContain("Forecast interval");
});
