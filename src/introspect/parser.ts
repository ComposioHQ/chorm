/**
 * A recursive-descent parser for ClickHouse column type strings, as they appear
 * in `system.columns.type` / `SHOW CREATE TABLE`.
 *
 * It produces a {@link ParsedType} AST that the type-system mapper and the codegen
 * use to drive everything else. We roll our own (rather than reuse
 * `@clickhouse/client-common`'s `parseColumnType`, which is flagged experimental and
 * does not support `Nested`, `JSON`, `Variant`, `Dynamic` or `AggregateFunction`).
 *
 * The grammar, informally:
 *
 *   type        := name | name '(' args ')'
 *   args        := arg (',' arg)*            // top-level commas, parens/quotes aware
 *   enum-member := string '=' integer
 *   tuple-elem  := type | identifier type     // named tuple element
 *
 * Everything is parsed purely from strings — no database access.
 */

/** Scalar ClickHouse types that carry no parameters. */
export const SIMPLE_TYPE_NAMES = [
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "UInt128",
  "UInt256",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Int128",
  "Int256",
  "Float32",
  "Float64",
  "BFloat16",
  "String",
  "UUID",
  "Date",
  "Date32",
  "Time",
  "IPv4",
  "IPv6",
  "Bool",
  "Nothing",
] as const;

export type SimpleTypeName = (typeof SIMPLE_TYPE_NAMES)[number];

const SIMPLE_TYPE_SET: ReadonlySet<string> = new Set(SIMPLE_TYPE_NAMES);

export type ParsedType =
  | { readonly kind: "Simple"; readonly name: SimpleTypeName }
  | { readonly kind: "FixedString"; readonly length: number }
  | { readonly kind: "DateTime"; readonly timezone: string | null }
  | {
      readonly kind: "DateTime64";
      readonly precision: number;
      readonly timezone: string | null;
    }
  | { readonly kind: "Decimal"; readonly precision: number; readonly scale: number }
  | {
      readonly kind: "Enum";
      readonly size: 8 | 16;
      readonly members: ReadonlyArray<{ readonly name: string; readonly value: number }>;
    }
  | { readonly kind: "Nullable"; readonly inner: ParsedType }
  | { readonly kind: "LowCardinality"; readonly inner: ParsedType }
  | { readonly kind: "Array"; readonly inner: ParsedType }
  | { readonly kind: "Map"; readonly key: ParsedType; readonly value: ParsedType }
  | {
      readonly kind: "Tuple";
      readonly elements: ReadonlyArray<{ readonly name: string | null; readonly type: ParsedType }>;
    }
  | {
      readonly kind: "Nested";
      readonly columns: ReadonlyArray<{ readonly name: string; readonly type: ParsedType }>;
    }
  | { readonly kind: "Json" }
  | {
      readonly kind: "AggregateFunction";
      readonly func: string;
      readonly args: ReadonlyArray<ParsedType>;
    }
  | { readonly kind: "SimpleAggregateFunction"; readonly func: string; readonly inner: ParsedType }
  | { readonly kind: "Variant"; readonly variants: ReadonlyArray<ParsedType> }
  | { readonly kind: "Dynamic" }
  | { readonly kind: "Unknown"; readonly source: string };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split a comma-separated argument list, respecting nested parentheses and
 * quoted strings (single quotes with backslash escapes, and backtick-quoted
 * identifiers). Used for `Map`, `Tuple`, `Enum`, `DateTime64`, etc.
 */
export const splitTopLevel = (input: string): ReadonlyArray<string> => {
  const out: string[] = [];
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
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += c;
    i += 1;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
};

const unescapeSingleQuoted = (raw: string): string =>
  raw.replace(/\\(.)/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch));

/** Read a leading single-quoted string literal, returning its content and the remainder. */
const readQuotedPrefix = (input: string): { readonly value: string; readonly rest: string } => {
  const s = input.trimStart();
  if (s[0] !== "'") throw new Error(`Expected quoted string, got: ${input}`);
  let i = 1;
  let value = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      value += s[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === "'") {
      return { value: unescapeSingleQuoted(value), rest: s.slice(i + 1) };
    }
    value += c;
    i += 1;
  }
  throw new Error(`Unterminated string literal: ${input}`);
};

/** Parse a fully single-quoted token like `'UTC'` into its content, or `null` if empty. */
const parseTimezone = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return readQuotedPrefix(trimmed).value;
};

