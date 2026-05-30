/**
 * Offline introspection: parse `CREATE TABLE` DDL (e.g. from `SHOW CREATE TABLE` or
 * `system.tables.create_table_query`) into the same {@link IntrospectedTable} model the live
 * introspection produces — no database connection required. This captures everything the DDL
 * contains: column types, `DEFAULT`/`MATERIALIZED`/`ALIAS`, `CODEC`, comments, data-skipping
 * indices (bloom filters, minmax, set, tokenbf/ngrambf), engine, keys, `TTL`, and `SETTINGS`.
 */
import { parseType, splitTopLevel } from "./parser.ts";
import type {
  DefaultKind,
  IntrospectedColumn,
  IntrospectedIndex,
  IntrospectedTable,
} from "./columns.ts";

// ---------------------------------------------------------------------------
// Low-level scanning helpers (paren/bracket/quote aware)
// ---------------------------------------------------------------------------

/** Split a string on top-level whitespace, respecting (), [], '…' and `…`. */
const tokenize = (input: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  let depth = 0;
  let quote: "'" | "`" | null = null;
  let current = "";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (quote !== null) {
      current += c;
      if (c === "\\" && quote === "'") {
        current += input[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === "`") {
      quote = c;
      current += c;
      i += 1;
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    if (depth === 0 && /\s/.test(c)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      i += 1;
      continue;
    }
    current += c;
    i += 1;
  }
  if (current.length > 0) out.push(current);
  return out;
};

const stripBackticks = (value: string): string => {
  const t = value.trim();
  return t.startsWith("`") && t.endsWith("`") ? t.slice(1, -1).replace(/``/g, "`") : t;
};

const unquote = (value: string): string => {
  const t = value.trim();
  return t.startsWith("'") && t.endsWith("'")
    ? t.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\")
    : t;
};

/** Index of the first top-level `(`, ignoring quoted regions. */
const firstTopLevelParen = (s: string): number => {
  let quote: "'" | "`" | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote !== null) {
      if (c === "\\" && quote === "'") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`") quote = c;
    else if (c === "(") return i;
  }
  return -1;
};

/** Index of the `)` matching the `(` at `openIdx`. */
const matchingParen = (s: string, openIdx: number): number => {
  let depth = 0;
  let quote: "'" | "`" | null = null;
  for (let i = openIdx; i < s.length; i += 1) {
    const c = s[i];
    if (quote !== null) {
      if (c === "\\" && quote === "'") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

// ---------------------------------------------------------------------------
// Column / index / clause parsing
// ---------------------------------------------------------------------------

const COLUMN_KEYWORDS = new Set([
  "DEFAULT",
  "MATERIALIZED",
  "ALIAS",
  "EPHEMERAL",
  "TTL",
  "COMMENT",
]);
const isColumnKeyword = (token: string): boolean => {
  const upper = token.toUpperCase();
  return COLUMN_KEYWORDS.has(upper) || upper.startsWith("CODEC(");
};

const parseColumnDef = (def: string): IntrospectedColumn => {
  const tokens = tokenize(def);
  const name = stripBackticks(tokens[0] ?? "");
  const rawType = tokens[1] ?? "String";
  let defaultKind: DefaultKind = "";
  let defaultExpression = "";
  let codec = "";
  let comment = "";

  let i = 2;
  while (i < tokens.length) {
    const upper = tokens[i].toUpperCase();
    if (upper === "DEFAULT" || upper === "MATERIALIZED" || upper === "ALIAS") {
      defaultKind = upper as DefaultKind;
      i += 1;
      const parts: Array<string> = [];
      while (i < tokens.length && !isColumnKeyword(tokens[i])) {
        parts.push(tokens[i]);
        i += 1;
      }
      defaultExpression = parts.join(" ");
    } else if (upper.startsWith("CODEC(")) {
      codec = tokens[i].slice("CODEC(".length, -1);
      i += 1;
    } else if (upper === "TTL") {
      // Per-column TTL — consumed but not modelled (rare).
      i += 1;
      while (i < tokens.length && !isColumnKeyword(tokens[i])) i += 1;
    } else if (upper === "COMMENT") {
      i += 1;
      if (i < tokens.length) {
        comment = unquote(tokens[i]);
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return {
    name,
    rawType,
    parsedType: parseType(rawType),
    defaultKind,
    defaultExpression,
    codec,
    comment,
  };
};

const parseIndexDef = (def: string): IntrospectedIndex => {
  const tokens = tokenize(def); // INDEX <name> <expr…> TYPE <type> GRANULARITY <n>
  const name = stripBackticks(tokens[1] ?? "");
  let i = 2;
  const expr: Array<string> = [];
  while (i < tokens.length && tokens[i].toUpperCase() !== "TYPE") {
    expr.push(tokens[i]);
    i += 1;
  }
  i += 1; // skip TYPE
  const type = tokens[i] ?? "";
  i += 1;
  let granularity = 1;
  if (i < tokens.length && tokens[i].toUpperCase() === "GRANULARITY") {
    granularity = Number.parseInt(tokens[i + 1] ?? "1", 10);
  }
  return { name, expression: expr.join(" "), type, granularity };
};

const CLAUSE_KEYWORDS = [
  "ENGINE",
  "PARTITION BY",
  "PRIMARY KEY",
  "ORDER BY",
  "SAMPLE BY",
  "TTL",
  "SETTINGS",
  "COMMENT",
] as const;

interface Clauses {
  readonly engine: string;
  readonly orderBy: ReadonlyArray<string>;
  readonly partitionBy: string | null;
  readonly primaryKey: ReadonlyArray<string>;
  readonly sampleBy: string | null;
  readonly ttl: string | null;
  readonly settings: Record<string, string | number>;
  readonly comment: string;
}

const parseKeyList = (value: string): ReadonlyArray<string> => {
  let v = value.trim();
  if (v.startsWith("(") && v.endsWith(")")) v = v.slice(1, -1);
  if (v.trim().length === 0) return [];
  return splitTopLevel(v)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const parseSettings = (value: string): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const pair of splitTopLevel(value)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1).trim();
    const num = Number(raw);
    out[key] = raw.length > 0 && !Number.isNaN(num) ? num : unquote(raw);
  }
  return out;
};

const parseClauses = (tail: string): Clauses => {
  const found: Array<{ readonly kw: string; readonly valueStart: number; readonly start: number }> =
    [];
  let depth = 0;
  let quote: "'" | "`" | null = null;
  for (let i = 0; i < tail.length; i += 1) {
    const c = tail[i];
    if (quote !== null) {
      if (c === "\\" && quote === "'") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") {
      depth += 1;
      continue;
    }
    if (c === ")" || c === "]") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (i !== 0 && !/\s/.test(tail[i - 1])) continue;
    for (const kw of CLAUSE_KEYWORDS) {
      if (tail.slice(i, i + kw.length).toUpperCase() !== kw) continue;
      const after = tail[i + kw.length];
      if (after === undefined || /[\s=(]/.test(after)) {
        found.push({ kw, start: i, valueStart: i + kw.length });
        i += kw.length - 1;
        break;
      }
    }
  }

  const sorted = [...found].sort((a, b) => a.start - b.start);
  const values = new Map<string, string>();
  for (let k = 0; k < sorted.length; k += 1) {
    const end = k + 1 < sorted.length ? sorted[k + 1].start : tail.length;
    let value = tail.slice(sorted[k].valueStart, end).trim();
    if (sorted[k].kw === "ENGINE" && value.startsWith("=")) value = value.slice(1).trim();
    values.set(sorted[k].kw, value);
  }

  const partitionBy = values.get("PARTITION BY") ?? null;
  const sampleBy = values.get("SAMPLE BY") ?? null;
  const ttl = values.get("TTL") ?? null;
  const settingsRaw = values.get("SETTINGS");
  const commentRaw = values.get("COMMENT");
  return {
    engine: values.get("ENGINE") ?? "MergeTree",
    orderBy: values.has("ORDER BY") ? parseKeyList(values.get("ORDER BY") as string) : [],
    partitionBy: partitionBy === null || partitionBy.trim() === "" ? null : partitionBy,
    primaryKey: values.has("PRIMARY KEY") ? parseKeyList(values.get("PRIMARY KEY") as string) : [],
    sampleBy: sampleBy === null || sampleBy.trim() === "" ? null : sampleBy,
    ttl: ttl === null || ttl.trim() === "" ? null : ttl,
    settings: settingsRaw === undefined ? {} : parseSettings(settingsRaw),
    comment: commentRaw === undefined ? "" : unquote(commentRaw),
  };
};

const extractTableName = (section: string): string => {
  const s = section.replace(/\s+ON\s+CLUSTER\s+\S+/i, "").trim();
  let inBacktick = false;
  let dot = -1;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "`") inBacktick = !inBacktick;
    else if (s[i] === "." && !inBacktick) {
      dot = i;
      break;
    }
  }
  return stripBackticks((dot === -1 ? s : s.slice(dot + 1)).trim());
};

const CREATE_TABLE_HEAD =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i;

/** Parse a single `CREATE TABLE` statement. Returns `null` if it isn't one (e.g. a view). */
export const parseCreateTable = (sql: string): IntrospectedTable | null => {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const head = CREATE_TABLE_HEAD.exec(trimmed);
  if (head === null) return null;

  const rest = trimmed.slice(head[0].length);
  const open = firstTopLevelParen(rest);
  if (open === -1) return null; // e.g. `CREATE TABLE x AS y` — no column list
  const close = matchingParen(rest, open);
  if (close === -1) return null;

  const name = extractTableName(rest.slice(0, open));
  const body = rest.slice(open + 1, close);
  const tail = rest.slice(close + 1);

  const columns: Array<IntrospectedColumn> = [];
  const indexes: Array<IntrospectedIndex> = [];
  for (const raw of splitTopLevel(body)) {
    const part = raw.trim();
    if (part.length === 0) continue;
    if (/^INDEX\s/i.test(part)) indexes.push(parseIndexDef(part));
    else if (/^(CONSTRAINT|PROJECTION|PRIMARY\s+KEY)\b/i.test(part)) continue;
    else columns.push(parseColumnDef(part));
  }

  const clauses = parseClauses(tail);
  const samePrimary =
    clauses.primaryKey.length === clauses.orderBy.length &&
    clauses.primaryKey.every((k, i) => k === clauses.orderBy[i]);

  return {
    name,
    engine: clauses.engine,
    orderBy: clauses.orderBy,
    partitionBy: clauses.partitionBy,
    primaryKey: clauses.primaryKey.length === 0 || samePrimary ? null : clauses.primaryKey,
    sampleBy: clauses.sampleBy,
    ttl: clauses.ttl,
    settings: clauses.settings,
    comment: clauses.comment,
    columns,
    indexes,
  };
};

const splitStatements = (sql: string): ReadonlyArray<string> => {
  const starts: Array<number> = [];
  let depth = 0;
  let quote: "'" | "`" | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote !== null) {
      if (c === "\\" && quote === "'") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && (c === "C" || c === "c")) {
      const isBoundary = i === 0 || /[\s;]/.test(sql[i - 1]);
      if (isBoundary && CREATE_TABLE_HEAD.test(sql.slice(i))) starts.push(i);
    }
  }
  if (starts.length === 0) return sql.trim().length > 0 ? [sql] : [];
  return starts.map((start, k) =>
    sql.slice(start, k + 1 < starts.length ? starts[k + 1] : sql.length).trim(),
  );
};

export interface ParseDdlOptions {
  /** Include ClickHouse-internal tables (materialized-view `.inner*` storage). Default `false`. */
  readonly includeInternal?: boolean;
}

/** Parse one or more `CREATE TABLE` statements into the introspection model. */
export const parseCreateTables = (
  sql: string,
  options: ParseDdlOptions = {},
): ReadonlyArray<IntrospectedTable> =>
  splitStatements(sql)
    .map(parseCreateTable)
    .filter((t): t is IntrospectedTable => t !== null)
    .filter((t) => options.includeInternal === true || !t.name.startsWith(".inner"));
