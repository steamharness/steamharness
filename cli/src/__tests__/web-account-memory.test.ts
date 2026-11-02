import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebAccountMemory } from "../web/account-memory";
import type { Project } from "../web/workflow-types";
import type { WebConnection } from "../web/runtime";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "host-memory-"));
  roots.push(root);
  const folder = path.join(root, "project");
  await mkdir(folder);
  return {
    root,
    folder,
    project: { id: "real-project", folderPath: folder } as Project,
  };
}
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      errCode: status === 200 ? 0 : status,
      errMessage: status === 200 ? "" : "Denied",
      data,
    }),
    { status },
  );
test("host grants use the real project, clear uses only the scoped token and current scope", async () => {
  const { root, project } = await fixture();
  const calls: { endpoint: string; body: any; token: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    calls.push({
      endpoint: String(url),
      body: init?.body ? JSON.parse(init.body) : {},
      token: new Headers(init?.headers).get("Authorization"),
    });
    return response(
      String(url).endsWith("/grants")
        ? {
            token: "shmu_scoped",
            scope: "project:real-project",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          }
        : { ok: true },
    );
  });
  const memory = new WebAccountMemory(
    root,
    () => ({
      serverUrl: "https://server.test",
      accessToken: "project-key",
      memoryToken: "shma_host-only",
    }),
    () => "user",
  );
  await memory.call(project, "clear", {
    scope: "project:unauthorized",
    operationId: "stable",
  });
  expect(calls[0].body.scope).toBe("project:real-project");
  expect(calls[0].token).toBe("Bearer shma_host-only");
  expect(calls[1].body.scope).toBe("project:real-project");
  expect(calls[1].token).toBe("Bearer shmu_scoped");
});

test.each([false, true])("existing sessions authorize memory with an expired manager token: %s", async (expiredToken) => {
  const { root, project } = await fixture();
  const connection: WebConnection = { serverUrl: "https://server.test", accessToken: "project-key", memorySessionCookie: "wf_session=legacy-host-only",
    ...(expiredToken ? { memoryToken: "shma_expired" } : {}) };
  const calls: { endpoint: string; headers: Headers; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    const headers = new Headers(init.headers), endpoint = String(url);
    calls.push({ endpoint, headers, body: init.body && JSON.parse(init.body) });
    if (headers.get("Authorization") === "Bearer shma_expired") return response({}, 401);
    if (endpoint.endsWith("/grants")) {
      expect(headers.get("Cookie")).toBe(connection.memorySessionCookie);
      expect(headers.has("Authorization")).toBe(false);
      return response({ token: "shmu_current", scope: "project:real-project" });
    }
    expect(headers.get("Authorization")).toBe("Bearer shmu_current");
    expect(headers.has("Cookie")).toBe(false);
    return response(endpoint.includes("/memories?") ? { items: [] } : { cleared: true });
  });
  const memory = new WebAccountMemory(root, () => connection, () => "user");
  await expect(memory.call(project, "list", { scope: "current" })).resolves.toEqual({ items: [] });
  await memory.call(project, "clear", { scope: "current", operationId: "clear-session" });
  expect(calls.some(call => call.headers.get("Authorization") === "Bearer project-key")).toBe(false);
  expect(new URL(calls.find(call => call.endpoint.includes("/memories?"))!.endpoint).searchParams.get("scope")).toBe("project:real-project");
  expect(calls.at(-1)!.body.scope).toBe("project:real-project");
});

test("permission denials and expired scoped tokens never fall back to account sessions", async () => {
  const { root, project } = await fixture();
  const connection = { serverUrl: "https://server.test", accessToken: "key", memoryToken: "shma_host", memorySessionCookie: "wf_session=host-only" };
  const headers: Headers[] = [];
  let grantDenied = true;
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    headers.push(new Headers(init.headers));
    if (String(url).endsWith("/grants")) return grantDenied ? response({}, 403) : response({ token: "shmu_expired", scope: "project:real-project" });
    return response({}, 401);
  });
  const memory = new WebAccountMemory(root, () => connection, () => "user");
  await expect(memory.grant(project)).rejects.toMatchObject({ status: 403 });
  expect(headers).toHaveLength(1);
  grantDenied = false;
  await expect(memory.call(project, "clear", { scope: "current" })).rejects.toMatchObject({ status: 401 });
  expect(headers).toHaveLength(3);
  expect(headers.every(value => !value.has("Cookie"))).toBe(true);
  expect(headers.at(-1)!.get("Authorization")).toBe("Bearer shmu_expired");
});

