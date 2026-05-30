import { describe, expect, test } from "vite-plus/test";
import {
  generateModule,
  type IntrospectedTable,
  parseType,
  renderTypeExpr,
  toVariableName,
} from "../src/index.ts";

describe("renderTypeExpr", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["UInt64", "ch.uint64()"],
    ["String", "ch.string()"],
    ["Array(Nullable(String))", "ch.array(ch.nullable(ch.string()))"],
    ["Map(String, UInt32)", "ch.map(ch.string(), ch.uint32())"],
    ["Tuple(a UInt8, b String)", "ch.namedTuple({ a: ch.uint8(), b: ch.string() })"],
    ["Tuple(UInt8, String)", "ch.tuple(ch.uint8(), ch.string())"],
    ["Enum8('active' = 1, 'inactive' = 2)", "ch.enum8({ active: 1, inactive: 2 })"],
    ["DateTime64(3, 'UTC')", 'ch.dateTime64(3, "UTC")'],
    ["Decimal(18, 4)", "ch.decimal(18, 4)"],
    ["LowCardinality(String)", "ch.lowCardinality(ch.string())"],
    ["AggregateFunction(sum, UInt64)", 'ch.dynamic("AggregateFunction(sum, UInt64)")'],
  ];
  for (const [input, expected] of cases) {
    test(input, () => {
      expect(renderTypeExpr(parseType(input))).toBe(expected);
    });
  }
});

describe("toVariableName", () => {
  test("sanitizes table names", () => {
    expect(toVariableName("events")).toBe("events");
    expect(toVariableName("my-table")).toBe("my_table");
    expect(toVariableName("123abc")).toBe("t_123abc");
  });
});

describe("generateModule", () => {
  const tables: ReadonlyArray<IntrospectedTable> = [
    {
      name: "events",
      engine: "MergeTree",
      orderBy: ["id"],
      partitionBy: "toYYYYMM(created_at)",
      primaryKey: null,
      sampleBy: null,
      comment: "",
      columns: [
        {
          name: "id",
          rawType: "UInt64",
          parsedType: parseType("UInt64"),
          defaultKind: "",
          defaultExpression: "",
          codec: "",
          comment: "",
        },
        {
          name: "created_at",
          rawType: "DateTime",
          parsedType: parseType("DateTime"),
          defaultKind: "DEFAULT",
          defaultExpression: "now()",
          codec: "ZSTD(3)",
          comment: "",
        },
        {
          name: "tags",
          rawType: "Array(LowCardinality(String))",
          parsedType: parseType("Array(LowCardinality(String))"),
          defaultKind: "",
          defaultExpression: "",
          codec: "",
          comment: "",
        },
      ],
      indexes: [
        { name: "idx_id", expression: "id", type: "minmax", granularity: 1 },
        { name: "idx_tags", expression: "tags", type: "bloom_filter(0.01)", granularity: 4 },
      ],
      ttl: "toDateTime(created_at) + toIntervalYear(1)",
      settings: { index_granularity: 8192, ttl_only_drop_parts: 1 },
    },
  ];

  const module = generateModule(tables, { database: "analytics" });

  test("imports col and engine builders only when needed, from the chorm package", () => {
    expect(module).toContain('import { ch, col, table, mergeTree } from "chorm";');
    expect(module).toContain("// Source database: analytics");
  });

  test("renders a table declaration with typed columns", () => {
    expect(module).toContain("export const events = table(");
    expect(module).toContain('"events"');
    expect(module).toContain("id: ch.uint64(),");
    expect(module).toContain(
      'created_at: col(ch.dateTime(), { default: "now()", codec: "ZSTD(3)" }),',
    );
    expect(module).toContain("tags: ch.array(ch.lowCardinality(ch.string())),");
    expect(module).toContain("engine: mergeTree(),");
    expect(module).toContain('orderBy: ["id"]');
    expect(module).toContain('partitionBy: "toYYYYMM(created_at)"');
  });

  test("renders data-skipping indexes", () => {
    expect(module).toContain("indexes: [");
    expect(module).toContain(
      '{ name: "idx_tags", expression: "tags", type: "bloom_filter(0.01)", granularity: 4 },',
    );
    expect(module).toContain(
      '{ name: "idx_id", expression: "id", type: "minmax", granularity: 1 },',
    );
  });

  test("omits the col import when no column needs config", () => {
    const simple = generateModule([{ ...tables[0], columns: [tables[0].columns[0]] }]);
    expect(simple).toContain('import { ch, table, mergeTree } from "chorm";');
  });
});
