/**
 * Example queries built on the schema in `./schema.ts`. Everything is an `Effect`; provide a
 * {@link ClickhouseClient} layer (e.g. `layerFromEnv()`) to run it.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 vp node examples/queries.ts
 */
import { Effect } from "effect";
import {
  count,
  createTable,
  desc,
  from,
  gt,
  type InferInsert,
  insert,
  layerFromEnv,
  sum,
} from "../src/index.ts";
import { events, users } from "./schema.ts";

/** A typed aggregate query: top event names by volume, with revenue. */
export const topEvents = from(events)
  .select({
    name: events.name,
    total: count(),
    revenue: sum(events.amount),
  })
  .where(gt(events.created_at, new Date("2024-01-01T00:00:00Z")))
  .groupBy(events.name)
  .orderBy(desc(count()))
  .limit(10);

// `InferInsert` makes `created_at` (DEFAULT) optional and omits `day` (MATERIALIZED).
const newUsers: ReadonlyArray<InferInsert<typeof users>> = [
  { id: 1n, email: "ada@example.com", status: "active" },
  { id: 2n, email: "alan@example.com", status: "suspended", created_at: new Date() },
];

/** Create the tables, insert some users, then read the aggregate. */
export const program = Effect.gen(function* () {
  yield* createTable(users, { ifNotExists: true });
  yield* createTable(events, { ifNotExists: true });
  yield* insert(users, newUsers);
  return yield* topEvents.execute();
});

/** The same program with a client provided from `CLICKHOUSE_*` env vars. */
export const runnable = Effect.provide(program, layerFromEnv());

if (process.env.CLICKHOUSE_URL !== undefined) {
  Effect.runPromise(runnable)
    .then((rows) => {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`${String(error)}\n`);
    });
}
