import { describe, expect, test } from "vite-plus/test";
import { ch, col, createTableSql, dropTableSql, table } from "../src/index.ts";

const events = table(
  "events",
  {
    id: ch.uint64(),
    name: ch.string(),
    created_at: col(ch.dateTime(), { default: "now()" }),
    amount: ch.decimal(18, 4),
    note: col(ch.string(), { comment: "free text" }),
  },
  {
    engine: "ReplacingMergeTree(created_at)",
    orderBy: ["id"],
    partitionBy: "toYYYYMM(created_at)",
    settings: { index_granularity: 8192 },
    indexes: [{ name: "idx_name", expression: "name", type: "bloom_filter(0.01)", granularity: 4 }],
  },
);

describe("createTableSql", () => {
  const sql = createTableSql(events, { ifNotExists: true, database: "analytics" });

  test("header, columns and clauses", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `analytics`.`events`");
    expect(sql).toContain("`id` UInt64");
    expect(sql).toContain("`created_at` DateTime DEFAULT now()");
    expect(sql).toContain("`amount` Decimal(18, 4)");
    expect(sql).toContain("`note` String COMMENT 'free text'");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(created_at)");
    expect(sql).toContain("ORDER BY (id)");
    expect(sql).toContain("PARTITION BY toYYYYMM(created_at)");
    expect(sql).toContain("SETTINGS index_granularity = 8192");
  });

  test("emits data-skipping indexes inside the column list", () => {
    expect(sql).toContain("INDEX `idx_name` name TYPE bloom_filter(0.01) GRANULARITY 4");
  });
});

describe("dropTableSql", () => {
  test("renders DROP TABLE", () => {
    expect(dropTableSql(events, { ifExists: true })).toBe("DROP TABLE IF EXISTS `events`");
  });
});
