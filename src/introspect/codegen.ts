/**
 * Pure code generation: turn an {@link IntrospectedTable} model into TypeScript source that uses
 * the `chorm` DSL (`table(...)`, `ch.*`, `col(...)`). No database access — given the model, the
 * output is deterministic.
 */
import type { IntrospectedColumn, IntrospectedTable } from "./columns.ts";
import type { ParsedType, SimpleTypeName } from "./parser.ts";
import { renderType, splitTopLevel } from "./parser.ts";

// ---------------------------------------------------------------------------
// Engine builders
// ---------------------------------------------------------------------------

const SHARED_ENGINES: Record<string, { readonly fn: string; readonly hasVersion: boolean }> = {
  SharedMergeTree: { fn: "sharedMergeTree", hasVersion: false },
  SharedReplacingMergeTree: { fn: "sharedReplacingMergeTree", hasVersion: true },
  SharedSummingMergeTree: { fn: "sharedSummingMergeTree", hasVersion: false },
  SharedAggregatingMergeTree: { fn: "sharedAggregatingMergeTree", hasVersion: false },
  ReplicatedMergeTree: { fn: "replicatedMergeTree", hasVersion: false },
  ReplicatedReplacingMergeTree: { fn: "replicatedReplacingMergeTree", hasVersion: true },
  ReplicatedSummingMergeTree: { fn: "replicatedSummingMergeTree", hasVersion: false },
};

const SIMPLE_ENGINES: Record<string, string> = {
  MergeTree: "mergeTree",
  AggregatingMergeTree: "aggregatingMergeTree",
  Memory: "memory",
  TinyLog: "tinyLog",
  Log: "log",
};

const unquoteString = (value: string): string =>
  value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;

const parseEngineString = (
  engine: string,
): { readonly name: string; readonly params: Array<string> } => {
  const open = engine.indexOf("(");
  if (open === -1) return { name: engine.trim(), params: [] };
  const name = engine.slice(0, open).trim();
  const inner = engine.slice(open + 1, engine.lastIndexOf(")"));
  return { name, params: splitTopLevel(inner).map((p) => p.trim()) };
};

/** Render an engine string as a builder call, plus the builder name to import (or `null`). */
const renderEngineExpr = (
  engine: string,
): { readonly expr: string; readonly fn: string | null } => {
  const { name, params } = parseEngineString(engine);
  const raw = { expr: JSON.stringify(engine), fn: null };

  if (SIMPLE_ENGINES[name] !== undefined && params.length === 0) {
    return { expr: `${SIMPLE_ENGINES[name]}()`, fn: SIMPLE_ENGINES[name] };
  }
  if (name === "ReplacingMergeTree") {
    return {
      expr:
        params.length > 0
          ? `replacingMergeTree(${JSON.stringify(params[0])})`
          : "replacingMergeTree()",
      fn: "replacingMergeTree",
    };
  }
  if (name === "CollapsingMergeTree" && params.length === 1) {
    return { expr: `collapsingMergeTree(${JSON.stringify(params[0])})`, fn: "collapsingMergeTree" };
  }
  const shared = SHARED_ENGINES[name];
  if (shared !== undefined) {
    const expectedMax = shared.hasVersion ? 3 : 2;
    if (params.length > expectedMax) return raw;
    const opts: Array<string> = [];
    if (params[0] !== undefined) opts.push(`path: ${JSON.stringify(unquoteString(params[0]))}`);
    if (params[1] !== undefined) opts.push(`replica: ${JSON.stringify(unquoteString(params[1]))}`);
    if (shared.hasVersion && params[2] !== undefined)
      opts.push(`version: ${JSON.stringify(params[2])}`);
    return { expr: `${shared.fn}({ ${opts.join(", ")} })`, fn: shared.fn };
  }
  return raw;
};

