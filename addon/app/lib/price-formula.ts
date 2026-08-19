/**
 * The little arithmetic language the price formulas are written in.
 *
 * A dynamic tariff is the exchange price put through the contract's own
 * arithmetic — `((price * 1.02) + 0.1272) * 1.06` for consumption, `price *
 * 0.98 - 0.015` for injection — and every supplier's is different. Rather than
 * guess at a set of fields (slope, markup, VAT, floor) that would need widening
 * for the next contract, the user types the arithmetic. This is the parser and
 * evaluator for it.
 *
 * `price` is in the currency per kWh, deliberately the same unit evcc's
 * `formula` uses, so a formula written for evcc ports over verbatim. The
 * alternative — per MWh, as the raw APIs publish — would silently turn every
 * ported formula into a 1000x error.
 *
 * Pure, so the settings form can preview a formula in the browser using the
 * identical code the server will evaluate it with.
 *
 * ## Why this is hand-written
 *
 * **Not `eval` or `new Function`.** The formula arrives from a JSON file under
 * the add-on's data directory. Compiling it to JavaScript would turn a
 * hand-edited `prices.json` into arbitrary code execution inside a container
 * that holds `SUPERVISOR_TOKEN` in its environment, which is a privilege
 * escalation rather than a theoretical concern.
 *
 * **Not a dependency either.** `mathjs` brings units, matrices and symbolic
 * algebra; `expr-eval` still ships variable assignment and user-defined
 * functions. All of that is surface, none of it is wanted, and the grammar
 * actually needed is four operators and two functions. The only identifier
 * reachable from a parsed formula is `price` — there is no environment to
 * escape into, because none is ever constructed.
 */

/** The one variable a formula may read: the market price, in currency/kWh. */
export const PRICE_VARIABLE = "price";

/** The functions a formula may call. Both take exactly two arguments. */
const FUNCTIONS = {
  min: Math.min,
  max: Math.max,
} as const;

type FunctionName = keyof typeof FUNCTIONS;

/**
 * A parsed formula, ready to evaluate.
 *
 * Opaque on purpose: callers parse once and evaluate many times, and nothing
 * outside this module has a reason to walk the tree.
 */
export type Formula = { readonly node: Node };

type Node =
  | { kind: "number"; value: number }
  | { kind: "price" }
  | { kind: "negate"; operand: Node }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { kind: "call"; name: FunctionName; args: [Node, Node] };

type Token =
  | { kind: "number"; value: number; at: number }
  | { kind: "name"; value: string; at: number }
  | { kind: "symbol"; value: string; at: number };

/**
 * Thrown internally and caught at the module boundary, so the recursive descent
 * below can bail from any depth without every function returning a result type.
 * Never escapes: `parseFormula` is the only entry point and it always catches.
 */
class FormulaError extends Error {}

const SYMBOLS = new Set(["+", "-", "*", "/", "(", ")", ","]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < source.length) {
    const character = source[at];

    if (/\s/.test(character)) {
      at += 1;
      continue;
    }

    if (SYMBOLS.has(character)) {
      tokens.push({ kind: "symbol", value: character, at });
      at += 1;
      continue;
    }

    // Digits or a leading decimal point, so both `0.5` and `.5` parse.
    if (/[0-9.]/.test(character)) {
      const start = at;
      while (at < source.length && /[0-9]/.test(source[at])) at += 1;
      if (source[at] === ".") {
        at += 1;
        while (at < source.length && /[0-9]/.test(source[at])) at += 1;
      }

      const text = source.slice(start, at);
      const value = Number(text);
      // A bare "." reaches here as NaN, and so would "1.2.3" via the loop above
      // stopping at the second dot and leaving it as an unexpected character.
      if (!Number.isFinite(value)) {
        throw new FormulaError(
          `"${text}" is not a number (at position ${start + 1}).`,
        );
      }
      tokens.push({ kind: "number", value, at: start });
      continue;
    }

    if (/[a-zA-Z_]/.test(character)) {
      const start = at;
      while (at < source.length && /[a-zA-Z_0-9]/.test(source[at])) at += 1;
      tokens.push({ kind: "name", value: source.slice(start, at), at: start });
      continue;
    }

    throw new FormulaError(
      `"${character}" can't be used in a formula (at position ${at + 1}).`,
    );
  }

  return tokens;
}

/**
 * Recursive descent over
 *
 * ```
 * expression := term (('+' | '-') term)*
 * term       := unary (('*' | '/') unary)*
 * unary      := '-' unary | primary
 * primary    := NUMBER | 'price' | '(' expression ')'
 *             | ('min' | 'max') '(' expression ',' expression ')'
 * ```
 *
 * Unary minus recurses into itself rather than being a flag on `primary`, so
 * `--price` is a parse rather than a special case, and it binds tighter than
 * `*` so that `2 * -3` needs no parentheses.
 */
