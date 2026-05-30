/**
 * Live-database introspection: read `system.tables` and `system.columns` and turn them into a
 * structured {@link IntrospectedTable} model (with each column's type string already parsed).
 */
import { Effect, Schema } from "effect";
import { ClickhouseClient } from "../client.ts";
import type { ClickhouseError, RowDecodeError } from "../errors.ts";
import { type ParsedType, parseType, splitTopLevel } from "./parser.ts";

const ColumnRow = Schema.Struct({
  table: Schema.String,
  name: Schema.String,
  type: Schema.String,
  default_kind: Schema.String,
  default_expression: Schema.String,
  compression_codec: Schema.String,
  comment: Schema.String,
});

const TableRow = Schema.Struct({
  name: Schema.String,
  engine: Schema.String,
  engine_full: Schema.String,
  sorting_key: Schema.String,
  partition_key: Schema.String,
  primary_key: Schema.String,
  sampling_key: Schema.String,
  comment: Schema.String,
});

const IndexRow = Schema.Struct({
  table: Schema.String,
  name: Schema.String,
  type_full: Schema.String,
  expr: Schema.String,
  granularity: Schema.Number,
});

const TABLES_SQL = `SELECT name, engine, engine_full, sorting_key, partition_key, primary_key, sampling_key, comment
FROM system.tables
WHERE database = {database:String}
ORDER BY name`;

const COLUMNS_SQL = `SELECT table, name, type, default_kind, default_expression, compression_codec, comment
FROM system.columns
WHERE database = {database:String}
ORDER BY table, position`;

const INDEXES_SQL = `SELECT table, name, type_full, expr, toUInt32(granularity) AS granularity
FROM system.data_skipping_indices
WHERE database = {database:String}
ORDER BY table, name`;

/** `DEFAULT` / `MATERIALIZED` / `ALIAS` / `` (ordinary). */
export type DefaultKind = "" | "DEFAULT" | "MATERIALIZED" | "ALIAS";

export interface IntrospectedColumn {
  readonly name: string;
  /** The raw ClickHouse type string from `system.columns.type`. */
  readonly rawType: string;
  /** The parsed type AST. */
  readonly parsedType: ParsedType;
  readonly defaultKind: DefaultKind;
  readonly defaultExpression: string;
  /** `CODEC(...)` contents, e.g. `"ZSTD(3)"`, or empty when none. */
  readonly codec: string;
  readonly comment: string;
}

/** A data-skipping index (bloom filter, minmax, …) read from `system.data_skipping_indices`. */
export interface IntrospectedIndex {
  readonly name: string;
  readonly expression: string;
  /** Full `TYPE` clause, e.g. `"bloom_filter(0.01)"`. */
  readonly type: string;
  readonly granularity: number;
}

export interface IntrospectedTable {
  readonly name: string;
  /** Engine clause including parameters, e.g. `ReplacingMergeTree(version)`. */
  readonly engine: string;
  readonly orderBy: ReadonlyArray<string>;
  readonly partitionBy: string | null;
  readonly primaryKey: ReadonlyArray<string> | null;
  readonly sampleBy: string | null;
  /** Table-level `TTL` expression (only populated by DDL-based introspection). */
  readonly ttl: string | null;
  /** Table `SETTINGS` (only populated by DDL-based introspection). */
  readonly settings: Readonly<Record<string, string | number>>;
  readonly comment: string;
  readonly columns: ReadonlyArray<IntrospectedColumn>;
  readonly indexes: ReadonlyArray<IntrospectedIndex>;
}

export interface IntrospectOptions {
  /** Restrict introspection to these table names. */
  readonly tables?: ReadonlyArray<string>;
}

const ENGINE_CLAUSE_KEYWORDS = [
  " ORDER BY ",
  " PARTITION BY ",
  " PRIMARY KEY ",
  " SAMPLE BY ",
  " TTL ",
  " SETTINGS ",
  " AS ",
];

/** Extract the engine + its parameters from `engine_full`, dropping trailing table clauses. */
const extractEngine = (engineFull: string, engineName: string): string => {
  const trimmed = engineFull.trim();
  if (trimmed.length === 0) return engineName;
  let cut = trimmed.length;
  for (const keyword of ENGINE_CLAUSE_KEYWORDS) {
    const index = trimmed.indexOf(keyword);
    if (index !== -1 && index < cut) cut = index;
  }
  const engine = trimmed.slice(0, cut).trim();
  return engine.length === 0 ? engineName : engine;
};

const splitKey = (key: string): ReadonlyArray<string> => {
  const trimmed = key.trim();
  return trimmed.length === 0 ? [] : splitTopLevel(trimmed).map((s) => s.trim());
};

const asDefaultKind = (value: string): DefaultKind =>
  value === "DEFAULT" || value === "MATERIALIZED" || value === "ALIAS" ? value : "";

/** Introspect every table (optionally filtered) in a database. Requires a {@link ClickhouseClient}. */
export const introspectDatabase = (
  database: string,
  options: IntrospectOptions = {},
): Effect.Effect<
  ReadonlyArray<IntrospectedTable>,
  ClickhouseError | RowDecodeError,
  ClickhouseClient
> =>
  Effect.gen(function* () {
    const client = yield* ClickhouseClient;
    const tableRows = yield* client.query({
      sql: TABLES_SQL,
      params: { database },
      rowSchema: TableRow,
    });
    const columnRows = yield* client.query({
      sql: COLUMNS_SQL,
      params: { database },
      rowSchema: ColumnRow,
    });
    const indexRows = yield* client.query({
      sql: INDEXES_SQL,
      params: { database },
      rowSchema: IndexRow,
    });

    const columnsByTable = new Map<string, Array<IntrospectedColumn>>();
    for (const row of columnRows) {
      const list = columnsByTable.get(row.table) ?? [];
      list.push({
        name: row.name,
        rawType: row.type,
        parsedType: parseType(row.type),
        defaultKind: asDefaultKind(row.default_kind),
        defaultExpression: row.default_expression,
        codec: row.compression_codec,
        comment: row.comment,
      });
      columnsByTable.set(row.table, list);
    }

    const indexesByTable = new Map<string, Array<IntrospectedIndex>>();
    for (const row of indexRows) {
      const list = indexesByTable.get(row.table) ?? [];
      list.push({
        name: row.name,
        expression: row.expr,
        type: row.type_full,
        granularity: row.granularity,
      });
      indexesByTable.set(row.table, list);
    }

    const wanted = options.tables ? new Set(options.tables) : null;
    return tableRows
      .filter((t) => (wanted ? wanted.has(t.name) : true))
      .map((t): IntrospectedTable => {
        const orderBy = splitKey(t.sorting_key);
        const primaryKey = splitKey(t.primary_key);
        const samePrimary =
          primaryKey.length === orderBy.length && primaryKey.every((k, i) => k === orderBy[i]);
        return {
          name: t.name,
          engine: extractEngine(t.engine_full, t.engine),
          orderBy,
          partitionBy: t.partition_key.trim() === "" ? null : t.partition_key,
          primaryKey: primaryKey.length === 0 || samePrimary ? null : primaryKey,
          sampleBy: t.sampling_key.trim() === "" ? null : t.sampling_key,
          // TTL / SETTINGS have no clean `system.tables` columns — use DDL-based introspection
          // (`parseCreateTables`) to capture them.
          ttl: null,
          settings: {},
          comment: t.comment,
          columns: columnsByTable.get(t.name) ?? [],
          indexes: indexesByTable.get(t.name) ?? [],
        };
      });
  });
