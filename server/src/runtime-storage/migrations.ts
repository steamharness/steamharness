import { createHash } from "node:crypto";
import type pg from "pg";

export const RUNTIME_STORAGE_SCHEMA = "steamharness_runtime";

export function runtimeSchemaName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid runtime storage schema name.");
  return `"${value}"`;
}

const INITIAL_SCHEMA = `
create table __SCHEMA__.workspaces (
  id uuid primary key,
  owner_user_id text not null,
  kind text not null check (kind in ('project','local','assistant')),
  project_id text not null,
  entry_id text not null,
  local_key text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  unique (owner_user_id, kind, project_id, entry_id, local_key)
);
create table __SCHEMA__.agent_sessions (
  id uuid primary key,
  workspace_id uuid not null references __SCHEMA__.workspaces(id) on delete cascade,
  session_key text not null,
  next_id bigint not null default 2 check (next_id between 2 and 9007199254740992),
  next_seq bigint not null default 1 check (next_seq between 1 and 9007199254740992),
  fence bigint not null default 0,
  owner_token_hash text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, session_key)
);
create table __SCHEMA__.agent_record_ids (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  id bigint not null check (id between 1 and 9007199254740991),
  record_type text not null check (record_type in ('conversation','entry','task','submission','document')),
  primary key (session_id,id)
);
-- Payloads use JSON text so Chord's valid JSON keys, including escaped NUL and
-- lone UTF-16 surrogates, round-trip losslessly. Indexed identities and lifecycle
-- fields remain relational columns; there is no generic key/value table.
create table __SCHEMA__.agent_conversations (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  id bigint not null,
  owner_conversation_id bigint,
  owner_task_id bigint,
  record text not null,
  primary key (session_id,id)
);
create index on __SCHEMA__.agent_conversations (session_id,owner_conversation_id,owner_task_id,id);
create table __SCHEMA__.agent_entries (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  id bigint not null,
  conversation_id bigint not null,
  head bigint,
  commit_seq bigint not null,
  record text not null,
  primary key (session_id,id)
);
create index on __SCHEMA__.agent_entries (session_id,conversation_id,id);
create index on __SCHEMA__.agent_entries (session_id,conversation_id,id) where head is not null;
create table __SCHEMA__.agent_tasks (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  id bigint not null,
  conversation_id bigint not null,
  kind text not null,
  status text not null,
  abort_requested boolean not null,
  background boolean not null,
  record text not null,
  primary key (session_id,id)
);
create index on __SCHEMA__.agent_tasks (session_id,conversation_id,status,id);
create table __SCHEMA__.agent_submissions (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  id bigint not null,
  conversation_id bigint not null,
  request_id text,
  status text not null,
  record text not null,
  primary key (session_id,id),
  unique (session_id,conversation_id,request_id)
);
create index on __SCHEMA__.agent_submissions (session_id,conversation_id,status,id);
create table __SCHEMA__.agent_documents (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  id bigint not null,
  address_key text not null,
  kind text not null,
  scope_kind text not null,
  owner_id bigint not null,
  created_at bigint not null,
  retired_at bigint,
  record text not null,
  primary key (session_id,id)
);
create index on __SCHEMA__.agent_documents (session_id,address_key,created_at);
create index on __SCHEMA__.agent_documents (session_id,scope_kind,owner_id,id);
create table __SCHEMA__.agent_document_revisions (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  document_id bigint not null,
  seq bigint not null,
  kind text not null check (kind in ('base','delta')),
  version integer not null,
  content text not null,
  primary key (session_id,document_id,seq)
);
create table __SCHEMA__.agent_operations (
  session_id uuid not null references __SCHEMA__.agent_sessions(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null,
  result text not null,
  primary key (session_id,request_id)
);
`;

export async function migrateRuntimeStorage(pool: pg.Pool, schema = RUNTIME_STORAGE_SCHEMA): Promise<void> {
  const name = runtimeSchemaName(schema);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`steamharness:runtime-storage:migrations:${schema}`]);
    await client.query(`create schema if not exists ${name}`);
    await client.query(`create table if not exists ${name}.schema_migrations (version integer primary key, checksum text not null, applied_at timestamptz not null default clock_timestamp())`);
    const checksum = createHash("sha256").update(INITIAL_SCHEMA).digest("hex");
    const applied = await client.query(`select checksum from ${name}.schema_migrations where version=1`);
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) throw new Error("Runtime storage migration 1 checksum does not match.");
    } else {
      await client.query(INITIAL_SCHEMA.replaceAll("__SCHEMA__", name));
      await client.query(`insert into ${name}.schema_migrations (version,checksum) values (1,$1)`, [checksum]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
