/** Generate `CREATE TABLE` DDL from a {@link Table} definition (the inverse of introspection). */
import { Effect } from "effect";
import { ClickhouseClient } from "./client.ts";
import { renderEngine } from "./engine.ts";
import type { ClickhouseError } from "./errors.ts";
import { quoteIdent } from "./query/expr.ts";
import { type AnyTable, tableMeta } from "./table.ts";

const quoteString = (value: string): string =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export interface CreateTableOptions {
  /** Emit `CREATE TABLE IF NOT EXISTS`. */
  readonly ifNotExists?: boolean;
  /** Override the database the table is created in. */
  readonly database?: string;
}

/** Render the `CREATE TABLE` statement for a table definition. */
export const createTableSql = (table: AnyTable, options: CreateTableOptions = {}): string => {
  const meta = tableMeta(table);
  const database = options.database ?? meta.config.database;
  const qualified = database
    ? `${quoteIdent(database)}.${quoteIdent(meta.name)}`
    : quoteIdent(meta.name);

  const columnLines = meta.columnOrder.map((name) => {
    const def = meta.columnDefs[name];
    const parts: Array<string> = [`  ${quoteIdent(name)} ${def.type.typeName}`];
    if (def.config.default !== undefined) parts.push(`DEFAULT ${def.config.default}`);
    else if (def.config.materialized !== undefined)
      parts.push(`MATERIALIZED ${def.config.materialized}`);
    else if (def.config.alias !== undefined) parts.push(`ALIAS ${def.config.alias}`);
    if (def.config.codec !== undefined) parts.push(`CODEC(${def.config.codec})`);
    if (def.config.ttl !== undefined) parts.push(`TTL ${def.config.ttl}`);
    if (def.config.comment !== undefined) parts.push(`COMMENT ${quoteString(def.config.comment)}`);
    return parts.join(" ");
  });

  const indexLines = (meta.config.indexes ?? []).map((index) => {
    const granularity = index.granularity === undefined ? "" : ` GRANULARITY ${index.granularity}`;
    return `  INDEX ${quoteIdent(index.name)} ${index.expression} TYPE ${index.type}${granularity}`;
  });
  const body = [...columnLines, ...indexLines].join(",\n");

  const header = `CREATE TABLE ${options.ifNotExists ? "IF NOT EXISTS " : ""}${qualified}`;
  const clauses: Array<string> = [`ENGINE = ${renderEngine(meta.config.engine ?? "MergeTree")}`];

  const orderBy = meta.config.orderBy ?? [];
  clauses.push(`ORDER BY ${orderBy.length === 0 ? "tuple()" : `(${orderBy.join(", ")})`}`);
  if (meta.config.partitionBy !== undefined)
    clauses.push(`PARTITION BY ${meta.config.partitionBy}`);
  if (meta.config.primaryKey !== undefined && meta.config.primaryKey.length > 0) {
    clauses.push(`PRIMARY KEY (${meta.config.primaryKey.join(", ")})`);
  }
  if (meta.config.sampleBy !== undefined) clauses.push(`SAMPLE BY ${meta.config.sampleBy}`);
  if (meta.config.ttl !== undefined) clauses.push(`TTL ${meta.config.ttl}`);
  if (meta.config.settings !== undefined) {
    const settings = Object.entries(meta.config.settings)
      .map(([key, value]) => `${key} = ${typeof value === "string" ? quoteString(value) : value}`)
      .join(", ");
    if (settings.length > 0) clauses.push(`SETTINGS ${settings}`);
  }
  if (meta.config.comment !== undefined)
    clauses.push(`COMMENT ${quoteString(meta.config.comment)}`);

  return `${header} (\n${body}\n)\n${clauses.join("\n")}`;
};

/** Execute `CREATE TABLE` for a table definition. Requires a {@link ClickhouseClient}. */
export const createTable = (
  table: AnyTable,
  options: CreateTableOptions = {},
): Effect.Effect<void, ClickhouseError, ClickhouseClient> =>
  Effect.gen(function* () {
    const client = yield* ClickhouseClient;
    yield* client.command({ sql: createTableSql(table, options) });
  });

/** Render a `DROP TABLE` statement. */
export const dropTableSql = (
  table: AnyTable,
  options: { readonly ifExists?: boolean; readonly database?: string } = {},
): string => {
  const meta = tableMeta(table);
  const database = options.database ?? meta.config.database;
  const qualified = database
    ? `${quoteIdent(database)}.${quoteIdent(meta.name)}`
    : quoteIdent(meta.name);
  return `DROP TABLE ${options.ifExists ? "IF EXISTS " : ""}${qualified}`;
};
