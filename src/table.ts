/**
 * The table-definition DSL. `table(name, columns, config)` produces a {@link Table} whose
 * column accessors (`users.id`) are used to build typesafe queries, and from which the row
 * and insert shapes are inferred ({@link InferRow}, {@link InferInsert}).
 */
import { type Engine, engineNeedsFinal, engineVersionColumn } from "./engine.ts";
import type { AnyChType, ChType, EncodedOf, SelectOf } from "./types.ts";

/** Per-column metadata that affects DDL generation and insert shape. */
export interface ColumnConfig {
  /** `DEFAULT <expr>` — makes the column optional on insert. */
  readonly default?: string;
  /** `MATERIALIZED <expr>` — computed server-side, excluded from insert. */
  readonly materialized?: string;
  /** `ALIAS <expr>` — virtual column, excluded from insert. */
  readonly alias?: string;
  /** `CODEC(<codec>)`. */
  readonly codec?: string;
  /** `TTL <expr>`. */
  readonly ttl?: string;
  /** Column comment. */
  readonly comment?: string;
}

/**
 * A {@link ChType} paired with column-level configuration. The config type `C` is preserved as a
 * generic so that {@link InferInsert} can see, at the type level, which columns have a `DEFAULT`
 * (optional) or are `MATERIALIZED` / `ALIAS` (excluded).
 */
export interface ColumnDef<A = unknown, I = unknown, C extends ColumnConfig = ColumnConfig> {
  readonly type: ChType<A, I>;
  readonly config: C;
}

/** A column definition whose generics are irrelevant — used only as a bound. */
// `any` here is a bound; concrete generics are recovered via inference. `ColumnDef` is invariant,
// so a concrete `ColumnDef<Date, number | string>` only assigns to this widened form.
// oxlint-disable-next-line no-explicit-any
export type AnyColumnDef = ColumnDef<any, any, any>;

/** Anything accepted as a column in a table definition. */
export type ColumnInput = AnyChType | AnyColumnDef;

/** Attach column-level config (default / materialized / codec / …) to a {@link ChType}. */
export const col = <A, I, const C extends ColumnConfig = Record<never, never>>(
  type: ChType<A, I>,
  config: C = {} as C,
): ColumnDef<A, I, C> => ({
  type,
  config,
});

// ---------------------------------------------------------------------------
// Column-input type helpers
// ---------------------------------------------------------------------------

type ColType<V extends ColumnInput> =
  V extends ColumnDef<infer A, infer I, ColumnConfig>
    ? ChType<A, I>
    : V extends ChType<infer A, infer I>
      ? ChType<A, I>
      : never;

type ColSelect<V extends ColumnInput> = SelectOf<ColType<V>>;
type ColEncoded<V extends ColumnInput> = EncodedOf<ColType<V>>;

type ColConfigOf<V extends ColumnInput> =
  // `any` in the A/I slots so the match succeeds despite `ChType` invariance; only `C` matters.
  // oxlint-disable-next-line no-explicit-any
  V extends ColumnDef<any, any, infer C> ? C : Record<never, never>;

type IsExcludedFromInsert<V extends ColumnInput> =
  ColConfigOf<V> extends { readonly materialized: string }
    ? true
    : ColConfigOf<V> extends { readonly alias: string }
      ? true
      : false;

type IsOptionalOnInsert<V extends ColumnInput> =
  ColConfigOf<V> extends { readonly default: string } ? true : false;

/** Flatten an intersection into a single object literal for nicer hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------
// Column accessor (used in queries / expressions)
// ---------------------------------------------------------------------------

/** A reference to a table column, usable anywhere an expression is expected. */
export interface Column<A = unknown, I = unknown> {
  readonly _tag: "Column";
  /** Column name. */
  readonly name: string;
  /** Owning table name (for qualified `table`.`column` references). */
  readonly table: string;
  /** The column's ClickHouse type + codec. */
  readonly type: ChType<A, I>;
  /** Column configuration. */
  readonly config: ColumnConfig;
}

// `any` widens the encoded slot so any concrete `Column<A, I>` assigns to this form.
// oxlint-disable-next-line no-explicit-any
export type AnyColumn = Column<any, any>;

type ColumnsOf<Cols extends Record<string, ColumnInput>> = {
  readonly [K in keyof Cols]: Column<ColSelect<Cols[K]>, ColEncoded<Cols[K]>>;
};

// ---------------------------------------------------------------------------
// Table config
// ---------------------------------------------------------------------------

