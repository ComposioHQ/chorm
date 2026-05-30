/**
 * Expressions and the SQL compiler.
 *
 * An {@link Expr} is a small, composable node that knows (a) its ClickHouse result type — so
 * projections can be decoded — and (b) how to compile itself to SQL, registering any literal
 * values as bound parameters on the {@link Compiler}. Values are bound as `{pN:Type}` and passed
 * through `query_params`; the client formats raw JS values (bigint → string, Date → unix
 * timestamp, arrays → `[…]`) automatically, so no manual escaping is needed.
 */
import type { Column } from "../table.ts";
import { parseType, renderType, unwrapType } from "../introspect/parser.ts";
import type { DecodeChType } from "../types.ts";
import * as ch from "../types.ts";

/** Accumulates bound parameters while compiling a query. */
export class Compiler {
  private counter = 0;
  readonly params: Record<string, unknown> = {};

  /** Register a value as a bound parameter and return its `{pN:Type}` placeholder. */
  bind(value: unknown, chType: string): string {
    const key = `p${this.counter}`;
    this.counter += 1;
    this.params[key] = value;
    return `{${key}:${chType}}`;
  }
}

/** Quote an identifier with backticks, escaping embedded backticks. */
export const quoteIdent = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** A bindable parameter type — `LowCardinality`/`Nullable` wrappers stripped. */
export const paramTypeOf = (typeName: string): string =>
  renderType(unwrapType(parseType(typeName)).base);

/** A typed SQL expression. */
export interface Expr<A = unknown> {
  readonly _tag: "Expr";
  /** The ClickHouse result type, used to decode this expression when selected. */
  readonly type: DecodeChType<A>;
  /** Compile to a SQL fragment, registering bound params on the compiler. */
  readonly compile: (compiler: Compiler) => string;
}

/** Either a column reference or an expression. */
// `any` widens the column's encoded slot so any concrete `Column<A, I>` is accepted.
// oxlint-disable-next-line no-explicit-any
export type Projectable<A = unknown> = Column<A, any> | Expr<A>;
/** An operand: a column, an expression, or a literal value. */
export type Operand<A> = Projectable<A> | A;

/** A projectable of any element type — for positions that don't constrain the type. */
// oxlint-disable-next-line no-explicit-any
export type AnyProjectable = Projectable<any>;

const isColumn = (value: unknown): value is Column =>
  typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "Column";

const isExpr = (value: unknown): value is Expr =>
  typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "Expr";

const make = <A>(type: DecodeChType<A>, compile: (compiler: Compiler) => string): Expr<A> => ({
  _tag: "Expr",
  type,
  compile,
});

/** Lift a {@link Column} into an {@link Expr}. */
export const columnExpr = <A, I>(column: Column<A, I>): Expr<A> =>
  make(column.type, () => `${quoteIdent(column.table)}.${quoteIdent(column.name)}`);

/** Normalize any projectable into an {@link Expr}. */
export const toProjectableExpr = <A>(value: Projectable<A>): Expr<A> =>
  isExpr(value) ? (value as Expr<A>) : columnExpr(value as Column<A>);

/** Normalize an operand (column / expression / literal) into an {@link Expr}, typed via `refType`. */
const toExpr = <A>(operand: Operand<A>, refType: DecodeChType<A>): Expr<A> => {
  if (isColumn(operand)) return columnExpr(operand as Column<A>);
  if (isExpr(operand)) return operand as Expr<A>;
  return make(refType, (compiler) => compiler.bind(operand, paramTypeOf(refType.typeName)));
};

const leftToExpr = <A>(left: Projectable<A>): Expr<A> =>
  isColumn(left) ? columnExpr(left as Column<A>) : (left as Expr<A>);

// ---------------------------------------------------------------------------
// Comparison & logical operators
// ---------------------------------------------------------------------------

const comparison =
  (op: string) =>
  <A>(left: Projectable<A>, right: Operand<A>): Expr<boolean> => {
    const leftExpr = leftToExpr(left);
    const rightExpr = toExpr(right, leftExpr.type);
    return make(
      ch.bool(),
      (compiler) => `(${leftExpr.compile(compiler)} ${op} ${rightExpr.compile(compiler)})`,
    );
  };

export const eq = comparison("=");
export const ne = comparison("!=");
export const gt = comparison(">");
export const gte = comparison(">=");
export const lt = comparison("<");
export const lte = comparison("<=");

export const and = (...exprs: ReadonlyArray<Expr<boolean>>): Expr<boolean> =>
  make(ch.bool(), (compiler) =>
    exprs.length === 0 ? "1" : `(${exprs.map((e) => e.compile(compiler)).join(" AND ")})`,
  );

export const or = (...exprs: ReadonlyArray<Expr<boolean>>): Expr<boolean> =>
  make(ch.bool(), (compiler) =>
    exprs.length === 0 ? "0" : `(${exprs.map((e) => e.compile(compiler)).join(" OR ")})`,
  );

