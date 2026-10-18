/** Bounded expression compiler. Every min/max is an equality, never a relaxed
 * inequality: negative tariffs must not buy fictitious charging or grid flows. */
export type Expr = {
  terms: Map<string, number>;
  constant: number;
  lo: number;
  hi: number;
};
export interface Algebra<T> {
  constant(n: number): T;
  add(...xs: T[]): T;
  scale(x: T, n: number): T;
  min(a: T, b: T): T;
  max(a: T, b: T): T;
  select(flag: T, yes: T, no: T): T;
  threshold(x: T, threshold: number): T;
}
export const numeric: Algebra<number> = {
  constant: (n) => n,
  add: (...xs) => xs.reduce((a, b) => a + b, 0),
  scale: (x, n) => x * n,
  min: Math.min,
  max: Math.max,
  select: (flag, yes, no) => (flag > 0.5 ? yes : no),
  threshold: (x, threshold) => Number(x >= threshold),
};
export class Milp implements Algebra<Expr> {
  variables: { name: string; lo: number; hi: number; integer: boolean }[] = [];
  rows: { x: Expr; sense: "<=" | ">=" | "="; rhs: number }[] = [];
  constant(n: number): Expr {
    return { terms: new Map(), constant: n, lo: n, hi: n };
  }
  variable(lo: number, hi: number, integer = false): Expr {
    if (lo === hi) return this.constant(lo);
    const name = `x${this.variables.length}`;
    this.variables.push({ name, lo, hi, integer });
    return { terms: new Map([[name, 1]]), constant: 0, lo, hi };
  }
  add(...xs: Expr[]): Expr {
    const terms = new Map<string, number>();
    for (const x of xs)
      for (const [key, v] of x.terms) terms.set(key, (terms.get(key) ?? 0) + v);
    return {
      terms,
      constant: xs.reduce((s, x) => s + x.constant, 0),
      lo: xs.reduce((s, x) => s + x.lo, 0),
      hi: xs.reduce((s, x) => s + x.hi, 0),
    };
  }
  scale(x: Expr, n: number): Expr {
    return {
      terms: new Map([...x.terms].map(([k, v]) => [k, v * n])),
      constant: x.constant * n,
      lo: Math.min(x.lo * n, x.hi * n),
      hi: Math.max(x.lo * n, x.hi * n),
    };
  }
  constrain(x: Expr, sense: "<=" | ">=" | "=", rhs: number) {
    this.rows.push({ x, sense, rhs });
  }
  select(flag: Expr, yes: Expr, no: Expr): Expr {
    if (flag.lo === flag.hi) return flag.lo ? yes : no;
    const y = this.variable(Math.min(yes.lo, no.lo), Math.max(yes.hi, no.hi));
    for (const [x, active] of [
      [yes, flag],
      [no, this.add(this.constant(1), this.scale(flag, -1))],
    ] as const) {
      const diff = this.add(y, this.scale(x, -1));
      const off = this.add(this.constant(1), this.scale(active, -1));
      this.constrain(this.add(diff, this.scale(off, -(y.hi - x.lo))), "<=", 0);
      this.constrain(this.add(diff, this.scale(off, -(y.lo - x.hi))), ">=", 0);
    }
    return y;
  }
  min(a: Expr, b: Expr): Expr {
    if (a.hi <= b.lo) return a;
    if (b.hi <= a.lo) return b;
    const flag = this.variable(0, 1, true);
    const y = this.select(flag, a, b);
    this.constrain(this.add(y, this.scale(a, -1)), "<=", 0);
    this.constrain(this.add(y, this.scale(b, -1)), "<=", 0);
    y.lo = Math.min(a.lo, b.lo);
    y.hi = Math.min(a.hi, b.hi);
    return y;
  }
  max(a: Expr, b: Expr): Expr {
    return this.scale(this.min(this.scale(a, -1), this.scale(b, -1)), -1);
  }
  threshold(x: Expr, threshold: number): Expr {
    if (x.lo >= threshold) return this.constant(1);
    if (x.hi < threshold) return this.constant(0);
    const y = this.variable(0, 1, true);
    this.constrain(this.add(x, this.scale(y, -(threshold - x.lo))), ">=", x.lo);
    this.constrain(
      this.add(x, this.scale(y, -(x.hi - threshold))),
      "<=",
      threshold,
    );
    return y; // Equality is numerically ambiguous; independent replay must agree.
  }
  text(x: Expr) {
    return (
      [...x.terms]
        .filter(([, v]) => Math.abs(v) > 1e-14)
        .map(([k, v]) => `${v < 0 ? "-" : "+"} ${Math.abs(v)} ${k}`)
        .join(" ") || "0 x0"
    );
  }
  lp(objective: Expr) {
    return [
      "Minimize",
      `obj: ${this.text(objective)}`,
      "Subject To",
      ...this.rows.map(
        ({ x, sense, rhs }, i) =>
          `r${i}: ${this.text(x)} ${sense} ${rhs - x.constant}`,
      ),
      "Bounds",
      ...this.variables.map((v) => `${v.lo} <= ${v.name} <= ${v.hi}`),
      "Generals",
      this.variables
        .filter((v) => v.integer)
        .map((v) => v.name)
        .join(" "),
      "End",
    ].join("\n");
  }
  value(x: Expr, values: Record<string, number>) {
    return (
      x.constant + [...x.terms].reduce((s, [k, v]) => s + v * values[k], 0)
    );
  }
  feasible(values: Record<string, number>) {
    return (
      this.variables.every(
        (v) =>
          Number.isFinite(values[v.name]) &&
          values[v.name] >= v.lo - 1e-6 &&
          values[v.name] <= v.hi + 1e-6 &&
          (!v.integer ||
            Math.abs(values[v.name] - Math.round(values[v.name])) < 1e-6),
      ) &&
      this.rows.every((r) => {
        const d = this.value(r.x, values) - r.rhs;
        return r.sense === "="
          ? Math.abs(d) < 1e-5
          : r.sense === "<="
            ? d < 1e-5
            : d > -1e-5;
      })
    );
  }
}
