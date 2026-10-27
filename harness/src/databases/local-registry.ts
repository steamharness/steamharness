import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DatabaseCatalog, type CreateDatabaseRequest, type DatabaseCatalogState } from "@steamharness/database-spaces/catalog";
import type { DatabaseActor, DatabasePermissions } from "@steamharness/database-spaces";

export function localDatabaseRegistryDirectory(): string {
  const override = process.env.STEAMHARNESS_DATABASES_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".steamharness", "databases");
}
/** The native host is the local administrator. Project RPC never supplies this actor. */
export function localDatabaseHostActor(): DatabaseActor {
  return { userId: `local:${os.userInfo().username}`, isSystemAdmin: true };
}

/** User-level registry shared by CLI Web, Studio and local SDK runs. */
export class LocalDatabaseRegistry {
  readonly directory: string;
  constructor(directory = localDatabaseRegistryDirectory()) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.directory, 0o700);
  }
  request(input: CreateDatabaseRequest) { return this.mutate((catalog) => catalog.request(input, localDatabaseHostActor())); }
  review(requestId: string, decision: { approve: boolean; permissions?: DatabasePermissions; reason?: string }) { return this.mutate((catalog) => catalog.review(requestId, decision, localDatabaseHostActor())); }
  revoke(grantId: string) { return this.mutate((catalog) => catalog.revoke(grantId, localDatabaseHostActor())); }
  rotate(grantId: string) { return this.mutate((catalog) => catalog.rotate(grantId, localDatabaseHostActor())); }
  narrow(grantId: string, permissions: DatabasePermissions) { return this.mutate((catalog) => catalog.narrow(grantId, permissions, localDatabaseHostActor())); }
  read() { return this.mutate((catalog) => catalog.visible(localDatabaseHostActor()), false); }
  authorization(bindingRef: string) { return this.mutate((catalog) => catalog.authorization(bindingRef), false); }

  private mutate<T>(run: (catalog: DatabaseCatalog) => T, write = true): T {
    const db = new DatabaseSync(path.join(this.directory, "registry.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
      db.exec("CREATE TABLE IF NOT EXISTS database_catalog (id INTEGER PRIMARY KEY CHECK(id = 1), content TEXT NOT NULL)");
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const row = db.prepare("SELECT content FROM database_catalog WHERE id = 1").get();
        const state: DatabaseCatalogState = row ? JSON.parse(String(row.content)) : { spaces: [], requests: [], grants: [], bindings: [] };
        const result = run(new DatabaseCatalog("local", state, randomUUID, () => new Date().toISOString()));
        if (write) db.prepare("INSERT INTO database_catalog(id, content) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content").run(JSON.stringify(state));
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }
}
