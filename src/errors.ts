/** Typed errors for the ClickHouse layer, surfaced through Effect's error channel. */
import { Data } from "effect";
import type { ParseResult } from "effect";

/** A query / insert / command that the ClickHouse server (or transport) rejected. */
export class ClickhouseError extends Data.TaggedError("ClickhouseError")<{
  readonly message: string;
  /** ClickHouse server error code, e.g. `"60"` / `"UNKNOWN_TABLE"`, when available. */
  readonly code?: string;
  /** ClickHouse server error type, when available. */
  readonly serverType?: string;
  /** The SQL that triggered the error, when known. */
  readonly query?: string;
  readonly cause?: unknown;
}> {}

/** A row coming back from ClickHouse failed to decode against its column schema. */
export class RowDecodeError extends Data.TaggedError("RowDecodeError")<{
  readonly message: string;
  readonly cause: ParseResult.ParseError;
}> {}

/** A row passed to `insert` failed to encode to the wire format. */
export class RowEncodeError extends Data.TaggedError("RowEncodeError")<{
  readonly message: string;
  readonly cause: ParseResult.ParseError;
}> {}

/** Missing or invalid client configuration (e.g. when reading from the environment). */
export class ClickhouseConfigError extends Data.TaggedError("ClickhouseConfigError")<{
  readonly message: string;
}> {}
