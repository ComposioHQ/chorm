import { Schema } from "effect";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { and, ch, count, desc, eq, from, gt, inArray, like, max, or, table } from "../src/index.ts";

const events = table(
  "events",
  {
    id: ch.uint64(),
    name: ch.string(),
    created_at: ch.dateTime(),
    score: ch.nullable(ch.float64()),
    tags: ch.array(ch.string()),
  },
  { engine: "MergeTree", orderBy: ["id"] },
);

describe("select compilation", () => {
  test("select all enumerates aliased columns", () => {
    const { sql } = from(events).toSql();
    expect(sql).toContain("SELECT `events`.`id` AS `id`");
    expect(sql).toContain("`events`.`name` AS `name`");
    expect(sql).toContain("FROM `events`");
  });

  test("where binds literal parameters with the column type", () => {
    const { sql, params } = from(events).where(eq(events.id, 5n)).toSql();
    expect(sql).toContain("WHERE ((`events`.`id` = {p0:UInt64}))");
    expect(params).toEqual({ p0: 5n });
  });

  test("multiple conditions combine and number sequentially", () => {
    const { sql, params } = from(events)
      .where(gt(events.score, 0.5), or(eq(events.name, "a"), like(events.name, "b%")))
      .toSql();
    expect(sql).toContain("{p0:Float64}");
    expect(sql).toContain("{p1:String}");
    expect(sql).toContain("{p2:String}");
    expect(params).toEqual({ p0: 0.5, p1: "a", p2: "b%" });
  });

  test("inArray binds an Array-typed parameter", () => {
    const { sql, params } = from(events)
      .where(inArray(events.id, [1n, 2n, 3n]))
      .toSql();
    expect(sql).toContain("IN {p0:Array(UInt64)}");
    expect(params).toEqual({ p0: [1n, 2n, 3n] });
  });

  test("projection, group by, order by, limit", () => {
    const { sql } = from(events)
      .select({ label: events.name, total: count(), top: max(events.score) })
      .where(and(gt(events.id, 0n)))
      .groupBy(events.name)
      .orderBy(desc(count()))
      .limit(10)
      .offset(5)
      .toSql();
    expect(sql).toContain("SELECT `events`.`name` AS `label`, count() AS `total`");
    expect(sql).toContain("max(`events`.`score`) AS `top`");
    expect(sql).toContain("GROUP BY `events`.`name`");
    expect(sql).toContain("ORDER BY count() DESC");
    expect(sql).toContain("LIMIT 10");
    expect(sql).toContain("OFFSET 5");
  });

  test("final and distinct modifiers", () => {
    expect(from(events).final().toSql().sql).toContain("FROM `events` FINAL");
    expect(from(events).distinct().toSql().sql).toContain("SELECT DISTINCT");
  });

  test("rejects non-integer limits", () => {
    expect(() => from(events).limit(1.5)).toThrow();
  });
});

describe("row decoding", () => {
  test("select-all rowSchema decodes a JSONEachRow row", () => {
    const schema = from(events).rowSchema();
    const decoded = Schema.decodeUnknownSync(schema)({
      id: "5",
      name: "launch",
      created_at: 1_700_000_000,
      score: null,
      tags: ["a", "b"],
    });
    expect(decoded).toEqual({
      id: 5n,
      name: "launch",
      created_at: new Date("2023-11-14T22:13:20Z"),
      score: null,
      tags: ["a", "b"],
    });
  });
});

describe("projection type inference", () => {
  test("select narrows the decoded row type", () => {
    const projected = from(events).select({ total: count(), label: events.name });
    const decoded = Schema.decodeUnknownSync(projected.rowSchema())({ total: "1", label: "x" });
    expectTypeOf(decoded).toEqualTypeOf<{ readonly total: bigint; readonly label: string }>();
    expect(decoded).toEqual({ total: 1n, label: "x" });
  });
});
