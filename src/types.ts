/**
 * The core type system: a {@link ChType} pairs a ClickHouse column type string with
 * an Effect {@link Schema.Schema} that knows how to **decode** the JSON wire value into
 * a TypeScript value and **encode** a TypeScript value back into a JSON-safe wire value.
 *
 * The wire format is made deterministic by the settings the client pins on every request
 * (see `./client.ts`):
 *   - reads:  `output_format_json_quote_64bit_integers=1`, `output_format_json_quote_decimals=1`,
 *             `output_format_json_named_tuples_as_objects=1`, `date_time_output_format='unix_timestamp'`
 *   - writes: `date_time_input_format='best_effort'`, `input_format_json_named_tuples_as_objects=1`
 *
 * Because of that, a single `Schema<A, I>` per column suffices for both directions:
 *   decode = `Schema.decodeUnknown(schema)`  (wire `I` → TS `A`)
 *   encode = `Schema.encode(schema)`         (TS `A` → wire `I`, JSON-safe)
 */
import { ParseResult, Schema } from "effect";

/**
 * A ClickHouse column type, carrying its CH type string and the codec.
 * `A` is the decoded TypeScript type; `I` is the JSON wire representation.
 */
export interface ChType<A = unknown, I = unknown> {
  readonly typeName: string;
  readonly schema: Schema.Schema<A, I>;
}

/** Any column type — used only as a generic bound. */
// `any` here is a bound, never a value; concrete `A`/`I` are always recovered via inference.
// oxlint-disable-next-line no-explicit-any
export type AnyChType = ChType<any, any>;

/**
 * A column type whose encoded (wire) form is irrelevant — used where only the decoded type `A`
 * matters (e.g. expression result types). `ChType` is invariant in its encoded slot, so a
 * concrete `ChType<A, I>` only assigns to this widened form.
 */
// oxlint-disable-next-line no-explicit-any
export type DecodeChType<A> = ChType<A, any>;

/** Extract the decoded (select) TypeScript type from a {@link ChType}. */
export type SelectOf<C> = C extends ChType<infer A, infer _I> ? A : never;
/** Extract the encoded (wire / insert) type from a {@link ChType}. */
export type EncodedOf<C> = C extends ChType<infer _A, infer I> ? I : never;

type SelectFields<F extends Record<string, AnyChType>> = {
  readonly [K in keyof F]: SelectOf<F[K]>;
};
type EncodedFields<F extends Record<string, AnyChType>> = {
  readonly [K in keyof F]: EncodedOf<F[K]>;
};
type SelectElements<E extends ReadonlyArray<AnyChType>> = {
  readonly [K in keyof E]: SelectOf<E[K]>;
};
type EncodedElements<E extends ReadonlyArray<AnyChType>> = {
  readonly [K in keyof E]: EncodedOf<E[K]>;
};

const make = <A, I>(typeName: string, schema: Schema.Schema<A, I>): ChType<A, I> => ({
  typeName,
  schema,
});

// ---------------------------------------------------------------------------
// Internal reusable schemas
// ---------------------------------------------------------------------------

/** `"12345"` ⇄ `12345n`. ClickHouse sends 64/128/256-bit ints as quoted strings. */
const BigIntFromString: Schema.Schema<bigint, string> = Schema.transformOrFail(
  Schema.String,
  Schema.BigIntFromSelf,
  {
    strict: true,
    decode: (s, _options, ast) => {
      try {
        return ParseResult.succeed(BigInt(s));
      } catch {
        return ParseResult.fail(new ParseResult.Type(ast, s, `Cannot parse a bigint from "${s}"`));
      }
    },
    encode: (b) => ParseResult.succeed(b.toString()),
  },
);

/**
 * Decimal preserved as a string to avoid float precision loss. Accepts a number too
 * (in case `output_format_json_quote_decimals` is disabled) and always encodes to string.
 */
const DecimalAsString: Schema.Schema<string, string | number> = Schema.transform(
  Schema.Union(Schema.String, Schema.Number),
  Schema.String,
  {
    strict: true,
    decode: (x) => (typeof x === "string" ? x : String(x)),
    encode: (s) => s,
  },
);

/** `"2024-01-15"` ⇄ `Date` (UTC midnight). */
const DateOnly: Schema.Schema<Date, string> = Schema.transformOrFail(
  Schema.String,
  Schema.DateFromSelf,
  {
    strict: true,
    decode: (s, _options, ast) => {
      const date = new Date(`${s}T00:00:00Z`);
      return Number.isNaN(date.getTime())
        ? ParseResult.fail(new ParseResult.Type(ast, s, `Invalid Date: "${s}"`))
        : ParseResult.succeed(date);
    },
    encode: (d) => ParseResult.succeed(d.toISOString().slice(0, 10)),
  },
);