const parseEnumMembers = (
  inner: string,
): ReadonlyArray<{ readonly name: string; readonly value: number }> =>
  splitTopLevel(inner).map((part) => {
    const { value: name, rest } = readQuotedPrefix(part.trim());
    const eq = rest.indexOf("=");
    if (eq === -1) throw new Error(`Malformed enum member (no '='): ${part}`);
    const value = Number.parseInt(rest.slice(eq + 1).trim(), 10);
    if (Number.isNaN(value)) throw new Error(`Malformed enum value: ${part}`);
    return { name, value };
  });

const parseNamedElement = (
  raw: string,
): { readonly name: string | null; readonly type: ParsedType } => {
  const s = raw.trim();
  if (s.startsWith("`")) {
    const end = s.indexOf("`", 1);
    if (end !== -1) {
      const name = s.slice(1, end);
      const rest = s.slice(end + 1).trim();
      return { name, type: parseType(rest) };
    }
  }
  const space = s.indexOf(" ");
  if (space === -1) return { name: null, type: parseType(s) };
  const head = s.slice(0, space);
  const rest = s.slice(space + 1).trim();
  if (IDENTIFIER.test(head) && rest.length > 0) {
    return { name: head, type: parseType(rest) };
  }
  return { name: null, type: parseType(s) };
};

const GEO_TYPES: Record<string, () => ParsedType> = {
  Point: () => ({
    kind: "Tuple",
    elements: [
      { name: null, type: { kind: "Simple", name: "Float64" } },
      { name: null, type: { kind: "Simple", name: "Float64" } },
    ],
  }),
  Ring: () => ({ kind: "Array", inner: GEO_TYPES.Point() }),
  LineString: () => ({ kind: "Array", inner: GEO_TYPES.Point() }),
  Polygon: () => ({ kind: "Array", inner: GEO_TYPES.Ring() }),
  MultiLineString: () => ({ kind: "Array", inner: GEO_TYPES.LineString() }),
  MultiPolygon: () => ({ kind: "Array", inner: GEO_TYPES.Polygon() }),
};

const parseLeaf = (name: string): ParsedType => {
  if (name === "DateTime") return { kind: "DateTime", timezone: null };
  if (name === "JSON") return { kind: "Json" };
  if (name === "Dynamic") return { kind: "Dynamic" };
  if (name === "Boolean") return { kind: "Simple", name: "Bool" };
  if (SIMPLE_TYPE_SET.has(name)) return { kind: "Simple", name: name as SimpleTypeName };
  const geo = GEO_TYPES[name];
  if (geo !== undefined) return geo();
  return { kind: "Unknown", source: name };
};

/** Parse a ClickHouse column type string into a {@link ParsedType} AST. */
export const parseType = (input: string): ParsedType => {
  const source = input.trim();
  const open = source.indexOf("(");
  if (open === -1) return parseLeaf(source);
  if (!source.endsWith(")")) return { kind: "Unknown", source };

  const name = source.slice(0, open).trim();
  const inner = source.slice(open + 1, source.length - 1);
  const int = (s: string): number => Number.parseInt(s.trim(), 10);

  switch (name) {
    case "Nullable":
      return { kind: "Nullable", inner: parseType(inner) };
    case "LowCardinality":
      return { kind: "LowCardinality", inner: parseType(inner) };
    case "Array":
      return { kind: "Array", inner: parseType(inner) };
    case "Map": {
      const [key, value] = splitTopLevel(inner);
      return { kind: "Map", key: parseType(key), value: parseType(value) };
    }
    case "Tuple":
      return { kind: "Tuple", elements: splitTopLevel(inner).map(parseNamedElement) };
    case "Nested":
      return {
        kind: "Nested",
        columns: splitTopLevel(inner).map((c) => {
          const { name: columnName, type } = parseNamedElement(c);
          if (columnName === null) throw new Error(`Nested column requires a name: ${c}`);
          return { name: columnName, type };
        }),
      };
    case "FixedString":
      return { kind: "FixedString", length: int(inner) };
    case "DateTime":
      return { kind: "DateTime", timezone: parseTimezone(inner) };
    case "DateTime64": {
      const parts = splitTopLevel(inner);
      return { kind: "DateTime64", precision: int(parts[0]), timezone: parseTimezone(parts[1]) };
    }
    case "Decimal": {
      const [precision, scale] = splitTopLevel(inner);
      return { kind: "Decimal", precision: int(precision), scale: int(scale) };
    }
    case "Decimal32":
      return { kind: "Decimal", precision: 9, scale: int(inner) };
    case "Decimal64":
      return { kind: "Decimal", precision: 18, scale: int(inner) };
    case "Decimal128":
      return { kind: "Decimal", precision: 38, scale: int(inner) };
    case "Decimal256":
      return { kind: "Decimal", precision: 76, scale: int(inner) };
    case "Enum":
    case "Enum8":
      return { kind: "Enum", size: 8, members: parseEnumMembers(inner) };
    case "Enum16":
      return { kind: "Enum", size: 16, members: parseEnumMembers(inner) };
    case "AggregateFunction": {
      const [func, ...rest] = splitTopLevel(inner);
      return { kind: "AggregateFunction", func: func.trim(), args: rest.map(parseType) };
    }
    case "SimpleAggregateFunction": {
      const parts = splitTopLevel(inner);
      const func = parts[0].trim();
      return { kind: "SimpleAggregateFunction", func, inner: parseType(parts[parts.length - 1]) };
    }
    case "Variant":
      return { kind: "Variant", variants: splitTopLevel(inner).map(parseType) };
    case "JSON":
    case "Object":
      return { kind: "Json" };
    case "Dynamic":
      return { kind: "Dynamic" };
    default:
      return { kind: "Unknown", source };
  }
};

