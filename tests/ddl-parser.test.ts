import { describe, expect, test } from "vite-plus/test";
import { generateModule, parseCreateTable, parseCreateTables } from "../src/index.ts";

// Synthetic CREATE TABLE DDL exercising every parser feature (no real schema).
const EVENTS = `CREATE TABLE analytics.events (\`id\` String, \`user_id\` String, \`category\` LowCardinality(String), \`note\` Nullable(String) DEFAULT NULL, \`amount\` Nullable(String) DEFAULT NULL, \`created_at\` DateTime64(6) DEFAULT now64()) ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toYYYYMM(created_at) ORDER BY (category, user_id, created_at, id) TTL toDateTime(created_at) + toIntervalYear(1) SETTINGS index_granularity = 8192`;

const AUDIT_LOG = `CREATE TABLE analytics.audit_log (\`id\` UUID DEFAULT generateUUIDv4(), \`action\` String, \`item_ids\` Array(String), \`summary\` String, \`is_flagged\` Bool, \`owner_id\` Nullable(String), \`created_at\` DateTime DEFAULT now(), \`error_hash\` String DEFAULT '', \`hits\` UInt32 DEFAULT 1, INDEX idx_error_hash error_hash TYPE bloom_filter GRANULARITY 1, INDEX idx_flagged is_flagged TYPE minmax GRANULARITY 4, INDEX idx_action action TYPE bloom_filter GRANULARITY 1) ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') ORDER BY (created_at, action) SETTINGS index_granularity = 8192`;

const REQUEST_LOG = `CREATE TABLE analytics.request_log (\`id\` String, \`payload\` String, \`created_at\` DateTime64(6), \`project_id\` String, \`trace_id\` String MATERIALIZED JSONExtractString(payload, 'trace_id'), \`span_id\` String MATERIALIZED JSONExtractString(payload, 'span_id'), INDEX idx_created_minmax created_at TYPE minmax GRANULARITY 64, INDEX idx_project_bf project_id TYPE tokenbf_v1(512, 5, 0) GRANULARITY 4, INDEX idx_trace_id trace_id TYPE bloom_filter GRANULARITY 4) ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version) PARTITION BY toYYYYMM(created_at) ORDER BY (project_id, created_at, id) TTL toDateTime(created_at) + toIntervalYear(1) SETTINGS index_granularity = 8192`;

const INNER_MV = `CREATE TABLE analytics.\`.inner_id.00000000-0000-0000-0000-000000000000\` (\`date\` Date, \`total\` UInt64) ENGINE = SharedSummingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toYYYYMM(date) ORDER BY date SETTINGS index_granularity = 8192`;

const nn = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("unexpected null");
  return value;
};

describe("parseCreateTable", () => {
  test("columns, defaults, TTL, partition and order key", () => {
    const t = nn(parseCreateTable(EVENTS));
    expect(t.name).toBe("events");
    expect(t.columns.map((c) => c.name)).toContain("category");
    expect(t.partitionBy).toBe("toYYYYMM(created_at)");
    expect(t.orderBy).toEqual(["category", "user_id", "created_at", "id"]);
    expect(t.ttl).toBe("toDateTime(created_at) + toIntervalYear(1)");

    const note = nn(t.columns.find((c) => c.name === "note"));
    expect(note.parsedType).toEqual({
      kind: "Nullable",
      inner: { kind: "Simple", name: "String" },
    });
    expect(note.defaultKind).toBe("DEFAULT");
    expect(note.defaultExpression).toBe("NULL");

    const createdAt = nn(t.columns.find((c) => c.name === "created_at"));
    expect(createdAt.rawType).toBe("DateTime64(6)");
    expect(createdAt.defaultExpression).toBe("now64()");
  });

  test("data-skipping indices (bloom filters / minmax)", () => {
    const t = nn(parseCreateTable(AUDIT_LOG));
    expect(t.indexes).toEqual([
      { name: "idx_error_hash", expression: "error_hash", type: "bloom_filter", granularity: 1 },
      { name: "idx_flagged", expression: "is_flagged", type: "minmax", granularity: 4 },
      { name: "idx_action", expression: "action", type: "bloom_filter", granularity: 1 },
    ]);
    const id = nn(t.columns.find((c) => c.name === "id"));
    expect(id.parsedType).toEqual({ kind: "Simple", name: "UUID" });
    expect(id.defaultExpression).toBe("generateUUIDv4()");
  });

  test("MATERIALIZED columns and tokenbf_v1 indices", () => {
    const t = nn(parseCreateTable(REQUEST_LOG));
    const traceId = nn(t.columns.find((c) => c.name === "trace_id"));
    expect(traceId.defaultKind).toBe("MATERIALIZED");
    expect(traceId.defaultExpression).toBe("JSONExtractString(payload, 'trace_id')");
    expect(t.indexes.map((i) => i.type)).toContain("tokenbf_v1(512, 5, 0)");
    expect(t.engine).toBe(
      "SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)",
    );
  });
});

describe("parseCreateTables", () => {
  test("splits multiple statements and skips materialized-view inner tables", () => {
    const tables = parseCreateTables([INNER_MV, EVENTS, AUDIT_LOG].join("\n"));
    expect(tables.map((t) => t.name)).toEqual(["events", "audit_log"]);
  });

  test("round-trips MATERIALIZED and indices through codegen", () => {
    const tables = parseCreateTables(REQUEST_LOG);
    const code = generateModule(tables);
    expect(code).toContain(
      `trace_id: col(ch.string(), { materialized: "JSONExtractString(payload, 'trace_id')" }),`,
    );
    expect(code).toContain(
      '{ name: "idx_trace_id", expression: "trace_id", type: "bloom_filter", granularity: 4 },',
    );
    expect(code).toContain('ttl: "toDateTime(created_at) + toIntervalYear(1)"');
  });
});
