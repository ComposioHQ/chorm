import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { ch, col, type InferInsert, type InferRow, table, tableMeta } from "../src/index.ts";

const events = table(
  "events",
  {
    id: ch.uint64(),
    name: ch.string(),
    created_at: col(ch.dateTime(), { default: "now()" }),
    score: ch.nullable(ch.float64()),
    tags: ch.array(ch.lowCardinality(ch.string())),
    computed: col(ch.uint32(), { materialized: "id * 2" }),
  },
  { engine: "MergeTree", orderBy: ["id"] },
);

describe("table metadata", () => {
  test("column order and accessors", () => {
    const meta = tableMeta(events);
    expect(meta.name).toBe("events");
    expect(meta.columnOrder).toEqual(["id", "name", "created_at", "score", "tags", "computed"]);
    expect(events.id.name).toBe("id");
    expect(events.id.table).toBe("events");
    expect(events.id.type.typeName).toBe("UInt64");
    expect(events.tags.type.typeName).toBe("Array(LowCardinality(String))");
    expect(meta.config.engine).toBe("MergeTree");
  });

  test("column names do not collide with internal metadata", () => {
    const weird = table("t", { name: ch.string(), table: ch.string() }, { orderBy: ["name"] });
    expect(weird.name.name).toBe("name");
    expect(weird.table.name).toBe("table");
    expect(tableMeta(weird).name).toBe("t");
  });
});

describe("type inference", () => {
  test("InferRow reflects every column's decoded type", () => {
    expectTypeOf<InferRow<typeof events>>().toEqualTypeOf<{
      readonly id: bigint;
      readonly name: string;
      readonly created_at: Date;
      readonly score: number | null;
      readonly tags: ReadonlyArray<string>;
      readonly computed: number;
    }>();
  });

  test("InferInsert makes DEFAULT columns optional and excludes MATERIALIZED ones", () => {
    expectTypeOf<InferInsert<typeof events>>().toEqualTypeOf<{
      readonly id: bigint;
      readonly name: string;
      readonly score: number | null;
      readonly tags: ReadonlyArray<string>;
      readonly created_at?: Date;
    }>();
  });
});
