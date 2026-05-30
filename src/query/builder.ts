/**
 * The immutable `SELECT` builder and the `insert` helper.
 *
 * `from(table)` starts a query that decodes into {@link InferRow}; `.select(projection)` narrows
 * the result to the projected shape. Every builder method returns a new instance. `.execute()`
 * yields an `Effect` requiring the {@link ClickhouseClient} service; `.toSql()` exposes the
 * compiled SQL + bound params for inspection or use with a raw client.
 */
import { Effect, Schema } from "effect";
import { ClickhouseClient } from "../client.ts";
import type { ClickhouseError, RowDecodeError, RowEncodeError } from "../errors.ts";
import type { InsertResult } from "../client.ts";
import {
  type AnyColumn,
  type AnyTable,
  type Column,
  type InferInsert,
  type InferRow,
  tableMeta,
} from "../table.ts";
import {
  and,
  type Compiler,
  Compiler as CompilerClass,
  type Expr,
  type OrderTerm,
  type Projectable,
  quoteIdent,
  toProjectableExpr,
} from "./expr.ts";

type Simplify<T> = { [K in keyof T]: T[K] } & {};

// A projectable of any element type — the constraint for projection values.
// oxlint-disable-next-line no-explicit-any
type AnyProjectable = Projectable<any>;

/** A projection: a map of output aliases to columns or expressions. */
export type Projection = Record<string, AnyProjectable>;

/** The row type produced by a projection. */
export type ProjectionRow<P extends Projection> = Simplify<{
  readonly [K in keyof P]: P[K] extends Expr<infer A>
    ? A
    : P[K] extends Column<infer A, infer _I>
      ? A
      : never;
}>;

/** A compiled query: SQL text plus the values to bind via `query_params`. */
export interface CompiledQuery {
  readonly sql: string;
  readonly params: Record<string, unknown>;
}

interface SelectState {
  readonly table: AnyTable;
  readonly projection: Projection;
  readonly wheres: ReadonlyArray<Expr<boolean>>;
  readonly groupBys: ReadonlyArray<Projectable>;
  readonly havings: ReadonlyArray<Expr<boolean>>;
  readonly orderBys: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
  readonly offset?: number;
  readonly final: boolean;
  readonly distinct: boolean;
}

const qualifiedTableName = (table: AnyTable): string => {
  const meta = tableMeta(table);
  const name = quoteIdent(meta.name);
  return meta.config.database ? `${quoteIdent(meta.config.database)}.${name}` : name;
};

const assertInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got: ${value}`);
  }
  return value;
};

const structSchema = (fields: Record<string, Schema.Struct.Field>): Schema.Schema.Any =>
  Schema.Struct(fields);

/** An immutable `SELECT` query builder. */
export class SelectBuilder<Row> {
  private readonly state: SelectState;

  constructor(state: SelectState) {
    this.state = state;
  }

  private with(patch: Partial<SelectState>): SelectBuilder<Row> {
    return new SelectBuilder<Row>({ ...this.state, ...patch });
  }

  /** Narrow the result to a projection of columns / expressions. */
  select<P extends Projection>(projection: P): SelectBuilder<ProjectionRow<P>> {
    return new SelectBuilder<ProjectionRow<P>>({ ...this.state, projection });
  }

  /** Add `WHERE` conditions (combined with `AND`). */
  where(...conditions: ReadonlyArray<Expr<boolean>>): SelectBuilder<Row> {
    return this.with({ wheres: [...this.state.wheres, ...conditions] });
  }

  /** Add `GROUP BY` terms. */
  groupBy(...terms: ReadonlyArray<AnyProjectable>): SelectBuilder<Row> {
    return this.with({ groupBys: [...this.state.groupBys, ...terms] });
  }

  /** Add `HAVING` conditions (combined with `AND`). */
  having(...conditions: ReadonlyArray<Expr<boolean>>): SelectBuilder<Row> {
    return this.with({ havings: [...this.state.havings, ...conditions] });
  }

  /** Add `ORDER BY` terms. Bare columns/expressions default to `ASC`. */
  orderBy(...terms: ReadonlyArray<OrderTerm | AnyProjectable>): SelectBuilder<Row> {
    const normalized = terms.map(
      (t): OrderTerm =>
        "direction" in (t as OrderTerm)
          ? (t as OrderTerm)
          : { expr: toProjectableExpr(t as AnyProjectable), direction: "ASC" },
    );
    return this.with({ orderBys: [...this.state.orderBys, ...normalized] });
  }

  /** `LIMIT n`. */
  limit(n: number): SelectBuilder<Row> {
    return this.with({ limit: assertInteger(n, "limit") });
  }

  /** `OFFSET n`. */
  offset(n: number): SelectBuilder<Row> {
    return this.with({ offset: assertInteger(n, "offset") });
  }

  /** Append the `FINAL` modifier (collapses merges for ReplacingMergeTree, etc.). */
  final(): SelectBuilder<Row> {
    return this.with({ final: true });
  }

  /** `SELECT DISTINCT`. */
  distinct(): SelectBuilder<Row> {
    return this.with({ distinct: true });
  }

  /** Build the Effect Schema used to decode each returned row. */
  rowSchema(): Schema.Schema<Row> {
    const fields: Record<string, Schema.Struct.Field> = {};
    for (const [alias, projectable] of Object.entries(this.state.projection)) {
      fields[alias] = toProjectableExpr(projectable).type.schema;
    }
    // Constructed dynamically; the field schemas match `Row` by construction.
    return structSchema(fields) as unknown as Schema.Schema<Row>;
  }

  /** Compile to SQL text and bound parameters. */
  toSql(): CompiledQuery {
    const compiler: Compiler = new CompilerClass();
    const { state } = this;
    const projectionSql = Object.entries(state.projection)
      .map(([alias, projectable]) => {
        const sql = toProjectableExpr(projectable).compile(compiler);
        return `${sql} AS ${quoteIdent(alias)}`;
      })
      .join(", ");

    let sql = `SELECT ${state.distinct ? "DISTINCT " : ""}${projectionSql}`;
    sql += ` FROM ${qualifiedTableName(state.table)}`;
    if (state.final) sql += " FINAL";
    if (state.wheres.length > 0) sql += ` WHERE ${and(...state.wheres).compile(compiler)}`;
    if (state.groupBys.length > 0) {
      sql += ` GROUP BY ${state.groupBys.map((g) => toProjectableExpr(g).compile(compiler)).join(", ")}`;
    }
    if (state.havings.length > 0) sql += ` HAVING ${and(...state.havings).compile(compiler)}`;
    if (state.orderBys.length > 0) {
      sql += ` ORDER BY ${state.orderBys
        .map((o) => `${o.expr.compile(compiler)} ${o.direction}`)
        .join(", ")}`;
    }
    if (state.limit !== undefined) sql += ` LIMIT ${state.limit}`;
    if (state.offset !== undefined) sql += ` OFFSET ${state.offset}`;
    return { sql, params: compiler.params };
  }

  /** Run the query, decoding each row. Requires a {@link ClickhouseClient}. */
  execute(): Effect.Effect<ReadonlyArray<Row>, ClickhouseError | RowDecodeError, ClickhouseClient> {
    const { sql, params } = this.toSql();
    const schema = this.rowSchema();
    return Effect.gen(function* () {
      const client = yield* ClickhouseClient;
      return yield* client.query({ sql, params, rowSchema: schema });
    });
  }
}

/** Start a `SELECT` query from a table. Decodes into {@link InferRow} unless projected. */
export const from = <T extends AnyTable>(table: T): SelectBuilder<InferRow<T>> => {
  const meta = tableMeta(table);
  const projection: Projection = {};
  for (const name of meta.columnOrder) {
    projection[name] = meta.columns[name] as AnyColumn;
  }
  return new SelectBuilder<InferRow<T>>({
    table,
    projection,
    wheres: [],
    groupBys: [],
    havings: [],
    orderBys: [],
    final: false,
    distinct: false,
  });
};

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

const insertRowSchema = (table: AnyTable): Schema.Schema.Any => {
  const meta = tableMeta(table);
  const fields: Record<string, Schema.Struct.Field> = {};
  for (const name of meta.columnOrder) {
    const def = meta.columnDefs[name];
    if (def.config.materialized !== undefined || def.config.alias !== undefined) continue;
    fields[name] =
      def.config.default !== undefined ? Schema.optional(def.type.schema) : def.type.schema;
  }
  return Schema.Struct(fields);
};

/** Insert rows into a table. Values are encoded to the wire format via each column's schema. */
export const insert = <T extends AnyTable>(
  table: T,
  rows: ReadonlyArray<InferInsert<T>>,
): Effect.Effect<InsertResult, ClickhouseError | RowEncodeError, ClickhouseClient> => {
  const schema = insertRowSchema(table) as unknown as Schema.Schema<InferInsert<T>>;
  const target = qualifiedTableName(table);
  return Effect.gen(function* () {
    const client = yield* ClickhouseClient;
    return yield* client.insert({ table: target, rows, rowSchema: schema });
  });
};
