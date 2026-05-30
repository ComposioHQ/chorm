#!/usr/bin/env node
/**
 * The `chorm` CLI. Currently a single command:
 *
 *   chorm generate --database <db> [--out <file>]
 *
 * Connects to ClickHouse (via flags or `CLICKHOUSE_*` env vars), introspects the database, and
 * writes a TypeScript schema module using the chorm DSL.
 */
import { Effect, ManagedRuntime } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import type { ClickHouseClientConfigOptions } from "@clickhouse/client";
import { configFromEnv, layer } from "./client.ts";
import { generateModule } from "./introspect/codegen.ts";
import { introspectDatabase } from "./introspect/columns.ts";
import { parseCreateTables } from "./introspect/ddl.ts";

interface ParsedArgs {
  readonly command: string;
  readonly database?: string;
  readonly out?: string;
  readonly url?: string;
  readonly username?: string;
  readonly password?: string;
  readonly importFrom?: string;
  readonly tables?: ReadonlyArray<string>;
  readonly fromDdl?: string;
  readonly stdout: boolean;
  readonly help: boolean;
}

const FLAG_ALIASES: Readonly<Record<string, string>> = {
  "-d": "--database",
  "-o": "--out",
  "-u": "--username",
  "-p": "--password",
  "-h": "--help",
};

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const positional: Array<string> = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const tokenRaw = argv[i];
    const token = FLAG_ALIASES[tokenRaw] ?? tokenRaw;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (token === "--help" || token === "--stdout") {
      bools.add(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    flags.set(token, argv[i + 1] ?? "");
    i += 1;
  }
  const tables = flags.get("--tables");
  return {
    command: positional[0] ?? "help",
    database: flags.get("--database"),
    out: flags.get("--out"),
    url: flags.get("--url"),
    username: flags.get("--username"),
    password: flags.get("--password"),
    importFrom: flags.get("--import"),
    tables: tables
      ? tables
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
    fromDdl: flags.get("--from-ddl"),
    stdout: bools.has("--stdout"),
    help: bools.has("--help"),
  };
};

const HELP = `chorm — typesafe ClickHouse ORM

Usage:
  chorm generate --database <db> [options]       # introspect a live database
  chorm generate --from-ddl <file.sql> [options] # offline: parse CREATE TABLE DDL

Options:
  -d, --database <db>     Database to introspect (live mode)
      --from-ddl <file>   Generate from a file of CREATE TABLE statements (no DB connection)
  -o, --out <file>        Write the generated schema to this file (default: stdout)
      --stdout            Force writing to stdout
      --tables <a,b,c>    Restrict to specific tables
      --import <pkg>      Import specifier for the chorm package in generated code (default: "chorm")
      --url <url>         ClickHouse URL (default: $CLICKHOUSE_URL or http://localhost:8123)
  -u, --username <user>   ClickHouse username (default: $CLICKHOUSE_USER or "default")
  -p, --password <pass>   ClickHouse password (default: $CLICKHOUSE_PASSWORD)
  -h, --help              Show this help

Tip: get the DDL with  clickhouse-client -q "SELECT create_table_query FROM system.tables
     WHERE database = 'your_db' AND engine NOT LIKE '%View' FORMAT TSVRaw" > schema.sql

Environment:
  CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE
`;

const buildConfig = (args: ParsedArgs): ClickHouseClientConfigOptions => {
  const base = configFromEnv();
  return {
    url: args.url ?? base.url,
    username: args.username ?? base.username,
    password: args.password ?? base.password,
    database: args.database ?? base.database,
  };
};

const run = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.command === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (args.command !== "generate" && args.command !== "introspect") {
    process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  // Offline mode: parse CREATE TABLE DDL from a file — no database connection.
  if (args.fromDdl !== undefined) {
    const tables = parseCreateTables(readFileSync(args.fromDdl, "utf8"));
    const source = generateModule(tables, { importFrom: args.importFrom });
    if (args.stdout || args.out === undefined) {
      process.stdout.write(source);
    } else {
      writeFileSync(args.out, source);
      process.stderr.write(`Wrote ${tables.length} table(s) to ${args.out}\n`);
    }
    return;
  }

  const database = args.database ?? configFromEnv().database;
  if (database === undefined || database === "") {
    process.stderr.write("error: --database is required\n");
    process.exitCode = 1;
    return;
  }

  const runtime = ManagedRuntime.make(layer(buildConfig(args)));
  try {
    const program = Effect.gen(function* () {
      const tables = yield* introspectDatabase(database, { tables: args.tables });
      return {
        source: generateModule(tables, { database, importFrom: args.importFrom }),
        count: tables.length,
      };
    });
    const result = await runtime.runPromise(program);
    if (args.stdout || args.out === undefined) {
      process.stdout.write(result.source);
    } else {
      writeFileSync(args.out, result.source);
      process.stderr.write(`Wrote ${result.count} table(s) to ${args.out}\n`);
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await runtime.dispose();
  }
};

void run();