const SIMPLE_BUILDER: Record<SimpleTypeName, string> = {
  UInt8: "ch.uint8()",
  UInt16: "ch.uint16()",
  UInt32: "ch.uint32()",
  UInt64: "ch.uint64()",
  UInt128: "ch.uint128()",
  UInt256: "ch.uint256()",
  Int8: "ch.int8()",
  Int16: "ch.int16()",
  Int32: "ch.int32()",
  Int64: "ch.int64()",
  Int128: "ch.int128()",
  Int256: "ch.int256()",
  Float32: "ch.float32()",
  Float64: "ch.float64()",
  BFloat16: "ch.float64()",
  String: "ch.string()",
  UUID: "ch.uuid()",
  Date: "ch.date()",
  Date32: "ch.date32()",
  Time: 'ch.dynamic("Time")',
  IPv4: "ch.ipv4()",
  IPv6: "ch.ipv6()",
  Bool: "ch.bool()",
  Nothing: 'ch.dynamic("Nothing")',
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A valid object-literal key: bare if a plain identifier, else a quoted string. */
const propKey = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** Render a {@link ParsedType} as a `ch.*` builder expression. */
export const renderTypeExpr = (parsed: ParsedType): string => {
  switch (parsed.kind) {
    case "Simple":
      return SIMPLE_BUILDER[parsed.name];
    case "FixedString":
      return `ch.fixedString(${parsed.length})`;
    case "DateTime":
      return parsed.timezone === null
        ? "ch.dateTime()"
        : `ch.dateTime(${JSON.stringify(parsed.timezone)})`;
    case "DateTime64":
      return parsed.timezone === null
        ? `ch.dateTime64(${parsed.precision})`
        : `ch.dateTime64(${parsed.precision}, ${JSON.stringify(parsed.timezone)})`;
    case "Decimal":
      return `ch.decimal(${parsed.precision}, ${parsed.scale})`;
    case "Enum": {
      const members = parsed.members.map((m) => `${propKey(m.name)}: ${m.value}`).join(", ");
      return `ch.enum${parsed.size}({ ${members} })`;
    }
    case "Nullable":
      return `ch.nullable(${renderTypeExpr(parsed.inner)})`;
    case "LowCardinality":
      return `ch.lowCardinality(${renderTypeExpr(parsed.inner)})`;
    case "Array":
      return `ch.array(${renderTypeExpr(parsed.inner)})`;
    case "Map":
      return `ch.map(${renderTypeExpr(parsed.key)}, ${renderTypeExpr(parsed.value)})`;
    case "Tuple": {
      const allNamed = parsed.elements.every((e) => e.name !== null);
      if (allNamed && parsed.elements.length > 0) {
        const fields = parsed.elements
          .map((e) => `${propKey(e.name as string)}: ${renderTypeExpr(e.type)}`)
          .join(", ");
        return `ch.namedTuple({ ${fields} })`;
      }
      return `ch.tuple(${parsed.elements.map((e) => renderTypeExpr(e.type)).join(", ")})`;
    }
    case "Nested": {
      const fields = parsed.columns
        .map((c) => `${propKey(c.name)}: ${renderTypeExpr(c.type)}`)
        .join(", ");
      return `ch.nested({ ${fields} })`;
    }
    case "Json":
      return "ch.json()";
    case "AggregateFunction":
    case "SimpleAggregateFunction":
    case "Variant":
    case "Dynamic":
    case "Unknown":
      // Exotic / aggregate-state types decode as `unknown` but preserve their CH type string.
      return `ch.dynamic(${JSON.stringify(renderType(parsed))})`;
  }
};

/** Does this column need a `col(...)` wrapper (i.e. has config), or is the bare type enough? */
const needsColWrapper = (column: IntrospectedColumn): boolean =>
  column.defaultKind !== "" || column.comment.trim() !== "" || column.codec.trim() !== "";

const renderColumn = (column: IntrospectedColumn): string => {
  const typeExpr = renderTypeExpr(column.parsedType);
  if (!needsColWrapper(column)) return typeExpr;

  const config: Array<string> = [];
  if (column.defaultKind === "DEFAULT")
    config.push(`default: ${JSON.stringify(column.defaultExpression)}`);
  else if (column.defaultKind === "MATERIALIZED")
    config.push(`materialized: ${JSON.stringify(column.defaultExpression)}`);
  else if (column.defaultKind === "ALIAS")
    config.push(`alias: ${JSON.stringify(column.defaultExpression)}`);
  if (column.codec.trim() !== "") config.push(`codec: ${JSON.stringify(column.codec)}`);
  if (column.comment.trim() !== "") config.push(`comment: ${JSON.stringify(column.comment)}`);
  return `col(${typeExpr}, { ${config.join(", ")} })`;
};

/** Convert a table name into a safe exported variable identifier. */
export const toVariableName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return IDENTIFIER.test(cleaned) ? cleaned : `t_${cleaned}`;
};

