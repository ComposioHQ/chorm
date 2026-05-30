# chorm

A **typesafe, [Effect](https://effect.website)-native ClickHouse ORM** with schema introspection and code generation.

- 🧱 **Schema as code** — describe tables with a small, composable type DSL (`ch.uint64()`, `ch.array(ch.string())`, `ch.map(...)`, …), plus typed **engines**, **`ORDER BY`/`PARTITION BY`**, **data-skipping indices** (bloom filters), `TTL`, and `SETTINGS`.
- 🧬 **Inferred row & insert types** — `InferRow<T>` / `InferInsert<T>` are derived from the schema; `DEFAULT` columns become optional, `MATERIALIZED`/`ALIAS` columns are excluded from inserts.
- 🔭 **Introspect & generate** — `chorm generate` reads a live database, _or_ parses `CREATE TABLE` DDL **offline** (`--from-ddl`, no connection needed), and writes a ready-to-use TypeScript schema module.
- ⚙️ **Typed engines** — `replacingMergeTree("ver")`, `sharedReplacingMergeTree({ version })`, … carry structured semantics (version column, whether queries need `FINAL`) instead of an opaque string.
- 🧮 **Typesafe query builder** — `from(t).select({...}).where(eq(...)).groupBy(...)` with parameterized SQL and ClickHouse-specific bits (`FINAL`, aggregates, `IN`).
- 🧩 **Effect everywhere** — the client is a `Context.Tag` service provided by a scoped `Layer`; queries return `Effect`s with typed errors and `Schema`-based decoding.
- 🎯 **Deterministic codecs** — every request pins ClickHouse's JSON I/O settings, so `UInt64` ⇄ `bigint`, `Decimal` (lossless `string`), and `DateTime` ⇄ `Date` round-trip unambiguously.

Built on the official [`@clickhouse/client`](https://github.com/ClickHouse/clickhouse-js) and [`effect`](https://effect.website).

---

## Install

```bash
vp add chorm        # or: pnpm add chorm
```

`effect` and `@clickhouse/client` are runtime dependencies.

---

## Quick start

### 1. Describe your schema

```ts
import { ch, col, mergeTree, table } from "chorm";

export const users = table(
  "users",
  {
    id: ch.uint64(),
    email: ch.string(),
    status: ch.enum8({ active: 1, suspended: 2, deleted: 3 }),
    created_at: col(ch.dateTime(), { default: "now()" }), // optional on insert
  },
  { engine: "ReplacingMergeTree(created_at)", orderBy: ["id"] },
);

export const events = table(
  "events",
  {
    id: ch.uuid(),
    user_id: ch.uint64(),
    name: ch.lowCardinality(ch.string()),
    properties: ch.map(ch.string(), ch.string()),
    amount: ch.nullable(ch.decimal(18, 4)),
    tags: ch.array(ch.string()),
    created_at: ch.dateTime("UTC"),
    day: col(ch.date(), { materialized: "toDate(created_at)" }), // excluded from inserts
  },
  {
    engine: mergeTree(), // or sharedReplacingMergeTree({ version: "version" }), etc.
    orderBy: ["created_at", "id"], // ← column names autocomplete
    partitionBy: "toYYYYMM(created_at)",
    indexes: [
      // `expression` autocompletes columns; `type` autocompletes bloom_filter/minmax/set/…
      { name: "idx_user", expression: "user_id", type: "bloom_filter(0.01)", granularity: 4 },
    ],
  },
);
```

The row and insert shapes are inferred:

```ts
import type { InferRow, InferInsert } from "chorm";

type EventRow = InferRow<typeof events>;
// { id: string; user_id: bigint; name: string; properties: Record<string, string>;
//   amount: string | null; tags: readonly string[]; created_at: Date; day: Date }

type NewUser = InferInsert<typeof users>;
// { id: bigint; email: string; status: "active" | "suspended" | "deleted"; created_at?: Date }
```

### 2. Provide a client

```ts
import { layer, layerFromEnv } from "chorm";

const ClickhouseLive = layer({
  url: "http://localhost:8123",
  username: "default",
  password: "",
  database: "analytics",
});

// …or from CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DATABASE:
const ClickhouseEnv = layerFromEnv();
```

### 3. Query and insert

```ts
import { Effect } from "effect";
import { count, createTable, desc, from, gt, insert, sum } from "chorm";
import { events, users } from "./schema";

const topEvents = from(events)
  .select({ name: events.name, total: count(), revenue: sum(events.amount) })
  .where(gt(events.created_at, new Date("2024-01-01T00:00:00Z")))
  .groupBy(events.name)
  .orderBy(desc(count()))
  .limit(10);

const program = Effect.gen(function* () {
  yield* createTable(users, { ifNotExists: true });
  yield* insert(users, [{ id: 1n, email: "ada@example.com", status: "active" }]);
  return yield* topEvents.execute(); // Effect<ReadonlyArray<{ name: string; total: bigint; revenue: string | null }>, …>
});

Effect.runPromise(Effect.provide(program, ClickhouseLive));
```

`topEvents.toSql()` returns `{ sql, params }` if you want to inspect or run the query yourself:

```sql
SELECT `events`.`name` AS `name`, count() AS `total`, sum(`events`.`amount`) AS `revenue`
FROM `events`
WHERE ((`events`.`created_at` > {p0:DateTime('UTC')}))
GROUP BY `events`.`name`
ORDER BY count() DESC
LIMIT 10
```

Literal values are bound as ClickHouse server-side parameters (`{pN:Type}`) — never string-interpolated.

---

## Generate a schema

**From a live database:**

```bash
chorm generate --database analytics --out src/schema.ts
```

**Offline, from `CREATE TABLE` DDL** (no connection — paste/export `SHOW CREATE TABLE`):

```bash
clickhouse-client -q "SELECT create_table_query FROM system.tables \
  WHERE database='analytics' AND engine NOT LIKE '%View' FORMAT TSVRaw" > schema.sql
chorm generate --from-ddl schema.sql --out src/schema.ts
```

Either way it parses each column's ClickHouse type and emits the equivalent `table(...)` definitions, including engine (as a typed builder), `ORDER BY`, `PARTITION BY`, data-skipping indices, codecs, `TTL`, `SETTINGS`, defaults, and comments. Materialized-view inner tables (`.inner*`) are skipped.

| Flag                  | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| `-d, --database <db>` | Database to introspect (live mode)                          |
| `--from-ddl <file>`   | Generate from a file of `CREATE TABLE` statements (offline) |
| `-o, --out <file>`    | Output file (default: stdout)                               |
| `--tables <a,b,c>`    | Restrict to specific tables                                 |
| `--import <pkg>`      | Import specifier used in generated code (default `"chorm"`) |
| `--url` / `-u` / `-p` | Connection overrides (else `CLICKHOUSE_*` env)              |

---

## Engines & deduplication (`FINAL`)

Engines are typed builders, so chorm knows each table's version column and whether reads need `FINAL`:

```ts
import { mergeTree, replacingMergeTree, sharedReplacingMergeTree } from "chorm";

engine: mergeTree();
engine: replacingMergeTree("version");
engine: sharedReplacingMergeTree({ version: "version" }); // ClickHouse Cloud
```

`ReplacingMergeTree`/`Collapsing*`/`Summing*`/`Aggregating*` tables keep multiple row versions until a background merge runs, so a plain `SELECT` can return duplicate or stale rows. Use `.final()` to collapse to the latest version (and filter your soft-delete column, if any):

```ts
from(users)
  .final() // ← dedupe to the latest version
  .where(eq(users.is_deleted, 0)) // ← drop soft-deleted rows, if your CDC uses them
  .execute();

// chorm exposes the structured semantics:
tableNeedsFinal(users); // true for ReplacingMergeTree, false for MergeTree
tableVersionColumn(users); // e.g. "version"
```

---

## Type mapping

| ClickHouse                                      | TypeScript (`InferRow`)          | Notes                                       |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------- |
| `Int8…Int32`, `UInt8…UInt32`, `Float32/64`      | `number`                         |                                             |
| `Int64/128/256`, `UInt64/128/256`               | `bigint`                         | sent as quoted strings on the wire          |
| `Decimal(P,S)`                                  | `string`                         | preserved losslessly                        |
| `Bool`                                          | `boolean`                        |                                             |
| `String`, `FixedString`, `UUID`, `IPv4`, `IPv6` | `string`                         |                                             |
| `Date`, `Date32`, `DateTime`, `DateTime64`      | `Date`                           | timezone-safe (unix timestamps on the wire) |
| `Enum8/16(...)`                                 | string-literal union             | e.g. `"active" \| "inactive"`               |
| `Array(T)`                                      | `readonly T[]`                   |                                             |
| `Map(K,V)`                                      | `Record<string, V>`              |                                             |
| `Tuple(a T, …)`                                 | `{ a: T; … }`                    | named → object                              |
| `Tuple(T, …)`                                   | `readonly [T, …]`                | unnamed → array                             |
| `Nullable(T)`                                   | `T \| null`                      |                                             |
| `LowCardinality(T)`                             | same as `T`                      |                                             |
| `Nested(...)`                                   | `readonly { … }[]`               |                                             |
| `JSON`                                          | `unknown` (or a custom `Schema`) | `ch.json(schema?)`                          |
| `Variant`/`Dynamic`/`AggregateFunction`         | `unknown`                        | `ch.dynamic(...)`, type string preserved    |

Why the round-trips are exact: ClickHouse's defaults make `UInt64`/`Decimal` lossy in JSON and `DateTime` timezone-ambiguous. chorm pins `output_format_json_quote_64bit_integers`, `output_format_json_quote_decimals`, `output_format_json_named_tuples_as_objects`, and `date_time_output_format='unix_timestamp'` on reads (and `date_time_input_format='best_effort'` on writes), so the wire format is deterministic.

---

## Effect integration

- **Service:** `ClickhouseClient` is a `Context.Tag`. Provide it with `layer(config)` (a scoped `Layer` that opens the connection and closes it with the scope) or `layerFromEnv()`.
- **Errors:** queries fail with typed `ClickhouseError`; decoding failures surface as `RowDecodeError`, inserts as `RowEncodeError` (all `Data.TaggedError`).
- **Decoding:** each column carries an Effect `Schema`; a projection's row type _is_ its decoder, so results are validated, not just cast.
- **Lower-level access:** the service exposes `queryRaw`, `query`, `insert`, `command`, `ping`, and the underlying `raw` client.

```ts
import { ClickhouseClient } from "chorm";

const ping = Effect.gen(function* () {
  const ch = yield* ClickhouseClient;
  return yield* ch.ping();
});
```

---

## Development

```bash
vp install      # install dependencies
vp check        # format, lint, type-check
vp test         # run the test suite
vp pack         # build the library + CLI
vp node examples/queries.ts   # run an example (needs CLICKHOUSE_URL to actually connect)
```

## License

MIT
