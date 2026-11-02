import { createHash } from "node:crypto";
import { DATABASE_ENGINE_VERSION, DatabaseResourceError, type DatabaseMigration } from "steamharness/database";

export const DATABASE_CATALOG_SCHEMA = "steamharness_databases";
export const DATABASE_HISTORY_SCHEMA = "steamharness_migrations";
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid managed PostgreSQL identifier.");
  return `"${value}"`;
};
export const literal = (value: string): string => {
  if (value.includes("\0")) throw new Error("Invalid PostgreSQL literal.");
  return `'${value.replaceAll("'", "''")}'`;
};
export function modelHash(source: string): string {
  return hash(`steamharness.database:1:postgresql:${DATABASE_ENGINE_VERSION}\n${source.replace(/\r\n/g, "\n")}`);
}
export function modelSchema(source: string): string {
  const tokens = source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, text => text.replace(/[^\n]/g, " "));
  if (/\b(?:datasource|generator)\s+\w+\s*\{/.test(tokens)) throw new DatabaseResourceError("DATABASE_SCHEMA_INVALID", "Define only models, enums and relations; connection configuration is managed by SteamHarness.");
  return `${source}\n\ndatasource db {\n  provider = "postgresql"\n}\n`;
}

/** Mask SQL strings, quoted identifiers and nested comments before inspecting commands. */
function sqlTokens(sql: string): { source: string; identifiers: string[] } {
  let source = "", index = 0;
  const identifiers: string[] = [];
  while (index < sql.length) {
    if (sql.startsWith("--", index)) { const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end; source += " "; continue; }
    if (sql.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Unterminated SQL comment.");
      source += " "; continue;
    }
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && /(?:^|[^a-z0-9_$])[eE]$/.test(sql.slice(0, index));
      let value = "", closed = false; index++;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index++; closed = true; break;
        }
        if (escaped && sql[index] === "\\") { index += 2; continue; }
        value += sql[index++];
      }
      if (!closed) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Unterminated SQL quoted value.");
      if (quote === '"') identifiers.push(value);
      source += " identifier "; continue;
    }
    if (quote === "$" && /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.test(sql.slice(index))) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Procedural SQL is outside model migrations.");
    source += sql[index++];
  }
  return { source, identifiers };
}

// Migration files contain ordinary model DDL and optional data DML. The runner
// owns transactions, privilege grants and its private migration history.
export function checkMigrationSql(sql: string): void {
  const { source, identifiers } = sqlTokens(sql);
  if (identifiers.some(value => value.toLowerCase() === DATABASE_HISTORY_SCHEMA) || new RegExp(`\\b${DATABASE_HISTORY_SCHEMA}\\b`, "i").test(source)) {
    throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Migration history is managed by SteamHarness.");
  }
  for (const statement of source.split(";").map(value => value.trim()).filter(Boolean)) {
    if (!/^(?:create\s+(?:table|type|(?:unique\s+)?index)\b|alter\s+(?:table|type)\b|drop\s+(?:table|type|index)\b|insert\s+into\b|update\b|delete\s+from\b)/i.test(statement)) {
      throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "SQL migrations support model tables, enums, indexes and data changes; transaction and privilege commands are managed by SteamHarness.");
    }
  }
}
export function destructiveMigration(sql: string): boolean {
  const { source } = sqlTokens(sql);
  return source.split(";").some(statement => {
    const command = statement.trim();
    // ON DELETE/ON UPDATE clauses on a newly created foreign key do not
    // delete data. Inspect commands rather than individual keyword matches.
    return /^(?:drop\b|truncate\b|delete\s+from\b|update\b)/i.test(command)
      || /^alter\s+(?:table|type)\b[\s\S]*\bdrop\b/i.test(command)
      || /^alter\s+table\b[\s\S]*\balter\s+column\b[\s\S]*?\b(?:type|set\s+not\s+null)\b/i.test(command)
      || /^insert\s+into\b[\s\S]*\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i.test(command);
  });
}

export function validateMigrationHistory(migrations: readonly DatabaseMigration[]): void {
  if (migrations.length > 1000) throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Too many database migrations.");
  let previous = "";
  for (const migration of migrations) {
    if (!/^[0-9]{17}_[a-z][a-z0-9_]{0,63}$/.test(migration.name) || migration.name <= previous
      || migration.checksum !== hash(migration.sql) || migration.schemaHash !== modelHash(migration.schema)) {
      throw new DatabaseResourceError("DATABASE_HISTORY_CONFLICT", "Migration names, checksums or model fingerprints are inconsistent.");
    }
    modelSchema(migration.schema); checkMigrationSql(migration.sql); previous = migration.name;
  }
}

export const CATALOG_SQL = `
create table __SCHEMA__.resources (
  id uuid primary key,
  request_id uuid not null,
  owner_user_id text not null,
  name text not null,
  status text not null check(status in ('requested','provisioning','ready','failed')),
  stage text not null check(stage in ('requested','roles','database','permissions','ready')),
  failure_code text,
  schema_hash text,
  migration_name text,
  migration_status text not null default 'idle' check(migration_status in ('idle','running','failed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(owner_user_id,request_id)
);
create table __SCHEMA__.grants (
  database_id uuid not null references __SCHEMA__.resources(id),
  user_id text not null,
  mode text not null check(mode in ('read','write')),
  revision integer not null default 1,
  revoked boolean not null default false,
  primary key(database_id,user_id)
);
create table __SCHEMA__.credentials (
  id uuid primary key,
  database_id uuid not null references __SCHEMA__.resources(id),
  user_id text not null,
  role_name text not null unique,
  expires_at timestamptz not null,
  revoking boolean not null default false
);
create index on __SCHEMA__.credentials(database_id,user_id);
create table __SCHEMA__.migration_attempts (
  id uuid primary key,
  database_id uuid not null references __SCHEMA__.resources(id),
  actor_user_id text not null,
  status text not null check(status in ('running','applied','failed')),
  failure_code text,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz
);
`;
