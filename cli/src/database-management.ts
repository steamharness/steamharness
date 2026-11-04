import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseMigrationPlan, DatabaseResource } from "steamharness/database";
import { databaseArtifactHash } from "@steamharness/project-upload/database-artifacts";
import { readCliAuthConfig } from "./auth-config";
import { defaultServerUrl } from "./service-url";
import { generateDatabases, validateDatabases } from "./database-generation";
import { readDatabaseMigrations, writeDatabaseMigration } from "./database-migrations";
import { resolveProjectDeclarationEntrySync } from "@steamharness/project-manifest/node";

export interface DatabaseManagementOptions {
  server: string; token: string; database?: string; alias: string; name?: string; user?: string; mode?: string;
  requestId?: string; entry?: string; page?: string; pageSize?: string; search?: string; draft: boolean; acceptDataLoss: boolean;
}
export async function parseDatabaseManagementArgs(argv: string[]) {
  const saved = await readCliAuthConfig();
  const options: DatabaseManagementOptions = { server: process.env.STEAMHARNESS_SERVER_URL ?? (saved.serverUrl.trim() || defaultServerUrl()),
    token: process.env.STEAMHARNESS_SERVER_ADMIN_KEY ?? saved.apiKey ?? "", alias: "main", draft: false, acceptDataLoss: false };
  const positional: string[] = [];
  const names = { "--server": "server", "--token": "token", "--database": "database", "--alias": "alias", "--name": "name", "--user": "user", "--mode": "mode", "--request-id": "requestId", "--entry": "entry", "--page": "page", "--page-size": "pageSize", "--search": "search" } as const;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--draft") { options.draft = true; continue; }
    if (arg === "--accept-data-loss") { options.acceptDataLoss = true; continue; }
    if (Object.hasOwn(names, arg)) {
      const key = names[arg as keyof typeof names], value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[key] = value; continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown database option ${arg}.`);
    positional.push(arg);
  }
  return { positional, options };
}

export async function databaseManagementRequest<T>(options: Pick<DatabaseManagementOptions, "server" | "token">, endpoint: string, method = "GET", body?: unknown, namespace: "databases" | "knowledge-bases" = "databases", timeoutMs = 180_000): Promise<T> {
  if (!options.token) throw new Error("Account login is required. Run steamharness workspace login first.");
  const url = new URL(options.server);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use a Server HTTP URL without credentials, query or fragment.");
  const response = await fetch(`${options.server.replace(/\/$/, "")}/api/${namespace}${endpoint}`, {
    method, redirect: "error", headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(error => { throw Object.assign(error, { status: 503 }); });
  const result = await response.json().catch(error => { throw Object.assign(error, { status: response.ok ? 503 : response.status }); }) as { errCode?: number; errMessage?: string; data?: T & { code?: string } };
  if (!response.ok || result.errCode !== 0) throw Object.assign(new Error(`${result.data?.code ? result.data.code + ": " : ""}${result.errMessage ?? `Database request failed (${response.status}).`}`), { status: response.status, code: result.data?.code });
  return result.data as T;
}

/** Bound request input before buffering; terminal invocation must never wait for hidden input. */
export async function readDatabaseRequestInput(fallback: unknown, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  if (process.stdin.isTTY) throw new Error('Redirect a JSON request into standard input.');
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > maxBytes) throw new Error('Database request input is too large.');
    parts.push(bytes);
  }
  return size ? JSON.parse(Buffer.concat(parts).toString('utf8')) : fallback;
}
export function databaseListQuery(options: Pick<DatabaseManagementOptions, 'page' | 'pageSize' | 'search'>): string {
  const query = new URLSearchParams();
  for (const [key, max] of [['page', 1_000_000], ['pageSize', 100]] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw new Error(`Invalid ${key}.`);
      query.set(key, value);
    }
  }
  if (options.search !== undefined) query.set('search', options.search);
  return query.size ? `?${query}` : '';
}

export async function manageDatabases(argv: string[]): Promise<void> {
  const { positional, options } = await parseDatabaseManagementArgs(argv), [command, ...args] = positional;
  const request = <T = unknown>(endpoint: string, method?: string, body?: unknown) => databaseManagementRequest<T>(options, endpoint, method, body);
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  const id = (value?: string) => {
    if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error("Specify a database resource UUID.");
    return value.toLowerCase();
  };
  if (["bind", "unbind", "bindings"].includes(command) && args.length <= 1) {
    const databaseId = command === "bind" ? id(options.database) : undefined;
    if (options.mode !== undefined && !["read", "write"].includes(options.mode)) throw new Error("Choose --mode read or write.");
    const declaration = resolveProjectDeclarationEntrySync(path.resolve(args[0] ?? "."), options.entry);
    const consumer = { projectId: declaration.manifest.projectId, entryId: declaration.registration.entryId, alias: options.alias };
    if (command === "bindings") { output(await request(`/bindings?projectId=${encodeURIComponent(consumer.projectId)}&entryId=${encodeURIComponent(consumer.entryId)}`)); return; }
    if (command === "unbind") { await request("/bindings", "DELETE", consumer); output({ unbound: true, ...consumer }); return; }
    const generated = await generateDatabases(declaration.projectDir, declaration.registration.root);
    const database = generated.databases.find(item => item.alias === options.alias);
    if (!database) throw new Error(`Database alias ${JSON.stringify(options.alias)} is not defined for entry ${JSON.stringify(consumer.entryId)}.`);
    output(await request("/bindings", "POST", { ...consumer, databaseId, schemaHash: database.schemaHash, ...(options.mode ? { mode: options.mode } : {}) }));
    return;
  }
  if (command === "list" && !args.length) { output(await request(databaseListQuery(options))); return; }
  if (command === "create" && args.length === 1) {
    const resource = await request<DatabaseResource>("", "POST", { name: args[0], requestId: options.requestId ? id(options.requestId) : randomUUID() });
    output(resource);
    if (resource.status !== "ready") throw new Error(`Database provisioning is ${resource.status}; retry resource ${resource.id}. ${resource.failureCode ?? ""}`);
    return;
  }
  if (command === "data" && args.length === 1) {
    const input = await readDatabaseRequestInput({ operation: 'models' });
    output(await request(`/${id(args[0])}/data`, 'POST', input)); return;
  }
  if (command === "inspect" && args.length === 1) { output(await request(`/${id(args[0])}`)); return; }
  if (command === "retry" && args.length === 1) {
    const resource = await request<DatabaseResource>(`/${id(args[0])}/retry`, "POST", {}); output(resource);
    if (resource.status !== "ready") throw new Error(`Database provisioning is ${resource.status}; retry resource ${resource.id}. ${resource.failureCode ?? ""}`);
    return;
  }
  if (command === "grant" && args.length === 1 && options.user && ["read", "write"].includes(options.mode ?? "")) {
    output(await request(`/${id(args[0])}/grants`, "POST", { userId: options.user, mode: options.mode })); return;
  }
  if (command === "revoke" && args.length === 1 && options.user) {
    await request(`/${id(args[0])}/grants/${encodeURIComponent(options.user)}`, "DELETE"); output({ revoked: true }); return;
  }
  if (command !== "migrate" || !["dev", "deploy", "status"].includes(args[0]) || args.length > 2) throw new Error("Use database create/list/inspect/retry/grant/revoke, or migrate dev/deploy/status [directory] --database <id>.");
  const [action, directory = "."] = args, databaseId = id(options.database), endpoint = `/${databaseId}/migrations`;
  if (action === "status") { output(await request(endpoint)); return; }
  const projectRoot = path.resolve(directory);
  const declaration = resolveProjectDeclarationEntrySync(projectRoot, options.entry);
  const sourceRoot = declaration.registration.root, root = declaration.rootDir;
  const validated = await validateDatabases(projectRoot, sourceRoot);
  const database = validated.databases.find(item => item.alias === options.alias);
  if (!database) throw new Error(`Database alias ${options.alias} is not defined.`);
  const schema = validated.schemas.get(database.schemaHash)!;
  let { migrations } = await readDatabaseMigrations(root, database.schema);
  if (action === "dev") {
    const name = options.name ?? "update";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error("Migration names use 1–64 lowercase letters, digits and underscores, starting with a letter.");
    const plan = await request<DatabaseMigrationPlan>(endpoint + "/plan", "POST", { schema: schema.source, migrations });
    if (plan.schemaHash !== database.schemaHash) throw new Error("Server and CLI database model fingerprints differ.");
    if (plan.sql === null) { output({ databaseId, unchanged: true }); return; }
    const migration = { name: new Date().toISOString().replace(/[^0-9]/g, "") + "_" + name,
      sql: plan.sql, checksum: databaseArtifactHash(plan.sql), schema: schema.source, schemaHash: database.schemaHash };
    const location = await writeDatabaseMigration(root, database.schema, migration);
    migrations = [...migrations, migration];
    await generateDatabases(projectRoot, sourceRoot);
    if (options.draft) { output({ databaseId, migration: location, destructive: plan.destructive, applied: false }); return; }
    if (plan.destructive && !options.acceptDataLoss) throw new Error(`Migration saved at ${location}. Review its SQL, then deploy with --accept-data-loss if appropriate.`);
  }
  if (!migrations.length) throw new Error("No migrations exist. Run database migrate dev first.");
  const applied = await request(endpoint + "/deploy", "POST", { migrations, schemaHash: database.schemaHash, acceptDataLoss: options.acceptDataLoss });
  await generateDatabases(projectRoot, sourceRoot);
  output({ databaseId, migrations: applied });
}
