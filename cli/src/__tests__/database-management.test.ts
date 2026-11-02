import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseArtifactHash } from "@steamharness/project-upload/database-artifacts";
import { databaseManagementRequest, manageDatabases, parseDatabaseManagementArgs } from "../database-management";
import { migrationModelHash, readDatabaseMigrations, writeDatabaseMigration } from "../database-migrations";

vi.mock("../auth-config", () => ({ readCliAuthConfig: async () => ({ serverUrl: "https://server.example.test", apiKey: "test-account-token" }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const id = "71b86ea0-5632-4ce3-853b-acce3c3d4375";
const schema = 'model User {\n id String @id\n}\n';
const sql = 'CREATE TABLE "User" ("id" TEXT PRIMARY KEY);\n';
const migration = { name: "20261102000000000_init", schema, sql, schemaHash: migrationModelHash(schema), checksum: databaseArtifactHash(sql) };

describe("database resource CLI", () => {
  it("uses account login and lets explicit server/token options override it", async () => {
    vi.stubEnv("STEAMHARNESS_SERVER_URL", ""); vi.stubEnv("STEAMHARNESS_SERVER_ADMIN_KEY", "");
    const parsed = await parseDatabaseManagementArgs(["list", "--server", "http://127.0.0.1:18126", "--token", "local-test-token"]);
    expect(parsed.options.server).toBe("http://127.0.0.1:18126"); expect(parsed.options.token).toBe("local-test-token");
    expect(parsed.positional).toEqual(["list"]);
    await expect(parseDatabaseManagementArgs(["list", "--server"])).rejects.toThrow("requires a value");
    await expect(parseDatabaseManagementArgs(["list", "--missing"])).rejects.toThrow("Unknown database option");
  });

  it("sends authenticated management requests, preserves error codes and never calls fetch for invalid IDs", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errCode: 0, errMessage: "", data: { revoked: true } })));
    vi.stubGlobal("fetch", fetcher);
    await manageDatabases(["revoke", id, "--user", "other/user", "--server", "http://localhost:18126", "--token", "test"]);
    expect(fetcher.mock.calls[0][0]).toBe(`http://localhost:18126/api/databases/${id}/grants/other%2Fuser`);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer test");
    expect(fetcher.mock.calls[0][1].method).toBe("DELETE");
    await expect(manageDatabases(["inspect", "../bad"])).rejects.toThrow("UUID");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ errCode: 409, errMessage: "History changed.", data: { code: "DATABASE_HISTORY_CONFLICT" } }), { status: 409 }));
    await expect(databaseManagementRequest({ server: "http://localhost", token: "test" }, "")).rejects.toThrow("DATABASE_HISTORY_CONFLICT: History changed.");
    await expect(databaseManagementRequest({ server: "http://user:password@localhost", token: "test" }, "")).rejects.toThrow("without credentials");
  });

  it("returns failure for an incomplete provisioning retry", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errCode: 0, errMessage: "", data: {
      id, status: "failed", failureCode: "DATABASE_PROVISION_FAILED",
    } }))));
    await expect(manageDatabases(["retry", id, "--token", "test"])).rejects.toThrow("DATABASE_PROVISION_FAILED");
  });
});

describe("versioned migration files", () => {
  it("round-trips SQL, model snapshots and fingerprints, and rejects changes or incomplete histories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "steamharness-migration-"));
    try {
      const location = await writeDatabaseMigration(root, "database/main/steamharness.schema", migration);
      expect((await readDatabaseMigrations(root, "database/main/steamharness.schema")).migrations).toEqual([migration]);
      await expect(writeDatabaseMigration(root, "database/main/steamharness.schema", migration)).rejects.toThrow("already exists");
      await writeFile(path.join(root, location, "migration.sql"), sql + "-- changed");
      await expect(readDatabaseMigrations(root, "database/main/steamharness.schema")).rejects.toThrow("fingerprints");
      await writeFile(path.join(root, location, "migration.sql"), sql);
      await rm(path.join(root, location, "steamharness.migration.json"));
      await expect(readDatabaseMigrations(root, "database/main/steamharness.schema")).rejects.toThrow("Incomplete migration");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects links and paths outside the project and supports platform-independent model hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "steamharness-migration-path-"));
    try {
      expect(migrationModelHash(schema.replaceAll("\n", "\r\n"))).toBe(migration.schemaHash);
      for (const unsafe of ["../steamharness.schema", "/steamharness.schema", "C:/steamharness.schema", "database\\steamharness.schema"]) {
        await expect(writeDatabaseMigration(root, unsafe, migration)).rejects.toThrow("project-relative");
      }
      await mkdir(path.join(root, "actual"));
      await symlink(path.join(root, "actual"), path.join(root, "database"), process.platform === "win32" ? "junction" : "dir");
      await expect(writeDatabaseMigration(root, "database/steamharness.schema", migration)).rejects.toThrow("regular directories");
      await rm(path.join(root, "database"));
      const location = await writeDatabaseMigration(root, "steamharness.schema", migration);
      await writeFile(path.join(root, "actual/sql"), sql);
      await rm(path.join(root, location, "migration.sql"));
      await symlink(path.join(root, "actual/sql"), path.join(root, location, "migration.sql"));
      await expect(readDatabaseMigrations(root, "steamharness.schema")).rejects.toThrow("regular files");
      expect(await readFile(path.join(root, "actual/sql"), "utf8")).toBe(sql);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
