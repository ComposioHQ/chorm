import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { ChType } from "../src/types.ts";
import * as ch from "../src/types.ts";

const decode = <A, I>(type: ChType<A, I>) => Schema.decodeUnknownSync(type.schema);
const encode = <A, I>(type: ChType<A, I>) => Schema.encodeSync(type.schema);

describe("type names", () => {
  test("scalars and composites render the canonical ClickHouse type string", () => {
    expect(ch.uint64().typeName).toBe("UInt64");
    expect(ch.array(ch.nullable(ch.string())).typeName).toBe("Array(Nullable(String))");
    expect(ch.map(ch.string(), ch.array(ch.uint64())).typeName).toBe("Map(String, Array(UInt64))");
    expect(ch.namedTuple({ a: ch.uint8(), b: ch.string() }).typeName).toBe(
      "Tuple(a UInt8, b String)",
    );
    expect(ch.tuple(ch.uint8(), ch.string()).typeName).toBe("Tuple(UInt8, String)");
    expect(ch.decimal(18, 4).typeName).toBe("Decimal(18, 4)");
    expect(ch.dateTime64(3, "UTC").typeName).toBe("DateTime64(3, 'UTC')");
    expect(ch.lowCardinality(ch.string()).typeName).toBe("LowCardinality(String)");
    expect(ch.enum8({ active: 1, inactive: 2 }).typeName).toBe(
      "Enum8('active' = 1, 'inactive' = 2)",
    );
  });
});

describe("integers", () => {
  test("64-bit ints decode strings to bigint and encode back to strings", () => {
    expect(decode(ch.uint64())("18446744073709551615")).toBe(18446744073709551615n);
    expect(encode(ch.uint64())(123n)).toBe("123");
    expect(decode(ch.int64())("-9223372036854775808")).toBe(-9223372036854775808n);
    expect(decode(ch.int256())("123456789012345678901234567890")).toBe(
      123456789012345678901234567890n,
    );
  });

  test("32-bit and smaller ints stay numbers", () => {
    expect(decode(ch.uint32())(4294967295)).toBe(4294967295);
    expect(encode(ch.int8())(-12)).toBe(-12);
  });

  test("invalid bigint input fails", () => {
    expect(() => decode(ch.uint64())("not-a-number")).toThrow();
  });
});

describe("decimals", () => {
  test("preserve precision as strings, accepting string or number", () => {
    expect(decode(ch.decimal(18, 4))("12.3400")).toBe("12.3400");
    expect(decode(ch.decimal(18, 4))(12.34)).toBe("12.34");
    expect(encode(ch.decimal(18, 4))("99.9999")).toBe("99.9999");
  });
});

describe("dates and date-times", () => {
  test("Date round-trips to UTC midnight", () => {
    const decoded = decode(ch.date())("2024-01-15");
    expect(decoded.toISOString()).toBe("2024-01-15T00:00:00.000Z");
    expect(encode(ch.date())(new Date("2024-01-15T00:00:00Z"))).toBe("2024-01-15");
  });

  test("DateTime decodes unix timestamps and encodes seconds", () => {
    const decoded = decode(ch.dateTime())(1_700_000_000);
    expect(decoded.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(encode(ch.dateTime())(new Date("2023-11-14T22:13:20Z"))).toBe(1_700_000_000);
  });

  test("DateTime also tolerates simple and ISO strings as UTC", () => {
    expect(decode(ch.dateTime())("2024-01-15 12:00:00").toISOString()).toBe(
      "2024-01-15T12:00:00.000Z",
    );
    expect(decode(ch.dateTime())("2024-01-15T12:00:00Z").toISOString()).toBe(
      "2024-01-15T12:00:00.000Z",
    );
  });
});

describe("booleans, strings, enums", () => {
  test("bool", () => {
    expect(decode(ch.bool())(true)).toBe(true);
    expect(encode(ch.bool())(false)).toBe(false);
  });

  test("enum decodes to the member name and rejects unknown values", () => {
    const status = ch.enum8({ active: 1, inactive: 2 });
    expect(decode(status)("active")).toBe("active");
    expect(() => decode(status)("deleted")).toThrow();
  });
});

describe("containers", () => {
  test("array of 64-bit ints", () => {
    expect(decode(ch.array(ch.uint64()))(["1", "2", "3"])).toEqual([1n, 2n, 3n]);
    expect(encode(ch.array(ch.uint64()))([1n, 2n])).toEqual(["1", "2"]);
  });

  test("nullable", () => {
    expect(decode(ch.nullable(ch.string()))(null)).toBe(null);
    expect(decode(ch.nullable(ch.string()))("hi")).toBe("hi");
  });

  test("map decodes a JSON object to a record", () => {
    expect(decode(ch.map(ch.string(), ch.uint32()))({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("named tuple decodes an object, unnamed tuple decodes an array", () => {
    expect(decode(ch.namedTuple({ a: ch.uint8(), b: ch.string() }))({ a: 1, b: "x" })).toEqual({
      a: 1,
      b: "x",
    });
    expect(decode(ch.tuple(ch.uint8(), ch.string()))([1, "x"])).toEqual([1, "x"]);
  });

  test("nested decodes an array of structs", () => {
    const events = ch.nested({ id: ch.uint64(), name: ch.string() });
    expect(decode(events)([{ id: "1", name: "a" }])).toEqual([{ id: 1n, name: "a" }]);
  });
});