/**
 * `DateTime` / `DateTime64` ⇄ `Date`.
 *
 * The client pins `date_time_output_format='unix_timestamp'`, so the wire value is a
 * (possibly fractional) number of seconds — unambiguous and timezone-independent. The
 * decoder also tolerates ISO-8601 and `'YYYY-MM-DD HH:MM:SS'` strings (interpreted as UTC)
 * for raw queries that don't pin the setting. Encoding emits unix seconds, which ClickHouse
 * accepts for any timezone.
 */
const parseDateTimeString = (s: string): Date => {
  const withT = s.includes("T") ? s : s.replace(" ", "T");
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(withT);
  return new Date(hasZone ? withT : `${withT}Z`);
};

const DateTimeSchema: Schema.Schema<Date, number | string> = Schema.transformOrFail(
  Schema.Union(Schema.Number, Schema.String),
  Schema.DateFromSelf,
  {
    strict: true,
    decode: (value, _options, ast) => {
      const date = typeof value === "number" ? new Date(value * 1000) : parseDateTimeString(value);
      return Number.isNaN(date.getTime())
        ? ParseResult.fail(new ParseResult.Type(ast, value, `Invalid DateTime: ${String(value)}`))
        : ParseResult.succeed(date);
    },
    encode: (d) => ParseResult.succeed(d.getTime() / 1000),
  },
);

// ---------------------------------------------------------------------------
// Scalar builders
// ---------------------------------------------------------------------------

const numberType = (name: string): ChType<number, number> => make(name, Schema.Number);
const bigintType = (name: string): ChType<bigint, string> => make(name, BigIntFromString);

export const int8 = (): ChType<number, number> => numberType("Int8");
export const int16 = (): ChType<number, number> => numberType("Int16");
export const int32 = (): ChType<number, number> => numberType("Int32");
export const int64 = (): ChType<bigint, string> => bigintType("Int64");
export const int128 = (): ChType<bigint, string> => bigintType("Int128");
export const int256 = (): ChType<bigint, string> => bigintType("Int256");

export const uint8 = (): ChType<number, number> => numberType("UInt8");
export const uint16 = (): ChType<number, number> => numberType("UInt16");
export const uint32 = (): ChType<number, number> => numberType("UInt32");
export const uint64 = (): ChType<bigint, string> => bigintType("UInt64");
export const uint128 = (): ChType<bigint, string> => bigintType("UInt128");
export const uint256 = (): ChType<bigint, string> => bigintType("UInt256");

export const float32 = (): ChType<number, number> => numberType("Float32");
export const float64 = (): ChType<number, number> => numberType("Float64");

export const decimal = (precision: number, scale: number): ChType<string, string | number> =>
  make(`Decimal(${precision}, ${scale})`, DecimalAsString);

export const bool = (): ChType<boolean, boolean> => make("Bool", Schema.Boolean);

export const string = (): ChType<string, string> => make("String", Schema.String);
export const fixedString = (length: number): ChType<string, string> =>
  make(`FixedString(${length})`, Schema.String);

export const uuid = (): ChType<string, string> => make("UUID", Schema.String);
export const ipv4 = (): ChType<string, string> => make("IPv4", Schema.String);
export const ipv6 = (): ChType<string, string> => make("IPv6", Schema.String);

export const date = (): ChType<Date, string> => make("Date", DateOnly);
export const date32 = (): ChType<Date, string> => make("Date32", DateOnly);

export const dateTime = (timezone?: string): ChType<Date, number | string> =>
  make(timezone === undefined ? "DateTime" : `DateTime('${timezone}')`, DateTimeSchema);

export const dateTime64 = (precision: number, timezone?: string): ChType<Date, number | string> =>
  make(
    timezone === undefined ? `DateTime64(${precision})` : `DateTime64(${precision}, '${timezone}')`,
    DateTimeSchema,
  );

const renderEnumMembers = (members: Record<string, number>): string =>
  Object.entries(members)
    .map(([name, value]) => `'${name.replace(/'/g, "\\'")}' = ${value}`)
    .join(", ");

const enumType = <const T extends Record<string, number>>(
  size: 8 | 16,
  members: T,
): ChType<keyof T & string, string> => {
  // `Schema.Literal`'s rest param requires a non-empty tuple type; the runtime array is
  // cast to satisfy it. We then annotate the precise union statically, since a spread of a
  // runtime array would otherwise widen `Literal` to `string`.
  const names = Object.keys(members) as [string, ...Array<string>];
  const schema = Schema.Literal(...names) as unknown as Schema.Schema<keyof T & string, string>;
  return make(`Enum${size}(${renderEnumMembers(members)})`, schema);
};

