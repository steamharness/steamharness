import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import pg from "pg";
import { AccountRepository } from "../account-db";
import { AuthService } from "../account-auth";
import { configureProjectAuthContext } from "../auth";
import { DatabaseRepository } from "../persistence";
import { Storage } from "../storage";
import { LocalStorage } from "../local-storage";
import { ArtifactStorage } from "../persistence";
import { createApiRouter } from "../routes/api";
import type { ResourceInvitation } from "../project-access";
import type { AccessActor } from "@steamharness/project-access";
import { createDefaultProjectInfo } from "@steamharness/project-info";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL;
test("PostgreSQL startup initializes access columns on existing account and project tables", {
  skip: !databaseUrl, timeout: 30_000,
}, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `acl_init_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create schema ${schema}`);
  const connection = new URL(databaseUrl!);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const url = connection.toString();
  const accounts = new AccountRepository(url);
  const db = new DatabaseRepository(url);
  const pool = new pg.Pool({ connectionString: url });
  const auth = new AuthService({ databaseUrl: url, accountDb: accounts });
  try {
    await accounts.init();
    await db.init();
    const session = await auth.signInBootstrapAdmin({ email: "admin@init.test", password: "init-test-password" });
    await accounts.upsertUserProfile({ userId: "ordinary", email: "ordinary@init.test" });
    await pool.query("insert into projects(id,name,project_type,owner_user_id) values('existing','Existing','workflow',$1)", [session.user.userId]);
    await pool.query("insert into project_members(project_id,user_id,role) values('existing',$1,'owner')", [session.user.userId]);
    // Retired source-download requests are neither read nor migrated into membership requests.
    await pool.query(`create table project_access_requests (
      id text primary key,project_id text not null references projects(id),requester_user_id text not null,
      capability text not null,reason text not null,status text not null,
      resolved_by_user_id text,resolved_at timestamptz,created_at timestamptz not null,updated_at timestamptz not null);
      create unique index project_access_requests_pending_idx on project_access_requests(project_id,requester_user_id,capability) where status='pending';
      insert into project_access_requests(id,project_id,requester_user_id,capability,reason,status,created_at,updated_at)
      values('retired','existing','ordinary','source.download','Retired request','pending',now(),now())`);
    await pool.query("alter table user_profiles drop column is_system_admin; alter table projects drop column group_id");
    await assert.rejects(auth.signInWithPassword({ email: "admin@init.test", password: "init-test-password" }), /is_system_admin/);
    await assert.rejects(db.access.resolve("project", "existing", { userId: session.user.userId, isSystemAdmin: false }), /group_id/);

    for (let attempt = 0; attempt < 2; attempt++) {
      await accounts.init();
      await db.init();
    }
    assert.equal((await accounts.getUserProfileOrThrow("ordinary")).isSystemAdmin, false);
    assert.equal((await db.getProject("existing"))?.groupId, null);
    assert.equal((await db.access.resolve("project", "existing", { userId: session.user.userId, isSystemAdmin: false })).effectiveRole, "owner");
    const login = await auth.signInBootstrapAdmin({ email: "admin@init.test", password: "init-test-password" });
    assert.equal((await accounts.getUserProfileOrThrow(login.user.userId)).isSystemAdmin, true);
    assert.equal((await auth.getUserByAccessToken(session.accessToken)).user.userId, login.user.userId);
    const actor = { userId: login.user.userId, isSystemAdmin: false };
    const group = await db.access.createGroup({ name: "Initialized group" }, actor);
    await db.access.transferProject("existing", group.id, actor);
    await accounts.init();
    await db.init();
    assert.equal((await db.getProject("existing"))?.groupId, group.id);
    assert.equal((await db.listProjects())[0]?.groupId, group.id);
    assert.equal((await accounts.getUserProfileOrThrow(login.user.userId)).isSystemAdmin, true);
    assert.equal((await pool.query("select count(*)::int as count from user_profiles")).rows[0].count, 2);
    await assert.rejects(pool.query("update projects set group_id='missing' where id='existing'"), /foreign key/);
    assert.deepEqual(await db.listProjectAccessRequests("existing"), []);
    assert.equal(await db.getProjectMember("existing", "ordinary"), undefined);
    const submitted = await db.createProjectAccessRequest({ id: "membership", projectId: "existing", requesterUserId: "ordinary", reason: "Guest access" });
    const duplicate = await db.createProjectAccessRequest({ id: "duplicate", projectId: "existing", requesterUserId: "ordinary", reason: "Again" });
    assert.equal(duplicate.id, submitted.id);
    assert.equal((await db.resolveProjectAccessRequest({ projectId: "existing", requestId: submitted.id, status: "approved", actor }))?.status, "approved");
    assert.equal((await db.getProjectMember("existing", "ordinary"))?.role, "guest");
    assert.equal((await pool.query("select capability,status from project_access_requests where id='retired'")).rows[0].status, "pending");
  } finally {
    await auth.close();
    await db.close();
    await accounts.close();
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});

