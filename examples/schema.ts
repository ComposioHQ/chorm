/**
 * An example schema, written with the chorm DSL. This is the same shape the CLI generates with
 * `chorm generate`. (Examples import from the local source; generated code imports from `"chorm"`.)
 */
import { ch, col, table } from "../src/index.ts";

export const users = table(
  "users",
  {
    id: ch.uint64(),
    email: ch.string(),
    status: ch.enum8({ active: 1, suspended: 2, deleted: 3 }),
    created_at: col(ch.dateTime(), { default: "now()" }),
  },
  { engine: "ReplacingMergeTree(created_at)", orderBy: ["id"] },
);

export const events = table(
  "events",
  {
    id: ch.uuid(),
    user_id: ch.uint64(),
    name: ch.lowCardinality(ch.string()),
    properties: ch.map(ch.string(), ch.string()),
    amount: ch.nullable(ch.decimal(18, 4)),
    tags: ch.array(ch.string()),
    created_at: ch.dateTime("UTC"),
    // Computed server-side, so excluded from inserts:
    day: col(ch.date(), { materialized: "toDate(created_at)" }),
  },
  {
    engine: "MergeTree",
    orderBy: ["created_at", "id"], // ← `id` / `created_at` autocomplete from the columns
    partitionBy: "toYYYYMM(created_at)",
    indexes: [
      // `expression` autocompletes column names; `type` autocompletes known index types.
      { name: "idx_user_id", expression: "user_id", type: "bloom_filter(0.01)", granularity: 4 },
      { name: "idx_name", expression: "name", type: "tokenbf_v1(256, 2, 0)", granularity: 1 },
    ],
  },
);
