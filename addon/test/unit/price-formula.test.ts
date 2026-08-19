/**
 * The formula language: that it computes what a contract says it should, and
 * that it cannot be talked into doing anything else.
 *
 * The second half is the point of hand-writing the parser at all, so the cases
 * asserting that an identifier goes nowhere are as load-bearing as the
 * arithmetic ones.
 */
import { describe, expect, it } from "vitest";
import {
  applyFormula,
  evaluateFormula,
  parseFormula,
} from "../../app/lib/price-formula";

/** The value or the failure message, whichever came back — compact for tables. */
function evaluate(source: string, price: number): number | string {
  const result = applyFormula(source, price);
  return result.ok ? result.value : result.error;
}

function expectRejected(source: string): string {
  const parsed = parseFormula(source);
  if (parsed.ok) {
    throw new Error(`Expected "${source}" to be rejected, but it parsed.`);
  }
  return parsed.error;
}

describe("arithmetic", () => {
  it("reads the price straight through", () => {
    expect(evaluate("price", 0.1821)).toBe(0.1821);
  });

  it("evaluates a bare constant, which is how a fixed tariff is written", () => {
    // The whole of "my feed-in is 5 c/kWh flat" — no second source, no extra
    // configuration shape, just a formula that ignores `price`.
    expect(evaluate("0.05", 0.1821)).toBe(0.05);
  });

  it("applies the worked consumption formula from the plan", () => {
    // ((price * 1.02) + 0.1272) * 1.06 — slope, fixed charge, then 6% VAT.
    expect(evaluate("((price * 1.02) + 0.1272) * 1.06", 0.1821)).toBeCloseTo(
      0.331719,
      6,
    );
  });

  it("applies the worked production formula from the plan", () => {
    expect(evaluate("price * 0.98 - 0.015", 0.1821)).toBeCloseTo(0.163458, 6);
  });

  it("gives multiplication precedence over addition", () => {
    expect(evaluate("1 + 2 * 3", 0)).toBe(7);
    expect(evaluate("(1 + 2) * 3", 0)).toBe(9);
  });

  it("subtracts and divides left to right", () => {
    expect(evaluate("10 - 3 - 2", 0)).toBe(5);
    expect(evaluate("12 / 3 / 2", 0)).toBe(2);
  });

  it("handles unary minus, including in front of a term", () => {
    expect(evaluate("-price", 0.2)).toBe(-0.2);
    expect(evaluate("2 * -3", 0)).toBe(-6);
    expect(evaluate("--price", 0.2)).toBe(0.2);
  });

  it("accepts a leading decimal point", () => {
    expect(evaluate(".5 * price", 0.2)).toBeCloseTo(0.1, 10);
  });

  it("ignores whitespace, including none at all", () => {
    expect(evaluate("price*1.02+0.1272", 0.1)).toBeCloseTo(0.2292, 10);
    expect(evaluate("  price   *   2  ", 0.1)).toBeCloseTo(0.2, 10);
  });
});

describe("min and max", () => {
  it("floors a feed-in tariff at zero, which is why they exist", () => {
    // A negative spot price is exactly when this matters: the contract pays
    // nothing rather than charging the household to export.
    expect(evaluate("max(price * 0.98 - 0.015, 0)", -0.05)).toBe(0);
    expect(evaluate("max(price * 0.98 - 0.015, 0)", 0.1821)).toBeCloseTo(
      0.163458,
      6,
    );
  });

  it("caps with min", () => {
    expect(evaluate("min(price, 0.25)", 0.4)).toBe(0.25);
    expect(evaluate("min(price, 0.25)", 0.1)).toBe(0.1);
  });

  it("nests", () => {
    expect(evaluate("max(min(price, 0.3), 0.05)", 0.4)).toBe(0.3);
    expect(evaluate("max(min(price, 0.3), 0.05)", 0.01)).toBe(0.05);
  });

  it("wants exactly two arguments", () => {
    expect(expectRejected("max(price)")).toMatch(/Expected ","/);
    expect(expectRejected("max(price, 0, 1)")).toMatch(/Expected "\)"/);
  });
});

describe("what a formula cannot reach", () => {
  // The reason this is a parser and not `new Function`. Each of these is a
  // valid JavaScript expression; none of them is a formula.
  it.each([
    "process.exit(1)",
    "globalThis",
    "require('fs')",
    "constructor",
    "this",
    "price.constructor",
    "(() => 1)()",
    "price; process.exit(1)",
  ])("rejects %j", (source) => {
    expect(parseFormula(source).ok).toBe(false);
  });

  it("names the only vocabulary there is", () => {
    expect(expectRejected("spot * 2")).toMatch(
      /"spot" isn't something a formula can use.*price, min, max/,
    );
  });

  it("rejects an assignment rather than defining anything", () => {
    expect(parseFormula("x = price").ok).toBe(false);
  });
});

describe("rejecting malformed formulas", () => {
  it("rejects an empty formula", () => {
    expect(expectRejected("")).toMatch(/required/);
    expect(expectRejected("   ")).toMatch(/required/);
  });

  it("rejects unbalanced parentheses", () => {
    expect(parseFormula("(price * 2").ok).toBe(false);
    expect(parseFormula("price * 2)").ok).toBe(false);
  });

  it("rejects a dangling operator", () => {
    expect(expectRejected("price *")).toMatch(
      /ends where a value was expected/,
    );
    expect(parseFormula("* price").ok).toBe(false);
  });

  it("rejects a leftover token after a complete expression", () => {
    // `price 2` is two valid things in a row, which is a typo, not a formula.
    expect(expectRejected("price 2")).toMatch(/Unexpected/);
  });

  it("points at where the problem is", () => {
    expect(expectRejected("price + $")).toMatch(/position 9/);
  });
});

describe("results that aren't numbers", () => {
  it("reports a division by zero rather than passing Infinity along", () => {
    // Not an exception and not Infinity: a price that isn't a real number would
    // render as "Infinity EUR/kWh" and compare false against every threshold.
    expect(evaluate("price / 0", 0.2)).toMatch(/division by zero/);
  });

  it("returns null from evaluateFormula for the same case", () => {
    const parsed = parseFormula("price / 0");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(evaluateFormula(parsed.formula, 0.2)).toBeNull();
  });

  it("still evaluates a division by zero away from the zero", () => {
    expect(evaluate("price / (price - price + 2)", 0.2)).toBeCloseTo(0.1, 10);
  });
});

describe("parse once, evaluate many", () => {
  it("reuses a parsed formula across prices", () => {
    const parsed = parseFormula("((price * 1.02) + 0.1272) * 1.06");
    if (!parsed.ok) throw new Error(parsed.error);

    expect(evaluateFormula(parsed.formula, 0.1821)).toBeCloseTo(0.331719, 6);
    expect(evaluateFormula(parsed.formula, 0)).toBeCloseTo(0.134832, 6);
    expect(evaluateFormula(parsed.formula, -0.2)).toBeCloseTo(-0.081408, 6);
  });
});