test(
  "PostgreSQL roles, hierarchy, invitations, ownership concurrency and HTTP/API-key revocation",
  { skip: !databaseUrl, timeout: 120_000 },
  async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schema = `acl_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create schema ${schema}`);
    const connection = new URL(databaseUrl!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const url = connection.toString();
    const accounts = new AccountRepository(url);
    const db = new DatabaseRepository(url);
    const auth = new AuthService({ databaseUrl: url, accountDb: accounts });
    const pool = new pg.Pool({ connectionString: url });
    const root = await mkdtemp(path.join(tmpdir(), "steamharness-acl-"));
    const objects = new LocalStorage({
      root: path.join(root, "objects"),
      publicBaseUrl: "http://localhost/",
    });
    const storage = new Storage({
      db,
      dataRoot: root,
      objectStorage: objects,
      artifacts: new ArtifactStorage(objects),
      serverRoot: process.cwd(),
      repoRoot: process.cwd(),
    });
    const server = createServer();
    let base = "";
    const previousAdminKey = process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    const systemAdminKey = randomUUID();
    process.env.STEAMHARNESS_SERVER_ADMIN_KEY = systemAdminKey;
    try {
      await accounts.init();
      await db.init();
      const bootstrap = await auth.signInBootstrapAdmin({
        email: "sysadmin@acl.test",
        password: "system-password",
      });
      const actors: Record<string, AccessActor> = {};
      const tokens: Record<string, string> = {};
      tokens.system = systemAdminKey;
      const cookies: Record<string, string> = {};
      for (const name of ["alice", "bob", "carol", "dave", "eve"]) {
        const invited = await auth.inviteUser({
          email: `${name}@acl.test`,
          displayName: name,
          redirectTo: "https://acl.test",
        });
        const session = await auth.acceptInvitation({
          token: new URL(invited.invitationLink!).pathname.split("/").at(-1)!,
          password: "test-password",
        });
        actors[name] = { userId: session.user.userId, isSystemAdmin: false };
        tokens[name] = (
          await accounts.createApiKey({
            userId: session.user.userId,
            name: "CLI",
            source: "cli",
          })
        ).token;
        auth.setAuthCookie(
          {
            append(_name, value) {
              cookies[name] = value.split(";")[0]!;
            },
          },
          session,
        );
      }
      const alice = actors.alice!,
        bob = actors.bob!,
        carol = actors.carol!,
        dave = actors.dave!,
        eve = actors.eve!;
      const top = await db.access.createGroup({ name: "Organization" }, alice);
      const child = await db.access.createGroup(
        { name: "Engineering", parentId: top.id },
        alice,
      );
      const leaf = await db.access.createGroup(
        { name: "Platform", parentId: child.id },
        alice,
      );
      await db.access.setMember(
        "group",
        top.id,
        bob.userId!,
        "developer",
        alice,
      );
      await db.access.setMember("group", child.id, bob.userId!, "guest", alice);
      await db.access.setMember(
        "group",
        top.id,
        carol.userId!,
        "maintainer",
        alice,
      );
      assert.equal(
        (await db.access.resolve("group", leaf.id, bob)).effectiveRole,
        "developer",
      );
      await assert.rejects(
        db.access.createGroup({ name: "Forbidden", parentId: child.id }, bob),
        /Permission denied/,
      );
      await assert.rejects(
        db.access.setMember("group", top.id, alice.userId!, "guest", carol),
        /Permission denied/,
      );
      await assert.rejects(
        db.access.setMember("group", top.id, eve.userId!, "maintainer", carol),
        /Permission denied/,
      );
      const projectId = randomUUID();
      const info = createDefaultProjectInfo();
      await storage.createProject({
        projectId,
        projectName: "Team project",
        projectType: "workflow",
        projectInfo: info,
        ownerUserId: bob.userId,
        groupId: leaf.id,
      });
      assert.equal((await db.getProject(projectId))?.groupId, leaf.id);
      assert.equal((await db.listProjects()).find(project => project.id === projectId)?.groupId, leaf.id);
      assert.equal(
        (await db.access.resolve("project", projectId, bob)).effectiveRole,
        "developer",
      );
      assert.equal((await db.listProjectMemberRecords(projectId)).length, 0);
      await db.access.setMember(
        "project",
        projectId,
        bob.userId!,
        "guest",
        alice,
      );
      await db.access.setMember(
        "project",
        projectId,
        bob.userId!,
        undefined,
        alice,
      );
      assert.equal(
        (await db.access.resolve("project", projectId, bob)).effectiveRole,
        "developer",
      );
      const members = await db.access.listMembers("project", projectId, alice, {
        pageSize: 1,
      });
      assert.ok(members.total >= 3);
      assert.equal(members.items.length, 1);
      const personal = randomUUID();
      await storage.createProject({
        projectId: personal,
        projectName: "Personal",
        projectType: "workflow",
        projectInfo: info,
        ownerUserId: dave.userId,
      });
      assert.equal(
        (await db.access.resolve("project", personal, bob)).effectiveRole,
        null,
      );
      await db.access.setMember(
        "project",
        personal,
        bob.userId!,
        "guest",
        dave,
      );
      assert.equal(
        (await db.access.resolve("project", personal, bob)).effectiveRole,
        "guest",
      );
      const invitation = await db.access.createInvitation(
        "group",
        top.id,
        "developer",
        carol,
      );
      await db.access.setMember("group", top.id, carol.userId!, "guest", alice);
      await assert.rejects(
        db.access.acceptInvitation(invitation.token, eve.userId!),
        /permission/i,
      );
      const preserve = await db.access.createInvitation(
        "project",
        personal,
        "guest",
        dave,
      );
      await db.access.setMember(
        "project",
        personal,
        bob.userId!,
        "maintainer",
        dave,
      );
      await db.access.acceptInvitation(preserve.token, bob.userId!);
      assert.equal(
        (await db.access.resolve("project", personal, bob)).effectiveRole,
        "maintainer",
      );
      const ownerInvite = await db.access.createInvitation(
        "project",
        personal,
        "owner",
        dave,
      );
      await db.access.acceptInvitation(ownerInvite.token, alice.userId!);
      const demotions = await Promise.allSettled([
        db.access.setMember("project", personal, dave.userId!, "guest", dave),
        db.access.setMember("project", personal, alice.userId!, "guest", alice),
      ]);
      assert.equal(demotions.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (await db.listProjectMemberRecords(personal)).filter(
          (m) => m.role === "owner",
        ).length,
        1,
      );
      await assert.rejects(
        db.access.updateGroup(top.id, { parentId: leaf.id }, alice),
        /cannot contain/,
      );
      await assert.rejects(db.access.deleteGroup(top.id, alice), /empty group/);
      await assert.rejects(
        db.access.transferProject(projectId, null, bob),
        /Permission denied/,
      );
      const destination = await db.access.createGroup({ name: "Other" }, dave);
      await assert.rejects(
        db.access.transferProject(projectId, destination.id, alice),
        /Permission denied/,
      );
      await db.access.setMember(
        "group",
        destination.id,
        alice.userId!,
        "owner",
        dave,
      );
      await db.access.transferProject(projectId, destination.id, alice);
      assert.equal(
        (await db.access.resolve("project", projectId, bob)).effectiveRole,
        null,
      );
      await db.access.transferProject(projectId, null, alice);
      assert.equal(
        (await db.access.resolve("project", projectId, alice)).effectiveRole,
        "owner",
      );
      await assert.rejects(
        accounts.updateUserProfile(alice.userId!, { status: "disabled" }),
        /ownership/,
      );
      await assert.rejects(
        auth.updateAuthUser({ userId: alice.userId!, disabled: true }),
        /ownership/,
      );
      assert.equal((await auth.getUserById(alice.userId!)).disabled, false);
      assert.equal(
        (await accounts.getUserProfile(alice.userId!))!.status,
        "active",
      );
      await assert.rejects(
        auth.updateAuthUser({ userId: bootstrap.user.userId, disabled: true }),
        /last system/,
      );
      assert.equal(
        (await auth.getUserById(bootstrap.user.userId)).disabled,
        false,
      );
      // Source metadata in an upload cannot overwrite the project's management fields.
      await db.access.setMember(
        "project",
        projectId,
        bob.userId!,
        "developer",
        alice,
      );
      const coreRequirement = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
      ).dependencies.steamharness as string;
      const coreVersion = coreRequirement.startsWith("link:")
        ? JSON.parse(
            await readFile(
              new URL(
                `${coreRequirement.slice(5)}/package.json`,
                new URL("../../", import.meta.url),
              ),
              "utf8",
            ),
          ).version
        : coreRequirement;
      const source = {
        id: projectId,
        name: "Unauthorized rename",
        version: "1.0.0",
        devDependencies: { steamharness: coreVersion },
        steamHarness: { projectType: "workflow", projectInfo: info },
      };
      await storage.saveDraftFiles({
        projectName: projectId,
        files: [
          { path: "package.json", content: JSON.stringify(source) },
          { path: "index.ts", content: 'throw new Error("must not execute")' },
          { path: "configuration.json", content: JSON.stringify({ version: 1, fields: [{ name: "endpoint", type: "string" }] }) },
        ],
      });
      assert.equal((await db.getProject(projectId))!.name, "Team project");
      await storage.publish({
        projectName: projectId,
        createdByUserId: bob.userId,
      });
      configureProjectAuthContext({ accountDb: accounts, authService: auth });
      const app = express();
      app.use("/api", createApiRouter(storage));
      server.on("request", app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      async function request(
        name: string,
        endpoint: string,
        method = "GET",
        body?: unknown,
        cookie = false,
      ) {
        return fetch(`${base}/api${endpoint}`, {
          method,
          headers: {
            ...(cookie
              ? { Cookie: cookies[name]! }
              : { Authorization: `Bearer ${tokens[name]}` }),
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      }
      const published = await request("bob", `/projects/${projectId}`);
      assert.equal(published.status, 200);
      assert.equal(
        (await published.json()).data.access.effectiveRole,
        "developer",
      );
      // Bearer invitations may only be enumerated by actors allowed to grant their role.
      for (const [type, resourceId] of [["project", projectId], ["group", top.id]] as const) {
        await db.access.setMember(type, resourceId, carol.userId!, "maintainer", alice);
        const endpoint = `/${type === "project" ? "projects" : "groups"}/${resourceId}/invitations`;
        const created: ResourceInvitation[] = [];
        for (const role of ["guest", "developer", "maintainer", "owner"] as const) {
          const response = await request("alice", endpoint, "POST", { role });
          assert.equal(response.status, 200);
          created.push((await response.json()).data.invitation);
        }
        for (const cookie of [false, true]) {
          const response = await request("carol", endpoint, "GET", undefined, cookie);
          assert.equal(response.status, 200);
          const visible = (await response.json()).data;
          assert.ok(visible.every((item: { role: string }) => ["guest", "developer"].includes(item.role)));
          for (const item of created) {
            assert.equal(visible.some((row: { id: string }) => row.id === item.id), ["guest", "developer"].includes(item.role));
            if (["maintainer", "owner"].includes(item.role)) assert.ok(!JSON.stringify(visible).includes(item.token));
          }
        }
        for (const name of ["alice", "system"]) {
          const visible = (await (await request(name, endpoint)).json()).data;
          assert.ok(created.every(item => visible.some((row: { id: string }) => row.id === item.id)));
        }
        for (const item of created.filter(item => ["maintainer", "owner"].includes(item.role))) {
          assert.equal((await request("carol", `${endpoint}/${item.id}`, "DELETE")).status, 403);
          assert.equal((await request("carol", endpoint, "POST", { role: item.role })).status, 403);
        }
        assert.equal((await db.access.resolve(type, resourceId, carol)).effectiveRole, "maintainer");
      }
      assert.equal(
        (
          await request("bob", `/projects/${projectId}/visibility`, "PATCH", {
            visibility: "public",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("alice", `/projects/${projectId}/visibility`, "PATCH", {
            visibility: "public",
          })
        ).status,
        200,
      );
      assert.equal(
        (await db.access.resolve("project", projectId, eve)).effectiveRole,
        "guest",
      );
      assert.equal(
        await db.getProjectMember(projectId, eve.userId!),
        undefined,
      );
      assert.equal(
        (await request("eve", `/projects/${projectId}/source-files`)).status,
        200,
      );
      assert.equal(
        (await request("eve", `/projects/${projectId}/files?target=draft`))
          .status,
        403,
      );
      assert.equal(
        (await request("eve", `/projects/${projectId}/kv`)).status,
        200,
      );
      for (const [endpoint, method, body] of [
        [`/projects/${projectId}/draft/files`, "PUT", { files: [] }],
        [
          `/projects/${projectId}/knowledge-documents`,
          "POST",
          { title: "Unauthorized", markdown: "write" },
        ],
        [
          `/projects/${projectId}/kanban/bridge`,
          "POST",
          {
            call: {
              requestId: "bad",
              operation: "kv.setValue",
              input: { key: "x", value: 1 },
            },
          },
        ],
        [
          "/project-storage",
          "POST",
          {
            projectId,
            storageKind: "kv",
            operation: "set",
            entry: { scope: "project", projectId, key: "x" },
            value: 1,
          },
        ],
      ] as const)
        assert.equal(
          (await request("eve", endpoint, method, body)).status,
          403,
          endpoint,
        );
      assert.equal(
        (await request("eve", `/projects/${projectId}/files`, "POST", {}))
          .status,
        403,
      );
      await storage.updateProjectVisibility({
        projectId,
        visibility: "private",
      });
      for (const cookie of [false, true])
        assert.equal(
          (
            await request(
              "eve",
              `/projects/${projectId}/source-files`,
              "GET",
              undefined,
              cookie,
            )
          ).status,
          403,
        );
      // A system key has no user ID; retain its administrator identity through approval.
      const systemRequest = await db.createProjectAccessRequest({
        id: randomUUID(), projectId, requesterUserId: eve.userId!, reason: "System key review",
      });
      assert.equal((await request("bob", `/projects/${projectId}/access-requests/${systemRequest.id}`, "PATCH", { status: "approved" })).status, 403);
      assert.equal((await request("system", `/projects/${projectId}/access-requests/${systemRequest.id}`, "PATCH", { status: "approved" })).status, 200);
      assert.equal((await db.getProjectAccessRequest(projectId, systemRequest.id))?.resolvedByUserId, undefined);
      assert.equal((await db.getProjectMember(projectId, eve.userId!))?.role, "guest");
      await db.access.setMember("project", projectId, eve.userId!, undefined, alice);
      const deniedShare = await request(
        "eve",
        `/projects/${projectId}/source-share?target=1.0.0`,
      );
      assert.equal(deniedShare.status, 403);
      const requestUrl = new URL((await deniedShare.json()).data.requestUrl);
      const requestToken = requestUrl.pathname.split("/").at(-1)!;
      const submitted = await request(
        "eve",
        `/project-access/${requestToken}/requests`,
        "POST",
        { reason: "Need read access" },
      );
      assert.equal(submitted.status, 201);
      const accessRequest = (await submitted.json()).data;
      await db.access.setMember(
        "project",
        projectId,
        carol.userId!,
        "maintainer",
        alice,
      );
      assert.equal(
        (
          await request(
            "carol",
            `/projects/${projectId}/access-requests/${accessRequest.id}`,
            "PATCH",
            { status: "approved" },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            "eve",
            `/projects/${projectId}/source-share?target=1.0.0`,
          )
        ).status,
        200,
      );
      assert.equal(
        (await db.access.resolve("project", projectId, eve)).effectiveRole,
        "guest",
      );
      await db.access.setMember(
        "project",
        projectId,
        eve.userId!,
        undefined,
        alice,
      );
      for (const cookie of [false, true])
        assert.equal(
          (
            await request(
              "eve",
              `/projects/${projectId}`,
              "GET",
              undefined,
              cookie,
            )
          ).status,
          403,
        );
      // A project relationship never grants its caller a target-project role.
      const boardId = randomUUID();
      const boardInfo = {
        ...info,
        relatedProjects: [
          {
            alias: "records",
            projectId,
            grantToRelatedProject: {
              read: { mode: "all" as const },
              write: { mode: "all" as const },
            },
          },
        ],
      };
      await storage.createProject({
        projectId: boardId,
        projectName: "Board",
        projectType: "kanban",
        projectInfo: boardInfo,
        ownerUserId: alice.userId,
      });
      await storage.setRelatedProject({
        projectId: boardId,
        alias: "records",
        targetProjectId: projectId,
        grantToRelatedProject: {
          read: { mode: "all" },
          write: { mode: "all" },
        },
        updateTarget: true,
        targetAlias: "board",
        targetGrantToRelatedProject: {
          read: { mode: "all" },
          write: { mode: "all" },
        },
      });
      const boardPackage = {
        id: boardId,
        name: "Board",
        version: "1.0.0",
        devDependencies: { steamharness: coreVersion },
        steamHarness: {
          projectType: "kanban",
          projectInfo: boardInfo,
          kanban: {},
        },
      };
      await storage.saveDraftFiles({
        projectName: boardId,
        files: [
          { path: "package.json", content: JSON.stringify(boardPackage) },
          {
            path: "index.html",
            content: "<!doctype html><title>Board</title>",
          },
        ],
      });
      await storage.publish({
        projectName: boardId,
        createdByUserId: alice.userId,
      });
      await db.access.setMember(
        "project",
        boardId,
        eve.userId!,
        "developer",
        alice,
      );
      const bridge = (operation: string) =>
        request("eve", `/projects/${boardId}/kanban/bridge`, "POST", {
          target: "1.0.0",
          call: {
            requestId: randomUUID(),
            operation,
            input: {
              alias: "records",
              key: "record",
              ...(operation.endsWith("setValue") ? { value: 1 } : {}),
            },
          },
        });
      assert.equal((await bridge("relatedProject.kv.getValue")).status, 403);
      const hiddenRelations = await request(
        "eve",
        `/projects/${boardId}/related-projects`,
      );
      assert.equal(
        (await hiddenRelations.json()).data.relatedProjects.length,
        0,
      );
      await db.access.setMember(
        "project",
        projectId,
        eve.userId!,
        "guest",
        alice,
      );
      assert.equal((await bridge("relatedProject.kv.getValue")).status, 200);
      assert.equal((await bridge("relatedProject.kv.setValue")).status, 403);
      await db.access.setMember(
        "project",
        projectId,
        eve.userId!,
        "developer",
        alice,
      );
      assert.equal((await bridge("relatedProject.kv.setValue")).status, 200);
      await db.access.setMember(
        "project",
        projectId,
        eve.userId!,
        undefined,
        alice,
      );
      assert.equal((await bridge("relatedProject.kv.getValue")).status, 403);
      await pool.query("update projects set has_draft=false where id=$1", [projectId]);
      await rm(path.join(root, "projects", projectId, "draft"), { recursive: true, force: true });
      for (const name of ["alice", "bob", "carol"]) {
        const response = await request(name, `/projects/${projectId}/configurations?target=1.0.0`);
        assert.equal(response.status, 200);
        const state = (await response.json()).data;
        assert.equal(state.publicationRevision, undefined);
        assert.equal((await request(name, `/projects/${projectId}/configurations`, "POST", {
          target: "1.0.0", call: { action: "save", revision: state.revision, id: state.activeConfigurationId, values: { endpoint: `${name}.test` } },
        })).status, 200);
      }
      await accounts.updateUserProfile(bob.userId!, { status: "disabled" });
      for (const cookie of [false, true])
        assert.ok(
          [401, 403].includes(
            (
              await request(
                "bob",
                `/projects/${projectId}`,
                "GET",
                undefined,
                cookie,
              )
            ).status,
          ),
        );
      await assert.rejects(
        accounts.setSystemAdministrator(bootstrap.user.userId, false),
        /last system/,
      );
    } finally {
      if (previousAdminKey === undefined) delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      else process.env.STEAMHARNESS_SERVER_ADMIN_KEY = previousAdminKey;
      configureProjectAuthContext({});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await storage.close();
      await accounts.close();
      await auth.close();
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
