/**
 * chorm — a typesafe, Effect-native ClickHouse ORM.
 *
 * - `ch.*` — column type builders (`ch.uint64()`, `ch.array(ch.string())`, …)
 * - `table` / `col` — define tables; `InferRow` / `InferInsert` — infer row shapes
 * - `ClickhouseClient` / `layer` — the Effect client service and its scoped layer
 * - `from` / `insert` + expression helpers (`eq`, `and`, `count`, …) — build typesafe queries
 * - `createTableSql` / `createTable` — DDL generation
 * - `introspectDatabase` / `generateModule` — generate a schema module from a live database
 */

/** Column type builders, used to define table columns. */
export * as ch from "./types.ts";
export type { AnyChType, ChType, DecodeChType, EncodedOf, SelectOf } from "./types.ts";

export * from "./engine.ts";
export * from "./table.ts";
export * from "./errors.ts";
export * from "./client.ts";
export * from "./ddl.ts";
export * from "./query/expr.ts";
export * from "./query/builder.ts";
export {
  type ParsedType,
  type SimpleTypeName,
  parseType,
  renderType,
  splitTopLevel,
  unwrapType,
} from "./introspect/parser.ts";
export * from "./introspect/columns.ts";
export * from "./introspect/codegen.ts";
export * from "./introspect/ddl.ts";