test("a project API key alone reports missing memory authorization without contacting the server", async () => {
  const { root, project } = await fixture();
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const memory = new WebAccountMemory(root, () => ({ serverUrl: "https://server.test", accessToken: "project-key" }), () => "user");
  await expect(memory.call(project, "capabilities")).rejects.toMatchObject({ status: 401 });
  await expect(memory.grant(project)).rejects.toMatchObject({ status: 401 });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(["cookie", "user"])("session grant responses are discarded after the %s changes", async (changed) => {
  const { root, project } = await fixture();
  let cookie = "wf_session=old", userId = "user-a";
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", () => new Promise(resolve => { finish = resolve; }));
  const memory = new WebAccountMemory(root, () => ({ serverUrl: "https://server.test", accessToken: "key", memorySessionCookie: cookie }), () => userId);
  const pending = memory.grant(project);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  if (changed === "cookie") cookie = "wf_session=new";
  else userId = "user-b";
  finish(response({ token: "shmu_old", scope: "project:real-project" }));
  await expect(pending).rejects.toThrow("Account changed");
});
test("unregistered folders keep a stable host identity and forbidden projects never downgrade to directories", async () => {
  const { root, project } = await fixture();
  const ids: string[] = [];
  let denied = false;
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    const b = JSON.parse(init.body);
    if (b.scope) return response({}, denied ? 403 : 404);
    ids.push(b.directoryId);
    return response({
      token: "shmu_dir",
      scope: "directory:" + b.directoryId,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
  });
  const memory = new WebAccountMemory(
    root,
    () => ({
      serverUrl: "https://server.test",
      accessToken: "project-key",
      memoryToken: "shma_host-only",
    }),
    () => "user",
  );
  await memory.grant(project);
  await memory.grant(project);
  expect(ids[0]).toBe(ids[1]);
  denied = true;
  await expect(memory.grant(project)).rejects.toMatchObject({ status: 403 });
  expect(ids.length).toBe(2);
  const other = new WebAccountMemory(
    path.join(root, "device-b"),
    () => ({
      serverUrl: "https://server.test",
      accessToken: "project-key",
      memoryToken: "shma_host-only",
    }),
    () => "user",
  );
  denied = false;
  await other.grant(project);
  expect(ids[2]).not.toBe(ids[0]);
});
test("assistant scope follows its work directory manifest and stale account grants are discarded", async () => {
  const { root, folder, project } = await fixture();
  await writeFile(
    path.join(folder, "steamharness.json"),
    JSON.stringify({ id: "business-project" }),
  );
  project.assistant = { workdir: folder, roots: [] };
  let current = "shma_a";
  let finish!: (value: Response) => void;
  let body: any;
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return new Promise((resolve) => (finish = resolve));
  });
  const memory = new WebAccountMemory(
    root,
    () => ({
      serverUrl: "https://server.test",
      accessToken: "key",
      memoryToken: current,
    }),
    () => "user",
  );
  const pending = memory.grant(project);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(body.scope).toBe("project:business-project");
  current = "shma_b";
  finish(response({ scope: "project:business-project", token: "shmu_old" }));
  await expect(pending).rejects.toThrow("Account changed");
});

test("temporary capability failures retain only the same account and project, while revocations clear access", async () => {
  const { root, project } = await fixture();
  let token = "shma_a";
  let status = 200;
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    if (String(url).endsWith("/grants")) {
      const { scope } = JSON.parse(init.body);
      return response({ token: "shmu_scoped", scope });
    }
    return response({ connected: true, enabled: true, status: "ready", currentScope: "project:real-project", scopes: ["global", "project:real-project"] }, status);
  });
  const memory = new WebAccountMemory(root, () => ({ serverUrl: "https://server.test", accessToken: "key", memoryToken: token }), () => "user");
  await memory.call(project, "capabilities");
  status = 503;
  await expect(memory.call(project, "capabilities")).resolves.toMatchObject({ status: "unavailable", enabled: true });
  await expect(memory.call({ ...project, id: "other-project" }, "capabilities")).rejects.toMatchObject({ status: 503 });
  for (status of [401, 403, 404])
    await expect(memory.call(project, "capabilities")).rejects.toMatchObject({ status });
  token = "shma_b";
  status = 503;
  await expect(memory.call(project, "capabilities")).rejects.toMatchObject({ status: 503 });
});
