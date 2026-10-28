import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { LocalDatabaseRegistry, bindProjectDatabase, createLocalDatabaseResolver, inspectAggregateProjectStructure, readEntrypointOutput, runLocalProjectWithReport } from "steamharness";

it("runs same-type aggregate entries only after explicit independent approvals and shares a space with a second project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "database-space-demo-"));
  const projectDir = path.join(directory, "project");
  try {
    await cp(path.resolve(import.meta.dirname, "../workflow/database-space-demo"), projectDir, { recursive: true });
    const registry = new LocalDatabaseRegistry(path.join(directory, "host"));
    const databaseResolver = createLocalDatabaseResolver(registry);
    const manifest = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
    const projectId = manifest.id;
    const requirement = manifest.steamHarness.entries[0].databases[0];
    const run = async (entryId: string, action: string, target = projectDir) => {
      const report = await runLocalProjectWithReport({ projectDir: target, entryId, args: ["--action", action, "--value", "shared"], databaseResolver });
      expect(report.status, JSON.stringify(report.result)).toBe("success");
      expect(report.result.ok, JSON.stringify(report.result)).toBe(true);
      return report.result.ok ? readEntrypointOutput(report.result.data) as { value: any } : undefined;
    };
    expect(inspectAggregateProjectStructure(projectDir).entries.map(entry => entry.projectType)).toEqual(["workflow", "workflow"]);
    const unavailable = await runLocalProjectWithReport({ projectDir, entryId: "writer", args: ["--action", "write"], databaseResolver });
    expect(unavailable.status).toBe("failed");
    expect(registry.read().spaces).toHaveLength(0);
    const request = registry.request({ projectId, entryId: "writer", alias: "data", target: { kind: "create", name: "Demo shared space" }, permissions: { kv: { read: {mode:'all'}, write: {mode:'all'} }, knowledge: { read: {mode:'all'}, write: {mode:'all'} } } });
    expect(registry.read().spaces).toHaveLength(0);
    const approved = registry.review(request.requestId, { approve: true });
    await bindProjectDatabase(projectDir, "writer", "data", approved.databaseId!);
    const spaceId = registry.authorization(approved.bindingRef!)!.space.spaceId;
    const grant = async (target: string, consumerProjectId: string, entryId: string) => {
      const request = registry.request({ projectId: consumerProjectId, entryId, alias: "data", target: { kind: "access", spaceId }, permissions: { kv: { read: {mode:'all'}, write: {mode:'all'} }, knowledge: { read: {mode:'all'}, write: {mode:'all'} } } });
      const approved = registry.review(request.requestId, { approve: true });
      await bindProjectDatabase(target, entryId, "data", approved.databaseId!);
      return registry.authorization(approved.bindingRef!)!;
    };
    await grant(projectDir, projectId, "reader");
    expect((await run("writer", "write"))?.value).toMatchObject({ kv: "shared", document: { markdown: "shared" } });
    expect((await run("reader", "read"))?.value).toMatchObject({ kv: "shared", document: { markdown: "shared" } });
    expect((await run("writer", "call"))?.value).toMatchObject({ value: { kv: "shared" } });
    const otherDir = path.join(directory, "other");
    await cp(projectDir, otherDir, { recursive: true });
    manifest.id = randomUUID();
    await writeFile(path.join(otherDir, "package.json"), JSON.stringify(manifest));
    const other = await grant(otherDir, manifest.id, "reader");
    expect((await run("reader", "read", otherDir))?.value).toMatchObject({ kv: "shared", document: { markdown: "shared" } });
    registry.revoke(other.grant.grantId);
    const revoked = await runLocalProjectWithReport({ projectDir: otherDir, entryId: "reader", databaseResolver });
    expect(revoked.status).toBe("failed");
    expect(registry.read().spaces).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
