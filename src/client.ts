/**
 * The Effect-native ClickHouse client.
 *
 * {@link ClickhouseClient} is a `Context.Tag` service wrapping `@clickhouse/client`. It is
 * provided as a scoped {@link layer} that opens the underlying connection on acquisition and
 * closes it when the scope ends. Every request pins a deterministic set of JSON I/O settings
 * (see `./types.ts`) so that decoding/encoding is unambiguous.
 */
import {
  ClickHouseError,
  type ClickHouseClientConfigOptions,
  type ClickHouseSettings,
  createClient,
} from "@clickhouse/client";
import { Context, Effect, Layer, Schema } from "effect";
import { ClickhouseError, RowDecodeError, RowEncodeError } from "./errors.ts";

type RawClient = ReturnType<typeof createClient>;

/** Settings pinned on every read so the JSON wire format is deterministic. */
export const READ_SETTINGS: ClickHouseSettings = {
  output_format_json_quote_64bit_integers: 1,
  output_format_json_quote_decimals: 1,
  output_format_json_named_tuples_as_objects: 1,
  date_time_output_format: "unix_timestamp",
};

/** Settings pinned on every write. */
export const WRITE_SETTINGS: ClickHouseSettings = {
  date_time_input_format: "best_effort",
  input_format_json_named_tuples_as_objects: 1,
};

/** Result of an `insert`. */
export interface InsertResult {
  readonly executed: boolean;
  readonly rows: number;
}

/** Parameters shared by the query methods. */
export interface QueryParams {
  readonly sql: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly settings?: ClickHouseSettings;
  readonly abortSignal?: AbortSignal;
}

/** The methods exposed by the {@link ClickhouseClient} service. */
export interface ClickhouseClientService {
  /** The underlying `@clickhouse/client` instance, for advanced use. */
  readonly raw: RawClient;
  /** Run a `SELECT` and return the raw, undecoded JSONEachRow objects. */
  readonly queryRaw: (
    params: QueryParams,
  ) => Effect.Effect<ReadonlyArray<unknown>, ClickhouseError>;
  /** Run a `SELECT` and decode each row against `rowSchema`. */
  readonly query: <A, I>(
    params: QueryParams & { readonly rowSchema: Schema.Schema<A, I> },
  ) => Effect.Effect<ReadonlyArray<A>, ClickhouseError | RowDecodeError>;
  /** Insert rows, encoding each through `rowSchema` if provided. */
  readonly insert: <A, I>(params: {
    readonly table: string;
    readonly rows: ReadonlyArray<A>;
    readonly rowSchema?: Schema.Schema<A, I>;
    readonly columns?: ReadonlyArray<string>;
    readonly settings?: ClickHouseSettings;
  }) => Effect.Effect<InsertResult, ClickhouseError | RowEncodeError>;
  /** Execute a statement without output (DDL, `ALTER`, `TRUNCATE`, …). */
  readonly command: (params: {
    readonly sql: string;
    readonly settings?: ClickHouseSettings;
  }) => Effect.Effect<void, ClickhouseError>;
  /** Health check. Never fails — returns `false` on error. */
  readonly ping: () => Effect.Effect<boolean>;
}

/** The ClickHouse client service tag. */
export class ClickhouseClient extends Context.Tag("chorm/ClickhouseClient")<
  ClickhouseClient,
  ClickhouseClientService
>() {}

const toClickhouseError = (error: unknown, query?: string): ClickhouseError =>
  error instanceof ClickHouseError
    ? new ClickhouseError({
        message: error.message,
        code: error.code,
        serverType: error.type,
        query,
        cause: error,
      })
    : new ClickhouseError({
        message: error instanceof Error ? error.message : String(error),
        query,
        cause: error,
      });

/** Build the service object around an already-created raw client. */
export const makeService = (raw: RawClient): ClickhouseClientService => {
  const queryRaw: ClickhouseClientService["queryRaw"] = ({ sql, params, settings, abortSignal }) =>
    Effect.tryPromise({
      try: async () => {
        const resultSet = await raw.query({
          query: sql,
          query_params: params as Record<string, unknown> | undefined,
          format: "JSONEachRow",
          clickhouse_settings: { ...READ_SETTINGS, ...settings },
          abort_signal: abortSignal,
        });
        return (await resultSet.json()) as ReadonlyArray<unknown>;
      },
      catch: (error) => toClickhouseError(error, sql),
    });

  const query: ClickhouseClientService["query"] = ({ rowSchema, ...rest }) =>
    Effect.gen(function* () {
      const rows = yield* queryRaw(rest);
      return yield* Schema.decodeUnknown(Schema.Array(rowSchema))(rows).pipe(
        Effect.mapError(
          (cause) =>
            new RowDecodeError({ message: `Failed to decode ${rows.length} row(s)`, cause }),
        ),
      );
    });

  const insert: ClickhouseClientService["insert"] = ({
    table,
    rows,
    rowSchema,
    columns,
    settings,
  }) =>
    Effect.gen(function* () {
      if (rows.length === 0) return { executed: false, rows: 0 };
      const values: ReadonlyArray<unknown> = rowSchema
        ? yield* Effect.forEach(rows, (row) =>
            Schema.encode(rowSchema)(row).pipe(
              Effect.mapError(
                (cause) => new RowEncodeError({ message: "Failed to encode insert row", cause }),
              ),
            ),
          )
        : rows;
      yield* Effect.tryPromise({
        try: () =>
          raw.insert({
            table,
            values,
            format: "JSONEachRow",
            columns: columns as [string, ...Array<string>] | undefined,
            clickhouse_settings: { ...WRITE_SETTINGS, ...settings },
          }),
        catch: (error) => toClickhouseError(error, `INSERT INTO ${table}`),
      });
      return { executed: true, rows: rows.length };
    });

  const command: ClickhouseClientService["command"] = ({ sql, settings }) =>
    Effect.tryPromise({
      try: () => raw.command({ query: sql, clickhouse_settings: settings }),
      catch: (error) => toClickhouseError(error, sql),
    }).pipe(Effect.asVoid);

  const ping: ClickhouseClientService["ping"] = () =>
    Effect.promise(() =>
      raw
        .ping()
        .then((result) => result.success)
        .catch(() => false),
    );

  return { raw, queryRaw, query, insert, command, ping };
};

/** A scoped layer that opens a ClickHouse connection and closes it when the scope ends. */
export const layer = (config: ClickHouseClientConfigOptions): Layer.Layer<ClickhouseClient> =>
  Layer.scoped(
    ClickhouseClient,
    Effect.acquireRelease(
      Effect.sync(() => createClient(config)),
      (raw) => Effect.promise(() => raw.close()),
    ).pipe(Effect.map(makeService)),
  );

/** Build client config from standard `CLICKHOUSE_*` environment variables. */
export const configFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClickHouseClientConfigOptions => ({
  url: env.CLICKHOUSE_URL ?? env.CLICKHOUSE_HOST ?? "http://localhost:8123",
  username: env.CLICKHOUSE_USER ?? env.CLICKHOUSE_USERNAME ?? "default",
  password: env.CLICKHOUSE_PASSWORD ?? "",
  database: env.CLICKHOUSE_DATABASE ?? env.CLICKHOUSE_DB ?? "default",
});

/** Convenience layer built from `CLICKHOUSE_*` environment variables. */
export const layerFromEnv = (
  env?: Readonly<Record<string, string | undefined>>,
): Layer.Layer<ClickhouseClient> => layer(configFromEnv(env));
