/**
 * Demonstrates the codegen pipeline without a live database: build an introspection model by
 * hand, render it to a TypeScript module, and write it to `./generated.ts`. Running
 * `vp check` afterwards proves the generated code compiles against the real API.
 *
 *   vp node examples/generate.ts && vp check
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateModule,
  type IntrospectedColumn,
  type IntrospectedTable,
  parseType,
} from "../src/index.ts";

const column = (
  name: string,
  rawType: string,
  extra: Partial<IntrospectedColumn> = {},
): IntrospectedColumn => ({
  name,
  rawType,
  parsedType: parseType(rawType),
  defaultKind: "",
  defaultExpression: "",
  codec: "",
  comment: "",
  ...extra,
});

const tables: ReadonlyArray<IntrospectedTable> = [
  {
    name: "events",
    engine: "MergeTree",
    orderBy: ["created_at", "id"],
    partitionBy: "toYYYYMM(created_at)",
    primaryKey: null,
    sampleBy: null,
    comment: "",
    columns: [
      column("id", "UUID"),
      column("user_id", "UInt64"),
      column("name", "LowCardinality(String)"),
      column("status", "Enum8('active' = 1, 'inactive' = 2)"),
      column("amount", "Nullable(Decimal(18, 4))"),
      column("tags", "Array(String)"),
      column("properties", "Map(String, String)"),
      column("location", "Tuple(lat Float64, lon Float64)"),
      column("created_at", "DateTime('UTC')", {
        defaultKind: "DEFAULT",
        defaultExpression: "now()",
      }),
      column("day", "Date", {
        defaultKind: "MATERIALIZED",
        defaultExpression: "toDate(created_at)",
      }),
      column("state", "AggregateFunction(uniq, UInt64)"),
    ],
    indexes: [
      { name: "idx_user_id", expression: "user_id", type: "bloom_filter(0.01)", granularity: 4 },
      { name: "idx_name", expression: "name", type: "tokenbf_v1(256, 2, 0)", granularity: 1 },
    ],
    ttl: "toDateTime(created_at) + toIntervalYear(1)",
    settings: { index_granularity: 8192 },
  },
];

const source = generateModule(tables, { database: "demo", importFrom: "../src/index.ts" });
const out = join(dirname(fileURLToPath(import.meta.url)), "generated.ts");
writeFileSync(out, source);
process.stdout.write(`Wrote ${out}\n\n${source}`);