export const enum8 = <const T extends Record<string, number>>(
  members: T,
): ChType<keyof T & string, string> => enumType(8, members);
export const enum16 = <const T extends Record<string, number>>(
  members: T,
): ChType<keyof T & string, string> => enumType(16, members);

// ---------------------------------------------------------------------------
// Composite builders
// ---------------------------------------------------------------------------

export const nullable = <A, I>(inner: ChType<A, I>): ChType<A | null, I | null> =>
  make(`Nullable(${inner.typeName})`, Schema.NullOr(inner.schema));

/** Transparent for codecs; only changes the CH type string. */
export const lowCardinality = <A, I>(inner: ChType<A, I>): ChType<A, I> =>
  make(`LowCardinality(${inner.typeName})`, inner.schema);

export const array = <A, I>(inner: ChType<A, I>): ChType<ReadonlyArray<A>, ReadonlyArray<I>> =>
  make(`Array(${inner.typeName})`, Schema.Array(inner.schema));

/** ClickHouse `Map(K, V)` serializes as a JSON object, so keys are represented as strings. */
export const map = <VA, VI>(
  key: AnyChType,
  value: ChType<VA, VI>,
): ChType<{ readonly [k: string]: VA }, { readonly [k: string]: VI }> =>
  make(
    `Map(${key.typeName}, ${value.typeName})`,
    Schema.Record({ key: Schema.String, value: value.schema }),
  );

const structSchemaFields = (
  fields: Record<string, AnyChType>,
): Record<string, Schema.Schema.Any> => {
  const out: Record<string, Schema.Schema.Any> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v.schema;
  return out;
};

/** Unnamed tuple → positional array, e.g. `Tuple(UInt8, String)` → `readonly [number, string]`. */
export const tuple = <const E extends ReadonlyArray<AnyChType>>(
  ...elements: E
): ChType<SelectElements<E>, EncodedElements<E>> => {
  const typeName = `Tuple(${elements.map((e) => e.typeName).join(", ")})`;
  const schema = Schema.Tuple(...elements.map((e) => e.schema)) as unknown as Schema.Schema<
    SelectElements<E>,
    EncodedElements<E>
  >;
  return make(typeName, schema);
};

/** Named tuple → object, e.g. `Tuple(a UInt8, b String)` → `{ a: number; b: string }`. */
export const namedTuple = <const F extends Record<string, AnyChType>>(
  fields: F,
): ChType<SelectFields<F>, EncodedFields<F>> => {
  const typeName = `Tuple(${Object.entries(fields)
    .map(([name, t]) => `${name} ${t.typeName}`)
    .join(", ")})`;
  const schema = Schema.Struct(structSchemaFields(fields)) as unknown as Schema.Schema<
    SelectFields<F>,
    EncodedFields<F>
  >;
  return make(typeName, schema);
};

/** `Nested(...)` → an array of structs. */
export const nested = <const F extends Record<string, AnyChType>>(
  fields: F,
): ChType<ReadonlyArray<SelectFields<F>>, ReadonlyArray<EncodedFields<F>>> => {
  const typeName = `Nested(${Object.entries(fields)
    .map(([name, t]) => `${name} ${t.typeName}`)
    .join(", ")})`;
  const schema = Schema.Array(
    Schema.Struct(structSchemaFields(fields)),
  ) as unknown as Schema.Schema<ReadonlyArray<SelectFields<F>>, ReadonlyArray<EncodedFields<F>>>;
  return make(typeName, schema);
};

/** ClickHouse `JSON` column. Provide a schema for typed access, else `unknown`. */
export function json(): ChType<unknown, unknown>;
export function json<A, I>(schema: Schema.Schema<A, I>): ChType<A, I>;
export function json<A, I>(schema?: Schema.Schema<A, I>): ChType<A, I> | ChType<unknown, unknown> {
  return schema === undefined ? make("JSON", Schema.Unknown) : make("JSON", schema);
}

/** Opaque passthrough for `Dynamic`, `Variant`, aggregate states, and other exotic types. */
export const dynamic = (typeName = "Dynamic"): ChType<unknown, unknown> =>
  make(typeName, Schema.Unknown);

/** Escape hatch: define a column from an arbitrary CH type string and a custom schema. */
export const custom = <A, I>(typeName: string, schema: Schema.Schema<A, I>): ChType<A, I> =>
  make(typeName, schema);