/** Strip `Nullable(...)` and `LowCardinality(...)` wrappers, reporting which were present. */
export const unwrapType = (
  parsed: ParsedType,
): { readonly base: ParsedType; readonly nullable: boolean; readonly lowCardinality: boolean } => {
  let nullable = false;
  let lowCardinality = false;
  let base = parsed;
  // Wrappers may appear in either order: LowCardinality(Nullable(T)) or Nullable(LowCardinality(T)).
  let changed = true;
  while (changed) {
    changed = false;
    if (base.kind === "Nullable") {
      nullable = true;
      base = base.inner;
      changed = true;
    } else if (base.kind === "LowCardinality") {
      lowCardinality = true;
      base = base.inner;
      changed = true;
    }
  }
  return { base, nullable, lowCardinality };
};

/** Reconstruct a canonical ClickHouse type string from a {@link ParsedType}. */
export const renderType = (parsed: ParsedType): string => {
  switch (parsed.kind) {
    case "Simple":
      return parsed.name;
    case "FixedString":
      return `FixedString(${parsed.length})`;
    case "DateTime":
      return parsed.timezone === null ? "DateTime" : `DateTime('${parsed.timezone}')`;
    case "DateTime64":
      return parsed.timezone === null
        ? `DateTime64(${parsed.precision})`
        : `DateTime64(${parsed.precision}, '${parsed.timezone}')`;
    case "Decimal":
      return `Decimal(${parsed.precision}, ${parsed.scale})`;
    case "Enum": {
      const members = parsed.members
        .map((m) => `'${m.name.replace(/'/g, "\\'")}' = ${m.value}`)
        .join(", ");
      return `Enum${parsed.size}(${members})`;
    }
    case "Nullable":
      return `Nullable(${renderType(parsed.inner)})`;
    case "LowCardinality":
      return `LowCardinality(${renderType(parsed.inner)})`;
    case "Array":
      return `Array(${renderType(parsed.inner)})`;
    case "Map":
      return `Map(${renderType(parsed.key)}, ${renderType(parsed.value)})`;
    case "Tuple":
      return `Tuple(${parsed.elements
        .map((e) => (e.name === null ? renderType(e.type) : `${e.name} ${renderType(e.type)}`))
        .join(", ")})`;
    case "Nested":
      return `Nested(${parsed.columns.map((c) => `${c.name} ${renderType(c.type)}`).join(", ")})`;
    case "Json":
      return "JSON";
    case "AggregateFunction":
      return `AggregateFunction(${[parsed.func, ...parsed.args.map(renderType)].join(", ")})`;
    case "SimpleAggregateFunction":
      return `SimpleAggregateFunction(${parsed.func}, ${renderType(parsed.inner)})`;
    case "Variant":
      return `Variant(${parsed.variants.map(renderType).join(", ")})`;
    case "Dynamic":
      return "Dynamic";
    case "Unknown":
      return parsed.source;
  }
};