/**
 * A union that keeps editor autocomplete for the `Known` members while still accepting any
 * `string` — ClickHouse engines, key expressions, and index types are open-ended, so we suggest
 * the common forms without rejecting custom ones.
 */
// `(string & {})` is the canonical "literal union with fallback" trick.
// oxlint-disable-next-line no-empty-object-type
export type LiteralUnion<Known extends string> = Known | (string & {});

/** Well-known ClickHouse table engines (autocomplete; any engine string is still accepted). */
export type KnownEngine = LiteralUnion<
  | "MergeTree"
  | "ReplacingMergeTree"
  | "SummingMergeTree"
  | "AggregatingMergeTree"
  | "CollapsingMergeTree"
  | "VersionedCollapsingMergeTree"
  | "GraphiteMergeTree"
  | "ReplicatedMergeTree"
  | "ReplicatedReplacingMergeTree"
  | "ReplicatedSummingMergeTree"
  | "ReplicatedAggregatingMergeTree"
  | "ReplicatedCollapsingMergeTree"
  // ClickHouse Cloud "Shared" engine family:
  | "SharedMergeTree"
  | "SharedReplacingMergeTree"
  | "SharedSummingMergeTree"
  | "SharedAggregatingMergeTree"
  | "SharedCollapsingMergeTree"
  | "SharedVersionedCollapsingMergeTree"
  | "Memory"
  | "TinyLog"
  | "Log"
  | "StripeLog"
  | "Null"
  | "Set"
  | "Join"
  | "Buffer"
  | "Distributed"
  | "Dictionary"
  | "MaterializedView"
  | "View"
>;

/** Well-known data-skipping index types (autocomplete; any TYPE string is still accepted). */
export type SkipIndexType = LiteralUnion<
  | "minmax"
  | "set(0)"
  | "set(100)"
  | "bloom_filter"
  | "bloom_filter(0.01)"
  | "tokenbf_v1(256, 2, 0)"
  | "ngrambf_v1(3, 256, 2, 0)"
>;

/** A data-skipping index (bloom filter, minmax, set, …) on a table. */
export interface TableIndex<Col extends string = string> {
  /** Index name, e.g. `idx_user_id`. */
  readonly name: string;
  /** The indexed column or expression. */
  readonly expression: LiteralUnion<Col>;
  /** `TYPE` clause, e.g. `"bloom_filter(0.01)"`, `"minmax"`, `"tokenbf_v1(256, 2, 0)"`. */
  readonly type: SkipIndexType;
  /** `GRANULARITY` (number of index granules per skip-index granule). */
  readonly granularity?: number;
}

/**
 * Table-level options used for DDL generation. `Col` is the table's column-name union, so
 * `orderBy` / `primaryKey` / index expressions autocomplete real columns (while still allowing
 * arbitrary expressions like `toYYYYMM(created_at)`).
 */
export interface TableConfig<Col extends string = string> {
  /**
   * Table engine. Prefer a builder (`replacingMergeTree("ver")`, `sharedReplacingMergeTree(...)`)
   * so chorm knows the version column and `FINAL` semantics; a raw string also works. Default
   * `MergeTree`.
   */
  readonly engine?: KnownEngine | Engine;
  /** `ORDER BY` columns/expressions. */
  readonly orderBy?: ReadonlyArray<LiteralUnion<Col>>;
  /** `PARTITION BY` expression. */
  readonly partitionBy?: string;
  /** `PRIMARY KEY` columns/expressions (defaults to `orderBy` in ClickHouse). */
  readonly primaryKey?: ReadonlyArray<LiteralUnion<Col>>;
  /** `SAMPLE BY` expression. */
  readonly sampleBy?: string;
  /** Data-skipping indices (bloom filters, minmax, …). */
  readonly indexes?: ReadonlyArray<TableIndex<Col>>;
  /** `TTL` expression. */
  readonly ttl?: string;
  /** Table `SETTINGS` (e.g. `{ index_granularity: 8192 }`). */
  readonly settings?: Readonly<Record<string, string | number>>;
  /** Database the table lives in (used to qualify identifiers). */
  readonly database?: string;
  /** Table comment. */
  readonly comment?: string;
}

const TableMeta = Symbol.for("chorm/TableMeta");

/** Internal table metadata, stored under a symbol key to avoid colliding with column names. */
export interface TableMetaData<Name extends string, Cols extends Record<string, ColumnInput>> {
  readonly name: Name;
  readonly columns: ColumnsOf<Cols>;
  readonly columnDefs: {
    readonly [K in keyof Cols]: ColumnDef<ColSelect<Cols[K]>, ColEncoded<Cols[K]>>;
  };
  readonly config: TableConfig;
  /** Ordered list of column names (insertion order of the definition). */
  readonly columnOrder: ReadonlyArray<string>;
}

