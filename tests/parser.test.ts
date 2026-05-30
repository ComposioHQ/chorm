import { describe, expect, test } from "vite-plus/test";
import { parseType, renderType, splitTopLevel, unwrapType } from "../src/introspect/parser.ts";

describe("splitTopLevel", () => {
  test("splits respecting nested parens", () => {
    expect(splitTopLevel("String, Array(UInt64), Map(String, UInt8)")).toEqual([
      "String",
      "Array(UInt64)",
      "Map(String, UInt8)",
    ]);
  });

  test("does not split inside quoted strings", () => {
    expect(splitTopLevel("'a, b' = 1, 'c' = 2")).toEqual(["'a, b' = 1", "'c' = 2"]);
  });

  test("handles escaped quotes", () => {
    expect(splitTopLevel("'a\\'b' = 1, 'c' = 2")).toEqual(["'a\\'b' = 1", "'c' = 2"]);
  });
});

describe("parseType", () => {
  test("simple types", () => {
    expect(parseType("UInt64")).toEqual({ kind: "Simple", name: "UInt64" });
    expect(parseType("String")).toEqual({ kind: "Simple", name: "String" });
    expect(parseType("Bool")).toEqual({ kind: "Simple", name: "Bool" });
    expect(parseType("Boolean")).toEqual({ kind: "Simple", name: "Bool" });
  });

  test("FixedString", () => {
    expect(parseType("FixedString(16)")).toEqual({ kind: "FixedString", length: 16 });
  });

  test("DateTime variants", () => {
    expect(parseType("DateTime")).toEqual({ kind: "DateTime", timezone: null });
    expect(parseType("DateTime('UTC')")).toEqual({ kind: "DateTime", timezone: "UTC" });
    expect(parseType("DateTime64(3, 'Europe/Moscow')")).toEqual({
      kind: "DateTime64",
      precision: 3,
      timezone: "Europe/Moscow",
    });
    expect(parseType("DateTime64(9)")).toEqual({
      kind: "DateTime64",
      precision: 9,
      timezone: null,
    });
  });

  test("Decimal forms", () => {
    expect(parseType("Decimal(18, 4)")).toEqual({ kind: "Decimal", precision: 18, scale: 4 });
    expect(parseType("Decimal64(2)")).toEqual({ kind: "Decimal", precision: 18, scale: 2 });
    expect(parseType("Decimal256(18)")).toEqual({ kind: "Decimal", precision: 76, scale: 18 });
  });

  test("Enum with escaped quotes and commas", () => {
    expect(parseType("Enum8('active' = 1, 'in, active' = 2)")).toEqual({
      kind: "Enum",
      size: 8,
      members: [
        { name: "active", value: 1 },
        { name: "in, active", value: 2 },
      ],
    });
    expect(parseType("Enum16('a\\'b' = -1)")).toEqual({
      kind: "Enum",
      size: 16,
      members: [{ name: "a'b", value: -1 }],
    });
  });

  test("nested containers", () => {
    expect(parseType("Array(Nullable(String))")).toEqual({
      kind: "Array",
      inner: { kind: "Nullable", inner: { kind: "Simple", name: "String" } },
    });
    expect(parseType("Map(String, Array(UInt64))")).toEqual({
      kind: "Map",
      key: { kind: "Simple", name: "String" },
      value: { kind: "Array", inner: { kind: "Simple", name: "UInt64" } },
    });
  });

  test("unnamed vs named tuples", () => {
    expect(parseType("Tuple(UInt8, String)")).toEqual({
      kind: "Tuple",
      elements: [
        { name: null, type: { kind: "Simple", name: "UInt8" } },
        { name: null, type: { kind: "Simple", name: "String" } },
      ],
    });
    expect(parseType("Tuple(a UInt8, b DateTime64(3, 'UTC'))")).toEqual({
      kind: "Tuple",
      elements: [
        { name: "a", type: { kind: "Simple", name: "UInt8" } },
        { name: "b", type: { kind: "DateTime64", precision: 3, timezone: "UTC" } },
      ],
    });
  });

  test("Nested", () => {
    expect(parseType("Nested(x UInt8, y String)")).toEqual({
      kind: "Nested",
      columns: [
        { name: "x", type: { kind: "Simple", name: "UInt8" } },
        { name: "y", type: { kind: "Simple", name: "String" } },
      ],
    });
  });

  test("semi-structured + exotic", () => {
    expect(parseType("JSON")).toEqual({ kind: "Json" });
    expect(parseType("Dynamic")).toEqual({ kind: "Dynamic" });
    expect(parseType("Variant(UInt64, String)")).toEqual({
      kind: "Variant",
      variants: [
        { kind: "Simple", name: "UInt64" },
        { kind: "Simple", name: "String" },
      ],
    });
    expect(parseType("SimpleAggregateFunction(sum, UInt64)")).toEqual({
      kind: "SimpleAggregateFunction",
      func: "sum",
      inner: { kind: "Simple", name: "UInt64" },
    });
  });

  test("AggregateFunction with a parameterized function", () => {
    expect(parseType("AggregateFunction(quantiles(0.5, 0.9), Float64)")).toEqual({
      kind: "AggregateFunction",
      func: "quantiles(0.5, 0.9)",
      args: [{ kind: "Simple", name: "Float64" }],
    });
  });
});

describe("unwrapType", () => {
  test("strips wrappers in either order", () => {
    expect(unwrapType(parseType("LowCardinality(Nullable(String))"))).toEqual({
      base: { kind: "Simple", name: "String" },
      nullable: true,
      lowCardinality: true,
    });
    expect(unwrapType(parseType("Nullable(UInt64)"))).toEqual({
      base: { kind: "Simple", name: "UInt64" },
      nullable: true,
      lowCardinality: false,
    });
  });
});

describe("renderType round-trips", () => {
  const cases = [
    "UInt64",
    "Array(Nullable(String))",
    "Map(String, Array(UInt64))",
    "Tuple(a UInt8, b String)",
    "Tuple(UInt8, String)",
    "Nullable(Decimal(18, 4))",
    "LowCardinality(String)",
    "DateTime64(3, 'UTC')",
    "Nested(x UInt8, y String)",
    "Enum8('active' = 1, 'inactive' = 2)",
  ];
  for (const type of cases) {
    test(type, () => {
      expect(renderType(parseType(type))).toBe(type);
    });
  }
});
