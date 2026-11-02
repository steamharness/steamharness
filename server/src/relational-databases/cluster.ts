import pg from "pg";
import { randomBytes } from "node:crypto";
import { DatabaseResourceError, type DatabaseAccessMode } from "steamharness/database";
import { createPostgresPool } from "../postgres";
import { DATABASE_HISTORY_SCHEMA, identifier as q, literal } from "./schema";

export function databaseNames(id: string) {
  id = id.toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid database resource identity.");
  const key = id.replaceAll("-", "");
  return { database: `shdb_${key}`, owner: `shm_${key}`, read: `shr_${key}`, write: `shw_${key}`,
    shadow: `shshadow_${key}`, shadowOwner: `shs_${key}` };
}

export class DatabaseCluster {
  readonly pool: pg.Pool;
  constructor(private readonly connectionString: string) {
    this.pool = createPostgresPool({ connectionString, label: "database administration", max: 4, connectionTimeoutMillis: 10_000 });
  }
  async close(): Promise<void> { await this.pool.end(); }

  async prepare(): Promise<void> {
    const result = await this.pool.query("select rolsuper from pg_roles where rolname=current_user");
    if (!result.rows[0]?.rolsuper) throw new DatabaseResourceError("DATABASE_UNSAFE_CLUSTER", "Database provisioning requires the dedicated cluster administration identity.");
    // These standard databases and the configured control database must not be
    // reachable through PostgreSQL's default PUBLIC CONNECT grant.
    const databases = await this.pool.query("select datname from pg_database where datallowconn and (datname=current_database() or datname in ('postgres','template1'))");
    for (const { datname } of databases.rows) await this.pool.query(`revoke connect, temporary on database ${q(datname)} from public`);
  }