export const not = (expr: Expr<boolean>): Expr<boolean> =>
  make(ch.bool(), (compiler) => `(NOT ${expr.compile(compiler)})`);

export const isNull = <A>(left: Projectable<A>): Expr<boolean> =>
  make(ch.bool(), (compiler) => `(${leftToExpr(left).compile(compiler)} IS NULL)`);

export const isNotNull = <A>(left: Projectable<A>): Expr<boolean> =>
  make(ch.bool(), (compiler) => `(${leftToExpr(left).compile(compiler)} IS NOT NULL)`);

export const inArray = <A>(left: Projectable<A>, values: ReadonlyArray<A>): Expr<boolean> => {
  const leftExpr = leftToExpr(left);
  const arrType = `Array(${paramTypeOf(leftExpr.type.typeName)})`;
  return make(
    ch.bool(),
    (compiler) => `(${leftExpr.compile(compiler)} IN ${compiler.bind(values, arrType)})`,
  );
};

export const notInArray = <A>(left: Projectable<A>, values: ReadonlyArray<A>): Expr<boolean> => {
  const leftExpr = leftToExpr(left);
  const arrType = `Array(${paramTypeOf(leftExpr.type.typeName)})`;
  return make(
    ch.bool(),
    (compiler) => `(${leftExpr.compile(compiler)} NOT IN ${compiler.bind(values, arrType)})`,
  );
};

export const like = <A>(left: Projectable<A>, pattern: string): Expr<boolean> =>
  make(
    ch.bool(),
    (compiler) =>
      `(${leftToExpr(left).compile(compiler)} LIKE ${compiler.bind(pattern, "String")})`,
  );

export const ilike = <A>(left: Projectable<A>, pattern: string): Expr<boolean> =>
  make(
    ch.bool(),
    (compiler) =>
      `(${leftToExpr(left).compile(compiler)} ILIKE ${compiler.bind(pattern, "String")})`,
  );

export const between = <A>(left: Projectable<A>, low: A, high: A): Expr<boolean> => {
  const leftExpr = leftToExpr(left);
  const type = paramTypeOf(leftExpr.type.typeName);
  return make(
    ch.bool(),
    (compiler) =>
      `(${leftExpr.compile(compiler)} BETWEEN ${compiler.bind(low, type)} AND ${compiler.bind(
        high,
        type,
      )})`,
  );
};

// ---------------------------------------------------------------------------
// Functions & aggregates
// ---------------------------------------------------------------------------

/** An arbitrary function call with an explicit result type. */
export const fn = <A>(
  name: string,
  resultType: DecodeChType<A>,
  ...args: ReadonlyArray<AnyProjectable>
): Expr<A> =>
  make(
    resultType,
    (compiler) => `${name}(${args.map((a) => toProjectableExpr(a).compile(compiler)).join(", ")})`,
  );

/** A raw SQL fragment with an explicit result type. No parameters are bound. */
export const raw = <A>(resultType: DecodeChType<A>, sql: string): Expr<A> =>
  make(resultType, () => sql);

export const count = (): Expr<bigint> => make(ch.uint64(), () => "count()");

export const countDistinct = <A>(column: Projectable<A>): Expr<bigint> =>
  make(ch.uint64(), (compiler) => `count(DISTINCT ${leftToExpr(column).compile(compiler)})`);

const aggregate =
  (name: string) =>
  <A>(column: Projectable<A>): Expr<A> => {
    const expr = leftToExpr(column);
    return make(expr.type, (compiler) => `${name}(${expr.compile(compiler)})`);
  };

/** `sum(x)` — keeps the column's numeric type. */
export const sum = aggregate("sum");
/** `min(x)` — keeps the column's type. */
export const min = aggregate("min");
/** `max(x)` — keeps the column's type. */
export const max = aggregate("max");
/** `any(x)` — keeps the column's type. */
export const any = aggregate("any");

/** `avg(x)` → `Float64`. */
export const avg = <A>(column: Projectable<A>): Expr<number> =>
  make(ch.float64(), (compiler) => `avg(${leftToExpr(column).compile(compiler)})`);

/** `uniq(x)` → approximate distinct count. */
export const uniq = <A>(column: Projectable<A>): Expr<bigint> =>
  make(ch.uint64(), (compiler) => `uniq(${leftToExpr(column).compile(compiler)})`);

/** `uniqExact(x)` → exact distinct count. */
export const uniqExact = <A>(column: Projectable<A>): Expr<bigint> =>
  make(ch.uint64(), (compiler) => `uniqExact(${leftToExpr(column).compile(compiler)})`);

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** A single `ORDER BY` term. */
export interface OrderTerm {
  readonly expr: Expr;
  readonly direction: "ASC" | "DESC";
}

export const asc = (value: AnyProjectable): OrderTerm => ({
  expr: toProjectableExpr(value),
  direction: "ASC",
});

export const desc = (value: AnyProjectable): OrderTerm => ({
  expr: toProjectableExpr(value),
  direction: "DESC",
});