const renderTableConfig = (table: IntrospectedTable): string => {
  const lines: Array<string> = [`    engine: ${renderEngineExpr(table.engine).expr},`];
  lines.push(`    orderBy: [${table.orderBy.map((o) => JSON.stringify(o)).join(", ")}],`);
  if (table.partitionBy !== null)
    lines.push(`    partitionBy: ${JSON.stringify(table.partitionBy)},`);
  if (table.primaryKey !== null) {
    lines.push(`    primaryKey: [${table.primaryKey.map((k) => JSON.stringify(k)).join(", ")}],`);
  }
  if (table.sampleBy !== null) lines.push(`    sampleBy: ${JSON.stringify(table.sampleBy)},`);
  if (table.indexes.length > 0) {
    const entries = table.indexes
      .map(
        (index) =>
          `      { name: ${JSON.stringify(index.name)}, expression: ${JSON.stringify(
            index.expression,
          )}, type: ${JSON.stringify(index.type)}, granularity: ${index.granularity} },`,
      )
      .join("\n");
    lines.push(`    indexes: [\n${entries}\n    ],`);
  }
  if (table.ttl !== null && table.ttl.trim() !== "")
    lines.push(`    ttl: ${JSON.stringify(table.ttl)},`);
  // `index_granularity: 8192` is the default on every table — drop it to keep output clean.
  const settings = Object.entries(table.settings).filter(
    ([key, value]) => !(key === "index_granularity" && value === 8192),
  );
  if (settings.length > 0) {
    const entries = settings
      .map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`)
      .join(", ");
    lines.push(`    settings: { ${entries} },`);
  }
  if (table.comment.trim() !== "") lines.push(`    comment: ${JSON.stringify(table.comment)},`);
  return lines.join("\n");
};

/** Render the `export const <name> = table(...)` declaration for one table. */
export const renderTable = (table: IntrospectedTable): string => {
  const columns = table.columns
    .map((column) => `    ${propKey(column.name)}: ${renderColumn(column)},`)
    .join("\n");
  return `export const ${toVariableName(table.name)} = table(
  ${JSON.stringify(table.name)},
  {
${columns}
  },
  {
${renderTableConfig(table)}
  },
);`;
};

export interface GenerateOptions {
  /** The database the schema was introspected from (used in the header comment). */
  readonly database?: string;
  /** The import specifier for the chorm package. Default `"chorm"`. */
  readonly importFrom?: string;
}

/** Render a complete TypeScript module from a set of introspected tables. */
export const generateModule = (
  tables: ReadonlyArray<IntrospectedTable>,
  options: GenerateOptions = {},
): string => {
  const importFrom = options.importFrom ?? "chorm";
  const usesCol = tables.some((t) => t.columns.some(needsColWrapper));
  const engineFns = new Set<string>();
  for (const t of tables) {
    const fn = renderEngineExpr(t.engine).fn;
    if (fn !== null) engineFns.add(fn);
  }
  const names = ["ch", ...(usesCol ? ["col"] : []), "table", ...[...engineFns].sort()];
  const imports = names.join(", ");
  const header = [
    "// Generated by chorm — do not edit by hand.",
    options.database ? `// Source database: ${options.database}` : null,
    `import { ${imports} } from ${JSON.stringify(importFrom)};`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const body = tables.map(renderTable).join("\n\n");
  return `${header}\n\n${body}\n`;
};