  async roles(id: string): Promise<void> {
    const names = databaseNames(id);
    for (const role of [names.owner, names.read, names.write]) {
      if (!(await this.pool.query("select 1 from pg_roles where rolname=$1", [role])).rowCount) {
        await this.pool.query(`create role ${q(role)} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
      }
    }
    await this.pool.query(`grant ${q(names.read)} to ${q(names.write)}`);
  }

  async database(id: string): Promise<void> {
    const names = databaseNames(id);
    if (!(await this.pool.query("select 1 from pg_database where datname=$1", [names.database])).rowCount) {
      await this.pool.query(`create database ${q(names.database)} owner ${q(names.owner)} template template0`);
    }
  }

  async permissions(id: string): Promise<void> {
    const names = databaseNames(id);
    await this.pool.query(`revoke all on database ${q(names.database)} from public`);
    await this.pool.query(`grant connect on database ${q(names.database)} to ${q(names.read)}, ${q(names.write)}`);
    await this.withAdminDatabase(names.database, async client => {
      await client.query(`revoke all on schema public from public;
        alter schema public owner to ${q(names.owner)};
        grant usage on schema public to ${q(names.read)}, ${q(names.write)};
        alter default privileges for role ${q(names.owner)} in schema public grant select on tables to ${q(names.read)};
        alter default privileges for role ${q(names.owner)} in schema public grant insert, update, delete on tables to ${q(names.write)};
        alter default privileges for role ${q(names.owner)} in schema public grant usage, select on sequences to ${q(names.write)};
        create schema if not exists ${q(DATABASE_HISTORY_SCHEMA)} authorization ${q(names.owner)};
        revoke all on schema ${q(DATABASE_HISTORY_SCHEMA)} from public;
        create table if not exists ${q(DATABASE_HISTORY_SCHEMA)}.history (
          ordinal integer primary key, name text not null unique, checksum text not null,
          schema_hash text not null, model_schema text not null, applied_at timestamptz not null default clock_timestamp()
        );
        alter table ${q(DATABASE_HISTORY_SCHEMA)}.history owner to ${q(names.owner)};
        revoke all on ${q(DATABASE_HISTORY_SCHEMA)}.history from public`);
    });
    await this.disableRole(names.owner);
  }

  async assertIsolation(role: string, allowedDatabase: string): Promise<void> {
    const others = await this.pool.query("select datname from pg_database where datallowconn and datname<>$2 and has_database_privilege($1,oid,'CONNECT')", [role, allowedDatabase]);
    if (others.rowCount) throw new DatabaseResourceError("DATABASE_UNSAFE_CLUSTER", "An unmanaged database grants public connection access. Restrict that database before issuing managed credentials.");
  }

  async credential(id: string, role: string, mode: DatabaseAccessMode, expiresAt: Date): Promise<string> {
    const names = databaseNames(id), password = randomBytes(32).toString("base64url");
    await this.pool.query(`create role ${q(role)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      password ${literal(password)} valid until ${literal(expiresAt.toISOString())} in role ${q(mode === "read" ? names.read : names.write)}`);
    try { await this.assertIsolation(role, names.database); }
    catch (error) { await this.dropCredential(role); throw error; }
    return this.url(names.database, role, password);
  }

  async disableRole(role: string): Promise<void> {
    if (!(await this.pool.query("select 1 from pg_roles where rolname=$1", [role])).rowCount) return;
    await this.pool.query(`alter role ${q(role)} nologin password null`);
    await this.pool.query("select pg_terminate_backend(pid) from pg_stat_activity where usename=$1 and pid<>pg_backend_pid()", [role]);
  }
  async dropCredential(role: string): Promise<void> {
    await this.disableRole(role);
    await this.pool.query(`drop role if exists ${q(role)}`);
  }

  async withMigration<T>(id: string, work: (client: pg.Client, url: string) => Promise<T>): Promise<T> {
    const names = databaseNames(id), password = randomBytes(32).toString("base64url");
    await this.pool.query(`alter role ${q(names.owner)} login password ${literal(password)} valid until ${literal(new Date(Date.now() + 15 * 60_000).toISOString())}`);
    let client: pg.Client | undefined;
    try {
      await this.assertIsolation(names.owner, names.database);
      const url = this.url(names.database, names.owner, password);
      client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
      await client.connect(); return await work(client, url);
    } finally { await client?.end().catch(() => undefined); await this.disableRole(names.owner); }
  }

  async cleanShadow(id: string): Promise<void> {
    const names = databaseNames(id);
    await this.pool.query(`drop database if exists ${q(names.shadow)} with (force)`);
    await this.dropCredential(names.shadowOwner);
  }

  async withShadow<T>(id: string, work: (client: pg.Client, url: string) => Promise<T>): Promise<T> {
    const names = databaseNames(id), password = randomBytes(32).toString("base64url");
    await this.cleanShadow(id);
    let client: pg.Client | undefined;
    try {
      await this.pool.query(`create role ${q(names.shadowOwner)} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
        password ${literal(password)} valid until ${literal(new Date(Date.now() + 15 * 60_000).toISOString())}`);
      await this.pool.query(`create database ${q(names.shadow)} owner ${q(names.shadowOwner)} template template0`);
      await this.pool.query(`revoke all on database ${q(names.shadow)} from public`);
      await this.withAdminDatabase(names.shadow, async admin => { await admin.query(`revoke all on schema public from public; alter schema public owner to ${q(names.shadowOwner)}`); });
      await this.assertIsolation(names.shadowOwner, names.shadow);
      const url = this.url(names.shadow, names.shadowOwner, password);
      client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
      await client.connect(); return await work(client, url);
    } finally { await client?.end().catch(() => undefined); await this.cleanShadow(id); }
  }

  async withAdminDatabase<T>(database: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: this.url(database), connectionTimeoutMillis: 10_000 });
    try { await client.connect(); return await work(client); } finally { await client.end(); }
  }
  url(database: string, user?: string, password?: string): string {
    const url = new URL(this.connectionString); url.pathname = `/${database}`;
    // A control connection may select a test/catalog schema. Business identities
    // always start in public and must not inherit administrator startup options.
    url.searchParams.delete("options"); url.searchParams.delete("schema");
    if (user !== undefined) { url.username = user; url.password = password!; }
    return url.toString();
  }
}