/**
 * A table definition. Column accessors are spread as own properties (`users.id`), while the
 * metadata lives under a non-enumerable symbol key.
 */
export type Table<
  Name extends string = string,
  Cols extends Record<string, ColumnInput> = Record<string, ColumnInput>,
> = ColumnsOf<Cols> & {
  readonly [TableMeta]: TableMetaData<Name, Cols>;
};

// Loose alias for contexts that don't care about the exact column set.
// `any` is required here so that a specific `Table<"x", {...}>` is assignable to `AnyTable`.
// oxlint-disable-next-line no-explicit-any
export type AnyTable = Table<string, any>;

const isColumnDef = (value: ColumnInput): value is ColumnDef =>
  typeof value === "object" && value !== null && "type" in value && "config" in value;

const normalize = (value: ColumnInput): ColumnDef =>
  isColumnDef(value) ? value : { type: value as AnyChType, config: {} };

/** Define a ClickHouse table. */
export const table = <const Name extends string, const Cols extends Record<string, ColumnInput>>(
  name: Name,
  columns: Cols,
  config: TableConfig<keyof Cols & string> = {},
): Table<Name, Cols> => {
  const columnOrder = Object.keys(columns);
  const accessors: Record<string, Column> = {};
  const columnDefs: Record<string, ColumnDef> = {};
  for (const key of columnOrder) {
    const def = normalize(columns[key]);
    columnDefs[key] = def;
    accessors[key] = {
      _tag: "Column",
      name: key,
      table: name,
      type: def.type,
      config: def.config,
    };
  }
  const meta: TableMetaData<Name, Cols> = {
    name,
    // The runtime shapes match the precise mapped types; construction is dynamic.
    columns: accessors as TableMetaData<Name, Cols>["columns"],
    columnDefs: columnDefs as TableMetaData<Name, Cols>["columnDefs"],
    config,
    columnOrder,
  };
  return Object.assign(Object.create(null), accessors, { [TableMeta]: meta }) as Table<Name, Cols>;
};

/** Retrieve a table's internal metadata. */
export const tableMeta = <Name extends string, Cols extends Record<string, ColumnInput>>(
  t: Table<Name, Cols>,
): TableMetaData<Name, Cols> => t[TableMeta];

/** The fully-qualified (optionally database-prefixed) identifier name of a table. */
export const tableName = (t: AnyTable): string => t[TableMeta].name;

/** Whether reads from this table need `FINAL` to deduplicate (Replacing/Collapsing/… engines). */
export const tableNeedsFinal = (t: AnyTable): boolean =>
  engineNeedsFinal(t[TableMeta].config.engine);

/** The version/sign column of this table's engine, if any. */
export const tableVersionColumn = (t: AnyTable): string | null =>
  engineVersionColumn(t[TableMeta].config.engine);

// ---------------------------------------------------------------------------
// Row / insert inference
// ---------------------------------------------------------------------------

type ColsParam<T extends AnyTable> = T extends Table<string, infer C> ? C : never;

/** The shape of a row read back from a `SELECT *` on the table. */
export type InferRow<T extends AnyTable> = Simplify<{
  readonly [K in keyof ColsParam<T>]: ColSelect<ColsParam<T>[K]>;
}>;

type RequiredInsertKeys<Cols extends Record<string, ColumnInput>> = {
  [K in keyof Cols]: IsExcludedFromInsert<Cols[K]> extends true
    ? never
    : IsOptionalOnInsert<Cols[K]> extends true
      ? never
      : K;
}[keyof Cols];

type OptionalInsertKeys<Cols extends Record<string, ColumnInput>> = {
  [K in keyof Cols]: IsExcludedFromInsert<Cols[K]> extends true
    ? never
    : IsOptionalOnInsert<Cols[K]> extends true
      ? K
      : never;
}[keyof Cols];

/**
 * The shape accepted by `insert`. Columns with a `DEFAULT` are optional; `MATERIALIZED` and
 * `ALIAS` columns are excluded. Values are the decoded TS types — they are encoded to the wire
 * format internally.
 */
export type InferInsert<T extends AnyTable> = Simplify<
  { readonly [K in RequiredInsertKeys<ColsParam<T>>]: ColSelect<ColsParam<T>[K]> } & {
    readonly [K in OptionalInsertKeys<ColsParam<T>>]?: ColSelect<ColsParam<T>[K]>;
  }
>;
