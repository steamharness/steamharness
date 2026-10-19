import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runLocalProjectWithReport,
  type KVStore,
} from "../index";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("local, server, and both declarations enforce their storage boundaries", async () => {
  const localStore = createMemoryKVStore();
  const serverStore = createMemoryKVStore();
  const projects = await Promise.all([
    createStorageProject("local"),
    createStorageProject("server"),
    createStorageProject("both"),
  ]);

  try {
    const localReport = await runStorageProject(projects[0]!, "local", localStore, serverStore);
    assert.equal(localReport.status, "success");
    assert.equal(localStore.values.get(`kv:project:${PROJECT_ID}:value`), "local");

    const deniedServer = await runStorageProject(projects[0]!, "server", localStore, serverStore);
    assert.equal(deniedServer.status, "failed");
    assert.match(readReportError(deniedServer), /does not allow server storage access/);

    const serverReport = await runStorageProject(projects[1]!, "server", localStore, serverStore);
    assert.equal(serverReport.status, "success");
    assert.equal(serverStore.values.get(`kv:project:${PROJECT_ID}:value`), "server");
    assert.equal(
      serverStore.sources.get(`kv:project:${PROJECT_ID}:value`)?.projectId,
      PROJECT_ID,
    );
    assert.equal(
      serverStore.sources.get(`persistent_value:project:${PROJECT_ID}:updated-value`)?.projectId,
      PROJECT_ID,
    );

    const bothLocal = await runStorageProject(projects[2]!, "local", localStore, serverStore);
    const bothServer = await runStorageProject(projects[2]!, "server", localStore, serverStore);
    assert.equal(bothLocal.status, "success");
    assert.equal(bothServer.status, "success");
  } finally {
    await Promise.all(projects.map((project) => rm(project, { recursive: true, force: true })));
  }
});

test("both mode stays usable offline until server storage is accessed", async () => {
  const projectDir = await createStorageProject("both");
  try {
    const local = await runLocalProjectWithReport({
      projectDir,
      args: ["--target", "local"],
      storage: {
        host: "local",
        local: {
          kvStore: createMemoryKVStore(),
          persistentValueStore: createMemoryKVStore(),
        },
      },
      env: {} as NodeJS.ProcessEnv,
    });
    assert.equal(local.status, "success");

    const server = await runLocalProjectWithReport({
      projectDir,
      args: ["--target", "server"],
      storage: {
        host: "local",
        local: {
          kvStore: createMemoryKVStore(),
          persistentValueStore: createMemoryKVStore(),
        },
      },
      env: {} as NodeJS.ProcessEnv,
    });
    assert.equal(server.status, "failed");
    assert.match(readReportError(server), /authenticated server connection/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("legacy storage declarations are rejected and removed context getters are absent", async () => {
  const legacyDir = await createStorageProject(undefined);
  const migratedDir = await createStorageProject("local", true);
  try {
    await assert.rejects(
      () => runLocalProjectWithReport({ projectDir: legacyDir }),
      /dataStorage\.mode must be declared before this project can run or access data/,
    );

    const report = await runLocalProjectWithReport({
      projectDir: migratedDir,
      storage: { host: "local", local: { kvStore: createMemoryKVStore() } },
    });
    assert.equal(report.status, "success");
  } finally {
    await Promise.all([
      rm(legacyDir, { recursive: true, force: true }),
      rm(migratedDir, { recursive: true, force: true }),
    ]);
  }
});

async function runStorageProject(
  projectDir: string,
  target: "local" | "server",
  localStore: KVStore,
  serverStore: KVStore,
) {
  return runLocalProjectWithReport({
    projectDir,
    args: ["--target", target],
    storage: {
      host: "local",
      local: { kvStore: localStore, persistentValueStore: localStore },
      server: {
        kvStore: serverStore,
        persistentValueStore: serverStore,
      },
    },
  });
}

async function createStorageProject(
  mode: "local" | "server" | "both" | undefined,
  useLegacyGetter = false,
): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-storage-context-"));
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    id: PROJECT_ID,
    name: "@steamharness/storage-context-test",
    type: "module",
    ...(mode === undefined
      ? {}
      : { steamHarness: { projectInfo: { dataStorage: { mode } } } }),
  }));
  await writeFile(path.join(projectDir, "index.ts"), `
    const storageProject = steamharness.defineProject({
      name: "storage-context-test",
      async run(input, context) {
        ${useLegacyGetter
          ? `if (Reflect.has(context, "kv") || Reflect.has(context, "persistentValue")) {
              throw new Error("Removed storage compatibility getter is still present.");
            }`
          : `const storage = input.target === "server"
            ? context.storage.server
            : context.storage.local;
          await storage.kv.setValue("value", input.target);
          await storage.persistentValue.updateValue(
            "updated-value",
            () => input.target,
          );`}
        return { errCode: 0, errMessage: "", target: input.target };
      },
    });
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: storageProject,
        params: [{ name: "target", flag: "--target", type: "string", defaultValue: "local" }],
        createInput({ paramValues }) {
          return { target: String(paramValues.target ?? "local") };
        },
      })],
    });
    export { storageProject as workflow };
    export default storageProject;
  `);
  return projectDir;
}

function createMemoryKVStore(): KVStore & {
  values: Map<string, unknown>;
  sources: Map<string, Parameters<KVStore["setValue"]>[0]["source"]>;
} {
  const values = new Map<string, unknown>();
  const sources = new Map<string, Parameters<KVStore["setValue"]>[0]["source"]>();
  const key = (input: { storageKind: string; scope: string; projectId: string; conversationId?: string; key: string }) =>
    `${input.storageKind}:${input.scope}:${input.projectId}:${input.conversationId ?? ""}${input.key}`;
  return {
    values,
    sources,
    async getValue(input) { return values.get(key(input)); },
    async setValue(input) {
      values.set(key(input), input.value);
      sources.set(key(input), input.source);
    },
    async deleteValue(input) {
      sources.delete(key(input));
      return values.delete(key(input));
    },
    async updateValue(input, updater) {
      const next = updater(values.get(key(input)));
      values.set(key(input), next);
      sources.set(key(input), input.source);
      return next;
    },
  };
}

function readReportError(report: Awaited<ReturnType<typeof runLocalProjectWithReport>>): string {
  return report.result.ok
    ? String((report.result.data as { errMessage?: string }).errMessage ?? "")
    : report.result.error.message;
}
