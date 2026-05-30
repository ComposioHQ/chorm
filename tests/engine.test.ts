import { describe, expect, test } from "vite-plus/test";
import {
  createTableSql,
  ch,
  engineNeedsFinal,
  engineVersionColumn,
  generateModule,
  mergeTree,
  parseCreateTable,
  renderEngine,
  replacingMergeTree,
  sharedReplacingMergeTree,
  table,
  tableNeedsFinal,
  tableVersionColumn,
} from "../src/index.ts";

describe("engine builders", () => {
  test("render to the engine clause", () => {
    expect(renderEngine(mergeTree())).toBe("MergeTree");
    expect(renderEngine(replacingMergeTree("version"))).toBe("ReplacingMergeTree(version)");
    expect(renderEngine(sharedReplacingMergeTree({ version: "version" }))).toBe(
      "SharedReplacingMergeTree(version)",
    );
    expect(
      renderEngine(
        sharedReplacingMergeTree({
          path: "/clickhouse/tables/{uuid}/{shard}",
          replica: "{replica}",
          version: "version",
        }),
      ),
    ).toBe("SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version)");
  });

  test("expose FINAL semantics and the version column", () => {
    const engine = sharedReplacingMergeTree({ version: "version" });
    expect(engineNeedsFinal(engine)).toBe(true);
    expect(engineVersionColumn(engine)).toBe("version");
    expect(engineNeedsFinal(mergeTree())).toBe(false);
    // raw strings carry no structured semantics
    expect(engineNeedsFinal("SharedReplacingMergeTree(version)")).toBe(false);
  });
});

describe("DDL uses the structured engine", () => {
  test("createTableSql renders the engine builder", () => {
    const t = table(
      "events",
      { id: ch.uint64(), version: ch.uint64() },
      { engine: sharedReplacingMergeTree({ version: "version" }), orderBy: ["id"] },
    );
    expect(createTableSql(t)).toContain("ENGINE = SharedReplacingMergeTree(version)");
  });

  test("table-level FINAL helpers read the engine", () => {
    const replacing = table(
      "r",
      { id: ch.uint64(), version: ch.uint64() },
      { engine: sharedReplacingMergeTree({ version: "version" }), orderBy: ["id"] },
    );
    const plain = table("m", { id: ch.uint64() }, { engine: mergeTree(), orderBy: ["id"] });
    expect(tableNeedsFinal(replacing)).toBe(true);
    expect(tableVersionColumn(replacing)).toBe("version");
    expect(tableNeedsFinal(plain)).toBe(false);
    expect(tableVersionColumn(plain)).toBe(null);
  });
});

describe("codegen emits engine builders", () => {
  test("a SharedReplacingMergeTree round-trips into a builder call + import", () => {
    const ddl =
      "CREATE TABLE analytics.users (`id` String, `version` Int64) ENGINE = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', version) PRIMARY KEY id ORDER BY id SETTINGS index_granularity = 8192";
    const parsed = parseCreateTable(ddl);
    if (parsed === null) throw new Error("failed to parse");
    const code = generateModule([parsed]);
    expect(code).toContain(
      'engine: sharedReplacingMergeTree({ path: "/clickhouse/tables/{uuid}/{shard}", replica: "{replica}", version: "version" }),',
    );
    expect(code).toContain("sharedReplacingMergeTree");
    expect(code).toContain('} from "chorm";');
  });
});
