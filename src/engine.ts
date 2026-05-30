/**
 * Typed table engines. Instead of writing the engine as a raw string, use a builder
 * (`replacingMergeTree("version")`, `sharedReplacingMergeTree({ version: "..." })`, …).
 * The resulting {@link Engine} object carries structured knowledge — notably the version/sign
 * column and whether queries need `FINAL` to deduplicate — which the query layer can use.
 *
 * A plain string is still accepted everywhere an `Engine` is, as an escape hatch.
 */

/** A structured ClickHouse table engine. */
export interface Engine {
  /** Engine name, e.g. `"ReplacingMergeTree"`. */
  readonly name: string;
  /** Raw, already-rendered positional parameters (quoted where needed). */
  readonly parameters: ReadonlyArray<string>;
  /** The version (Replacing) or sign (Collapsing) column, when the engine has one. */
  readonly versionColumn: string | null;
  /** Whether a `SELECT` must use `FINAL` to collapse to the latest row. */
  readonly needsFinal: boolean;
}

/** Either a structured {@link Engine} or a raw engine string. */
export type EngineInput = Engine | string;

const makeEngine = (
  name: string,
  parameters: ReadonlyArray<string>,
  options: { readonly needsFinal: boolean; readonly versionColumn?: string | null } = {
    needsFinal: false,
  },
): Engine => ({
  name,
  parameters,
  versionColumn: options.versionColumn ?? null,
  needsFinal: options.needsFinal,
});

/** Render an engine (or raw string) to its `ENGINE = …` clause body. */
export const renderEngine = (engine: EngineInput): string => {
  if (typeof engine === "string") return engine;
  return engine.parameters.length === 0
    ? engine.name
    : `${engine.name}(${engine.parameters.join(", ")})`;
};

/** Whether a table on this engine needs `FINAL` to deduplicate rows. */
export const engineNeedsFinal = (engine: EngineInput | undefined): boolean =>
  typeof engine === "object" && engine !== null && engine.needsFinal;

/** The version/sign column of an engine, if any. */
export const engineVersionColumn = (engine: EngineInput | undefined): string | null =>
  typeof engine === "object" && engine !== null ? engine.versionColumn : null;

// ---------------------------------------------------------------------------
// MergeTree family
// ---------------------------------------------------------------------------

export const mergeTree = (): Engine => makeEngine("MergeTree", [], { needsFinal: false });

export const replacingMergeTree = (version?: string): Engine =>
  makeEngine("ReplacingMergeTree", version === undefined ? [] : [version], {
    needsFinal: true,
    versionColumn: version ?? null,
  });

export const summingMergeTree = (columns?: ReadonlyArray<string>): Engine =>
  makeEngine(
    "SummingMergeTree",
    columns === undefined || columns.length === 0 ? [] : [`(${columns.join(", ")})`],
    { needsFinal: true },
  );

export const aggregatingMergeTree = (): Engine =>
  makeEngine("AggregatingMergeTree", [], { needsFinal: true });

export const collapsingMergeTree = (sign: string): Engine =>
  makeEngine("CollapsingMergeTree", [sign], { needsFinal: true, versionColumn: sign });

export const versionedCollapsingMergeTree = (sign: string, version: string): Engine =>
  makeEngine("VersionedCollapsingMergeTree", [sign, version], {
    needsFinal: true,
    versionColumn: version,
  });

// ---------------------------------------------------------------------------
// Replicated + ClickHouse Cloud "Shared" families
// ---------------------------------------------------------------------------

/** Keeper path + replica name for Replicated / Shared engines. */
export interface ReplicationOptions {
  /** Keeper/ZooKeeper path. Omit on ClickHouse Cloud (the platform supplies it). */
  readonly path?: string;
  /** Replica name. Defaults to `"{replica}"` when a path is given. */
  readonly replica?: string;
}

const replicationParams = (options: ReplicationOptions): ReadonlyArray<string> =>
  options.path === undefined ? [] : [`'${options.path}'`, `'${options.replica ?? "{replica}"}'`];

const sharedFamily =
  (name: string, needsFinal: boolean) =>
  (options: ReplicationOptions & { readonly version?: string } = {}): Engine =>
    makeEngine(
      name,
      [...replicationParams(options), ...(options.version === undefined ? [] : [options.version])],
      { needsFinal, versionColumn: options.version ?? null },
    );

export const sharedMergeTree = sharedFamily("SharedMergeTree", false);
export const sharedReplacingMergeTree = sharedFamily("SharedReplacingMergeTree", true);
export const sharedSummingMergeTree = sharedFamily("SharedSummingMergeTree", true);
export const sharedAggregatingMergeTree = sharedFamily("SharedAggregatingMergeTree", true);

export const replicatedMergeTree = sharedFamily("ReplicatedMergeTree", false);
export const replicatedReplacingMergeTree = sharedFamily("ReplicatedReplacingMergeTree", true);
export const replicatedSummingMergeTree = sharedFamily("ReplicatedSummingMergeTree", true);

// ---------------------------------------------------------------------------
// Other engines + escape hatch
// ---------------------------------------------------------------------------

export const memory = (): Engine => makeEngine("Memory", [], { needsFinal: false });
export const tinyLog = (): Engine => makeEngine("TinyLog", [], { needsFinal: false });
export const log = (): Engine => makeEngine("Log", [], { needsFinal: false });

/** Build an arbitrary engine from a name and pre-rendered parameters. */
export const engine = (
  name: string,
  parameters: ReadonlyArray<string> = [],
  options: { readonly needsFinal?: boolean; readonly versionColumn?: string } = {},
): Engine =>
  makeEngine(name, parameters, {
    needsFinal: options.needsFinal ?? false,
    versionColumn: options.versionColumn ?? null,
  });