function parseTokens(tokens: Token[], source: string): Node {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  const describe = (token: Token | undefined): string =>
    token === undefined
      ? "the end of the formula"
      : `"${token.kind === "number" ? token.value : token.value}" (at position ${token.at + 1})`;

  function expectSymbol(value: string): void {
    const token = peek();
    if (token?.kind !== "symbol" || token.value !== value) {
      throw new FormulaError(
        `Expected "${value}" but found ${describe(token)}.`,
      );
    }
    position += 1;
  }

  function nextIsSymbol(...values: string[]): string | null {
    const token = peek();
    if (token?.kind === "symbol" && values.includes(token.value)) {
      position += 1;
      return token.value;
    }
    return null;
  }

  function primary(): Node {
    const token = peek();

    if (token === undefined) {
      throw new FormulaError("The formula ends where a value was expected.");
    }

    if (token.kind === "number") {
      position += 1;
      return { kind: "number", value: token.value };
    }

    if (token.kind === "name") {
      position += 1;

      if (token.value === PRICE_VARIABLE) return { kind: "price" };

      if (token.value in FUNCTIONS) {
        const name = token.value as FunctionName;
        expectSymbol("(");
        const first = expression();
        expectSymbol(",");
        const second = expression();
        expectSymbol(")");
        return { kind: "call", name, args: [first, second] };
      }

      // The one place the closed vocabulary is enforced. Anything that isn't
      // `price`, `min` or `max` stops here rather than resolving against some
      // scope, because there is no scope to resolve against.
      throw new FormulaError(
        `"${token.value}" isn't something a formula can use (at position ${token.at + 1}). Available: ${PRICE_VARIABLE}, min, max.`,
      );
    }

    if (token.value === "(") {
      position += 1;
      const inner = expression();
      expectSymbol(")");
      return inner;
    }

    throw new FormulaError(`Expected a value but found ${describe(token)}.`);
  }

  function unary(): Node {
    if (nextIsSymbol("-")) return { kind: "negate", operand: unary() };
    return primary();
  }

  function term(): Node {
    let left = unary();
    for (;;) {
      const operator = nextIsSymbol("*", "/");
      if (!operator) return left;
      left = {
        kind: "binary",
        operator: operator as "*" | "/",
        left,
        right: unary(),
      };
    }
  }

  function expression(): Node {
    let left = term();
    for (;;) {
      const operator = nextIsSymbol("+", "-");
      if (!operator) return left;
      left = {
        kind: "binary",
        operator: operator as "+" | "-",
        left,
        right: term(),
      };
    }
  }

  if (tokens.length === 0) {
    throw new FormulaError("A formula is required.");
  }

  const node = expression();

  // Reaching the end matters: `price 2` parses a complete expression and then
  // has a token left over, which is a typo rather than a formula.
  const trailing = peek();
  if (trailing !== undefined) {
    throw new FormulaError(
      `Unexpected ${describe(trailing)} after the end of the formula "${source.slice(0, trailing.at).trim()}".`,
    );
  }

  return node;
}

export type ParseResult =
  | { ok: true; formula: Formula }
  | { ok: false; error: string };

/**
 * Parse `source`, or say why it can't be.
 *
 * The settings action calls this before storing anything, so that a formula
 * that first fails at 03:00 is impossible: what reaches disk has already
 * parsed. `evaluateFormula` still has to handle a stored formula that no longer
 * parses, because a hand-edited file never went through this.
 */
export function parseFormula(source: string): ParseResult {
  try {
    return {
      ok: true,
      formula: { node: parseTokens(tokenize(source), source) },
    };
  } catch (error) {
    if (error instanceof FormulaError)
      return { ok: false, error: error.message };
    throw error;
  }
}

function evaluate(node: Node, price: number): number {
  switch (node.kind) {
    case "number":
      return node.value;
    case "price":
      return price;
    case "negate":
      return -evaluate(node.operand, price);
    case "call":
      return FUNCTIONS[node.name](
        evaluate(node.args[0], price),
        evaluate(node.args[1], price),
      );
    case "binary": {
      const left = evaluate(node.left, price);
      const right = evaluate(node.right, price);
      switch (node.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
      }
    }
  }
}

/**
 * The formula applied to `price`, or null when the answer isn't a real number.
 *
 * Null rather than a thrown error or a NaN passed along, for the same reason
 * `toNumber` in `readings.server.ts` returns null: a price of NaN would render
 * as "NaN EUR/kWh" and, worse, would compare false against every threshold a
 * strategy might later test it with. Division by zero is the way in — `price /
 * 0` is Infinity, which is arithmetic doing exactly what it should with a
 * formula that asked for nonsense.
 */
export function evaluateFormula(
  formula: Formula,
  price: number,
): number | null {
  const value = evaluate(formula.node, price);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse and evaluate in one go — the settings preview, which re-parses on every
 * keystroke anyway, and the tests.
 *
 * The read path parses once per read instead. Both are cheap: these formulas
 * are a dozen tokens long.
 */
export function applyFormula(
  source: string,
  price: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed;

  const value = evaluateFormula(parsed.formula, price);
  if (value === null) {
    return {
      ok: false,
      error: `The formula doesn't produce a number at ${price} — check for a division by zero.`,
    };
  }

  return { ok: true, value };
}
