import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@steamharness/i18n";
import {createConfigurationState,createPublicationDraft,freezeConfigurationTemplate,createLocalProjectConfigurationStore,readCachedConfigurationFile} from "steamharness";
import { ensureProjectCreated, decodeProjectFileContent, formatForbiddenMessage, normalizeProjectFilePath, packProject, getPreparation, main, parseArgs, readProjectPackageContext, resolveRepoRoot, stageProjectSource, waitForDeviceToken, waitForPreparation } from "../workspace";

const VALID_STEAMHARNESS_SOURCE = [
  "export const mainProject = steamharness.defineProject({",
  "  name: \"main\",",
  "  async run(input) { return input; },",
  "});",
  "export const executor = steamharness.defineExecutor({",
  "  projectType: \"workflow\",",
  "  defaultEntrypoint: \"main\",",
  "  entrypoints: [steamharness.defineEntrypoint({",
  "    id: \"main\", title: \"Main\", workflow: mainProject,",
  "    createInput() { return { errCode: 0, errMessage: \"\" }; },",
  "  })],",
  "});",
  "export { mainProject as workflow };",
  "export default mainProject;",
  "",
].join("\n");

describe("server workspace CLI helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initI18n({ preference: "en" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // Reset the shared i18n singleton so other tests are unaffected by the
    // forbidden-message locale assertions.
    initI18n({ preference: "zh-CN" });
  });

  it("parses source download options without an execution target", () => {
    expect(parseArgs([
      "download",
      "hello",
      "--server",
      "http://localhost:7125",
      "--token",
      "secret",
      "--target",
      "draft",
      "--path",
      "./download",
    ])).toMatchObject({
      command: "download",
      positional: ["hello"],
      options: {
        server: "http://localhost:7125",
        token: "secret",
        target: "draft",
        path: "./download",
      },
    });
  });

  it("rejects removed remote execution and release options", () => {
    for (const option of ["--entrypoint", "--execution-target", "--source-mode", "--platform", "--retain-source"]) {
      expect(() => parseArgs(["upload", "hello", option, "value"]))
        .toThrow(`Unknown workspace option: ${option}`);
    }
  });

  it('rejects removed relationship and combined-release flags',()=>{
    for(const flag of ['--project-group','--publish-group','--dependency','--related-project','--grant-data-access'])expect(()=>parseArgs(['upload','hello',flag])).toThrow('Unknown workspace option');
    expect(()=>parseArgs(['publish','hello','--no-wait'])).toThrow('--no-wait is only supported by upload');
  });

  it("excludes host data while staging an aggregate source package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-aggregate-host-data-"));
    const sourceDir = path.join(root, "source", "workflow");
    const stagingRoot = path.join(root, "stage");
    await mkdir(path.join(sourceDir, ".workflow-kv"), { recursive: true });
    await mkdir(path.join(sourceDir, ".workflow-persistent-values"), { recursive: true });
    await mkdir(path.join(sourceDir, ".workflow-schedules"), { recursive: true });
    await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({
      id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Workflow",
      version: "1.0.0",steamHarness:declaration(),
    }));
    await writeFile(path.join(sourceDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);
    await writeFile(path.join(sourceDir, ".env"), "SECRET=value\n");
    await writeFile(path.join(sourceDir, ".envrc"), "export SECRET=value\n");
    await writeFile(path.join(sourceDir, "configuration.json"), '{"version":1,"fields":[]}\n');
    await writeFile(path.join(sourceDir, "steamharness.sqlite-wal"), "local sqlite state\n");
    await writeFile(path.join(sourceDir, ".workflow-kv", "value.json"), "{}\n");
    await writeFile(path.join(sourceDir, ".workflow-persistent-values", "value.json"), "{}\n");
    await writeFile(path.join(sourceDir, ".workflow-schedules", "schedules.json"), "[]\n");
    await writeFile(path.join(sourceDir, "workflow-auth.json"), "{\"apiKey\":\"secret\"}\n");

    try {
      await stageProjectSource({
        projectDir: sourceDir,
        projectName: "workflow",
        stagingRoot,
      });
      const staged = path.join(stagingRoot, "workflow");
      expect(existsSync(path.join(staged, "package.json"))).toBe(true);
      expect(existsSync(path.join(staged, "configuration.json"))).toBe(true);
      expect(existsSync(path.join(staged, ".env"))).toBe(false);
      expect(existsSync(path.join(staged, ".envrc"))).toBe(false);
      expect(existsSync(path.join(staged, "steamharness.sqlite-wal"))).toBe(false);
      expect(existsSync(path.join(staged, ".workflow-kv"))).toBe(false);
      expect(existsSync(path.join(staged, ".workflow-persistent-values"))).toBe(false);
      expect(existsSync(path.join(staged, ".workflow-schedules"))).toBe(false);
      expect(existsSync(path.join(staged, "workflow-auth.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("polls preparation jobs until the server returns the upload result", async () => {
    const jobId = "a0000000-0000-4000-8000-000000000030";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          jobId,
          projectId: "demo",
          archiveName: "demo.tgz",
          createOnly: false,
          status: "preparing",
          stage: "bundling",
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          jobId,
          projectId: "demo",
          archiveName: "demo.tgz",
          createOnly: false,
          status: "success",
          stage: "committing",
          createdAt: "2026-07-16T00:00:00.000Z",
          result: { projectId: "demo", sourceHash: "hash" },
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await waitForPreparation({
      projectId: "demo",
      jobId,
      server: "http://localhost:7125",
      token: "token",
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      errCode: 0,
      errMessage: "",
      data: { projectId: "demo", sourceHash: "hash" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queries a persisted preparation job after upload --no-wait", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      errCode: 0,
      errMessage: "",
      data: {
        jobId: "a0000000-0000-4000-8000-000000000031",
        projectId: "demo",
        archiveName: "demo.tgz",
        createOnly: false,
        status: "preparing",
        stage: "installing",
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPreparation({
      projectId: "demo",
      jobId: "a0000000-0000-4000-8000-000000000031",
      server: "http://localhost:7125",
      token: "token",
    })).resolves.toMatchObject({ errCode: 0, data: { status: "preparing" } });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/projects/demo/preparations/a0000000-0000-4000-8000-000000000031");
  });

  it("packages executable project source without requiring a README", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-optional-readme-"));
    const sourceProjectDir = path.join(root, "source");
    const archivePath = path.join(root, "steamharness.tgz");
    await mkdir(sourceProjectDir, { recursive: true });
    await writeFile(path.join(sourceProjectDir, "package.json"), JSON.stringify({
      id: "a7e15f8a-e179-4986-8b0d-1e69a0e65b51",
      name: "@steamharness/optional-readme",
      version: "0.1.0",steamHarness:declaration(),
    }));
    await writeFile(path.join(sourceProjectDir, "index.ts"), "export default {};\n");
    await expect(packProject("optional-readme", archivePath, sourceProjectDir))
      .resolves.toBe(archivePath);
    await rm(root, { recursive: true, force: true });
  });

  it("packs a configured Kanban artifact using only .steamharnessignore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-kanban-pack-"));
    const sourceDir = path.join(root, "kanban");
    const archivePath = path.join(root, "kanban.tgz");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({
      id: "a7e15f8a-e179-4986-8b0d-1e69a0e65b51",
      name: "Kanban",
      version: "0.1.0",
      steamHarness: {
        defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"kanban",root:"dist",entry:"pages/board.html",databases:[]}],
      },
    }));
    await mkdir(path.join(sourceDir, "dist", "pages"), { recursive: true });
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await writeFile(path.join(sourceDir, ".gitignore"), "dist/\n");
    await writeFile(path.join(sourceDir, ".steamharnessignore"), "src/\ndist/**/*.map\n");
    await writeFile(path.join(sourceDir, "dist", "pages", "board.html"), "<!doctype html><title>Kanban</title>\n");
    await writeFile(path.join(sourceDir, "dist", "board.png"), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(sourceDir, "dist", "app.js.map"), "{}");
    await writeFile(path.join(sourceDir, "src", "main.ts"), "source");

    await expect(packProject("kanban", archivePath, sourceDir)).resolves.toBe(archivePath);
    const contents = await runTarList(archivePath);
    expect(contents).toContain("workspace/workflow/kanban/.gitignore");
    expect(contents).toContain("workspace/workflow/kanban/.steamharnessignore");
    expect(contents).toContain("workspace/workflow/kanban/dist/pages/board.html");
    expect(contents).toContain("workspace/workflow/kanban/dist/board.png");
    expect(contents).not.toContain("workspace/workflow/kanban/dist/app.js.map");
    expect(contents).not.toContain("workspace/workflow/kanban/src/main.ts");
    await rm(root, { recursive: true, force: true });
  });

  it("decodes base64 download files without changing legacy text files", () => {
    expect(decodeProjectFileContent({ path: "index.html", content: "<main />" }))
      .toBe("<main />");
    expect(decodeProjectFileContent({
      path: "board.png",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      encoding: "base64",
    })).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(() => decodeProjectFileContent({
      path: "broken.png",
      content: "not base64!",
      encoding: "base64",
    })).toThrow("Invalid base64 content");
  });

  it("reads saved CLI auth config when no explicit token override is provided", async () => {
    const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-auth-"));
    await writeFile(
      path.join(authDir, "workflow-auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:7125",
        apiKey: "saved-api-key",
        expiresAt: "2026-07-01T00:00:00.000Z",
        user: {
          userId: "user-1",
          email: "user@example.com",
          displayName: "Normal User",
        },
        source: "device_flow",
      }),
      "utf8",
    );

    const previousAuthDir = process.env.STEAMHARNESS_CLI_AUTH_DIR;
    const previousServer = process.env.STEAMHARNESS_SERVER_URL;
    const previousAdminKey = process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
    delete process.env.STEAMHARNESS_SERVER_URL;
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;

    try {
      expect(parseArgs([
        "run",
        "hello",
        "--target",
        "latest",
      ])).toMatchObject({
        command: "run",
        positional: ["hello"],
        options: {
          server: "http://localhost:7125",
          token: "saved-api-key",
          target: "latest",
        },
      });
    } finally {
      if (previousAuthDir === undefined) {
        delete process.env.STEAMHARNESS_CLI_AUTH_DIR;
      } else {
        process.env.STEAMHARNESS_CLI_AUTH_DIR = previousAuthDir;
      }
      if (previousServer === undefined) {
        delete process.env.STEAMHARNESS_SERVER_URL;
      } else {
        process.env.STEAMHARNESS_SERVER_URL = previousServer;
      }
      if (previousAdminKey === undefined) {
        delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      } else {
        process.env.STEAMHARNESS_SERVER_ADMIN_KEY = previousAdminKey;
      }
    }
  });

  it("reports the effective server and where it came from", async () => {
    const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-auth-"));
    await writeFile(
      path.join(authDir, "workflow-auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:7126",
        apiKey: "saved-api-key",
        source: "device_flow",
      }),
      "utf8",
    );

    const previousAuthDir = process.env.STEAMHARNESS_CLI_AUTH_DIR;
    const previousServer = process.env.STEAMHARNESS_SERVER_URL;
    const previousAdminKey = process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
    process.env.STEAMHARNESS_CLI_AUTH_DIR = authDir;
    delete process.env.STEAMHARNESS_SERVER_URL;
    delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;

    try {
      // A host that spawns this CLI passes its own session through the
      // environment; status has to say so instead of echoing the login file.
      process.env.STEAMHARNESS_SERVER_URL = "https://alpha.steamharness.yuhe.space";
      process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "desktop-session-key";
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await main(["status"]);
        const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          data: { serverUrl: string; effective: unknown };
        };
        expect(payload.data.serverUrl).toBe("http://localhost:7126");
        expect(payload.data.effective).toEqual({
          serverUrl: "https://alpha.steamharness.yuhe.space",
          serverSource: "env",
          tokenSource: "env",
        });
      } finally {
        log.mockRestore();
      }

      // Without a host session the saved login is what a command would use.
      delete process.env.STEAMHARNESS_SERVER_URL;
      delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      expect(parseArgs(["status"]).effective).toEqual({
        serverUrl: "http://localhost:7126",
        serverSource: "file",
        tokenSource: "file",
      });

      // Explicit flags win over both.
      expect(parseArgs([
        "status",
        "--server",
        "https://example.test",
        "--token",
        "flag-token",
      ]).effective).toEqual({
        serverUrl: "https://example.test",
        serverSource: "flag",
        tokenSource: "flag",
      });

      // And over the environment, not the other way round.
      process.env.STEAMHARNESS_SERVER_URL = "https://from-env.test";
      process.env.STEAMHARNESS_SERVER_ADMIN_KEY = "env-token";
      expect(parseArgs([
        "status",
        "--server",
        "https://from-flag.test",
        "--token",
        "flag-token",
      ]).effective).toEqual({
        serverUrl: "https://from-flag.test",
        serverSource: "flag",
        tokenSource: "flag",
      });
    } finally {
      if (previousAuthDir === undefined) {
        delete process.env.STEAMHARNESS_CLI_AUTH_DIR;
      } else {
        process.env.STEAMHARNESS_CLI_AUTH_DIR = previousAuthDir;
      }
      if (previousServer === undefined) {
        delete process.env.STEAMHARNESS_SERVER_URL;
      } else {
        process.env.STEAMHARNESS_SERVER_URL = previousServer;
      }
      if (previousAdminKey === undefined) {
        delete process.env.STEAMHARNESS_SERVER_ADMIN_KEY;
      } else {
        process.env.STEAMHARNESS_SERVER_ADMIN_KEY = previousAdminKey;
      }
      await rm(authDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe download paths without hiding valid server snapshot files", () => {
    expect(normalizeProjectFilePath("./src/index.ts")).toBe("src/index.ts");
    expect(normalizeProjectFilePath("node_modules/pkg/index.js")).toBe("node_modules/pkg/index.js");
    expect(normalizeProjectFilePath(".env.local")).toBe(".env.local");
    expect(() => normalizeProjectFilePath("../secret.env")).toThrow(/Invalid workflow file path/);
  });

  it("resolves the standalone Core repository root from its workspace", async () => {
    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-core-root-"));
    const projectDir = path.join(root, "workspace", "workflow", "hello");
    delete process.env.STEAMHARNESS_REPO_ROOT;

    try {
      await mkdir(projectDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "."\n', "utf8"),
        writeFile(path.join(root, "package.json"), '{"name":"steamharness"}\n', "utf8"),
        writeFile(path.join(root, "workspace", "package.json"), '{"name":"@steamharness/workspace"}\n', "utf8"),
      ]);

      // keeps default pack paths rooted in the Core repository.
      expect(resolveRepoRoot(projectDir)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it("executes the packaged dist CLI help without server access", async () => {
    const cliPath = path.resolve("dist", "index.js");
    if (!existsSync(cliPath)) {
      return;
    }

    const result = await runNode(cliPath, ["workspace", "--help"]);

    // covers the built server workspace CLI shape while keeping the
    // default test suite offline and independent of SteamHarness Server.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/(?:Usage|用法).*steamharness/);
    expect(result.stdout).toContain("pnpm exec steamharness workspace <command> [args]");
    expect(result.stdout).toContain("versions <workflow>");
    expect(result.stderr.trim()).toBe("");
  });

  it("ships the unified steamharness bin as a node executable", () => {
    const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    const tsupConfig = readFileSync(path.resolve("tsup.config.ts"), "utf8");

    expect(packageJson.bin?.["steamharness"]).toBe("./dist/index.js");
    expect(tsupConfig).toContain('js: "#!/usr/bin/env node"');
  });

  it("stores the published workspace help text in the CLI resources", () => {
    const source = readFileSync(path.resolve("..", "shared", "i18n", "resources", "en", "cli.ts"), "utf8");

    expect(source).toContain("Usage: steamharness [--locale <zh-CN|en>] workspace <command> [args]");
    expect(source).toContain("http://localhost:7126");
  });

  it("backs off device polling when the server returns slow_down", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 429,
        errMessage: "slow_down",
        data: { retryAfterSeconds: 7 },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        errCode: 0,
        errMessage: "",
        data: {
          accessToken: "wf_api_test",
          apiKey: {
            prefix: "wf_api",
            expiresAt: "2026-07-01T00:00:00.000Z",
          },
          user: {
            userId: "user-1",
            email: "user@example.com",
            displayName: "Workflow User",
          },
          expiresAt: "2026-07-01T00:00:00.000Z",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = waitForDeviceToken({
      server: "http://127.0.0.1:7125",
      deviceCode: "device-code-1",
      intervalSeconds: 5,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    await vi.runOnlyPendingTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:7125/api/auth/device/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deviceCode: "device-code-1" }),
      }),
    );
    expect(result).toMatchObject({
      errCode: 0,
      data: {
        accessToken: "wf_api_test",
      },
    });
  });

  it("reads bound workflow UUIDs from the local package metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-package-"));
    const projectDir = path.join(root, "workspace", "workflow", "hello");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
      id: "8bd4fef2-e083-4201-a89f-6f7d0676df53",
      name: "Hello Workflow",
      version: "0.0.1",
      steamHarness: declaration(),
    }, null, 2));
    await writeFile(path.join(projectDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    process.env.STEAMHARNESS_REPO_ROOT = root;
    try {
      const context = await readProjectPackageContext("hello", undefined);
      expect(context.projectId).toBe("8bd4fef2-e083-4201-a89f-6f7d0676df53");
      expect(context.projectName).toBe("Hello Workflow");
      expect(context.projectDir).toBe(projectDir);
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
    }
  });

  it('rejects invalid aggregate identity before any remote allocation',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'invalid-aggregate-'));
    try{await writeFile(path.join(root,'package.json'),JSON.stringify({id:'invalid',name:'Invalid',steamHarness:declaration()}));await expect(readProjectPackageContext('invalid',root)).rejects.toThrow();}finally{await rm(root,{recursive:true,force:true});}
  });

  it.each([undefined, "team-group"])("applies for a new ID with selected ownership group %s", async groupId => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-allocate-"));
    const projectDir = path.join(root, "hello"); await mkdir(projectDir);
    const oldId = "8bd4fef2-e083-4201-a89f-6f7d0676df53", newId = "78648759-bcde-4fd5-b3bd-9a2dd46a7192";
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ id: oldId, name: "Hello Workflow", version: "0.0.1", steamHarness: {...declaration(), projectInfo: createProjectInfo() } }, null, 2));
    await writeFile(path.join(projectDir, "index.ts"), VALID_STEAMHARNESS_SOURCE);
    const fetchMock = vi.fn().mockResolvedValueOnce(createJsonResponse({ errCode: 404, errMessage: "missing" })).mockResolvedValue(createJsonResponse({ errCode: 0, data: { projectId: newId, entries:declaration().entries,defaultEntry:"main", projectName: "Hello Workflow", visibility: "private" } }));
    vi.stubGlobal("fetch", fetchMock);
    const packageContext = await readProjectPackageContext("hello", projectDir);
    const created = await ensureProjectCreated({ packageContext, groupId, allowNewApplication: true, server: "http://127.0.0.1:7125", token: "api-key" });
    expect(created.projectId).toBe(newId);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toEqual({ name: "Hello Workflow", entries:declaration().entries,defaultEntry:"main", projectInfo: { localizedNames: {}, declarations: [], platformSupport: { mode: "agnostic" }, ...createProjectInfo() }, ...(groupId ? { groupId } : {}) });
    expect(JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"))).toMatchObject({ id: newId, name: "Hello Workflow" });
    fetchMock.mockReset().mockResolvedValue(createJsonResponse({ errCode: 0, data: { id: newId, name: "Hello Workflow", entries:declaration().entries,defaultEntry:"main", visibility: "private" } }));
    await ensureProjectCreated({ packageContext: await readProjectPackageContext("hello", projectDir), server: "http://127.0.0.1:7125", token: "api-key" });
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it('packages every registered entry and removes installed database bindings',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'aggregate-pack-'));
    try {
      const entries=[{entryId:'one',name:'One',type:'workflow',root:'one',entry:'index.ts',databases:[]},{entryId:'two',name:'Two',type:'workflow',root:'two',entry:'index.ts',databases:[]},{entryId:'map',name:'Map',type:'kanban',root:'map',entry:'index.html',databases:[{alias:'data',databaseId:'c6033af9-e762-4a4e-a319-523cdb55103e'}]}];
      await writeFile(path.join(root,'package.json'),JSON.stringify({id:'a7e15f8a-e179-4986-8b0d-1e69a0e65b51',name:'Aggregate',steamHarness:{defaultEntry:'one',entries}}));
      for(const entry of entries){await mkdir(path.join(root,entry.root));await writeFile(path.join(root,entry.root,entry.entry),'export {};');}
      const staging=path.join(root,'staging');await stageProjectSource({projectDir:root,projectName:'aggregate',stagingRoot:staging});
      const manifest=JSON.parse(readFileSync(path.join(staging,'aggregate','package.json'),'utf8'));
      expect(manifest.steamHarness.entries).toHaveLength(3);expect(manifest.steamHarness.entries[2].databases[0]).not.toHaveProperty('bindingRef');
      for(const entry of entries)expect(existsSync(path.join(staging,'aggregate',entry.root,entry.entry))).toBe(true);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it("packs dependency-bearing source without installing packages or requiring a lockfile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-pack-uninstalled-"));
    const sourceProjectDir = path.join(root, "manual-dependencies");
    const archivePath = path.join(root, "manual-dependencies.tgz");
    await mkdir(sourceProjectDir, { recursive: true });
    await writeFile(
      path.join(sourceProjectDir, "package.json"),
      JSON.stringify({
        id: "a7e15f8a-e179-4986-8b0d-1e69a0e65b51",
        name: "@steamharness/manual-dependencies",
        version: "0.1.0",steamHarness:declaration(),
        dependencies: { "not-installed": "1.0.0" },
      }),
      "utf8",
    );
    await writeFile(path.join(sourceProjectDir, "index.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(sourceProjectDir, "README.md"), "# Manual dependencies\n", "utf8");
    await writeFile(path.join(sourceProjectDir, ".env"), "SECRET=1\n", "utf8");
    await writeFile(path.join(sourceProjectDir, "configuration.json"), '{"version":1,"fields":[]}\n', "utf8");
    await writeFile(path.join(sourceProjectDir, ".DS_Store"), "temporary", "utf8");
    await writeFile(path.join(sourceProjectDir, ".steamharnessignore"), ".env\n.DS_Store\n", "utf8");

    // CLI packaging only transports source; dependency installation remains a host concern after download.
    await expect(packProject(
      "manual-dependencies",
      archivePath,
      sourceProjectDir,
    )).resolves.toBe(archivePath);

    expect(existsSync(path.join(sourceProjectDir, "node_modules"))).toBe(false);
    expect(existsSync(path.join(sourceProjectDir, "pnpm-lock.yaml"))).toBe(false);
    const contents = await runTarList(archivePath);
    expect(contents).toContain("workspace/workflow/manual-dependencies/package.json");
    expect(contents).toContain("workspace/workflow/manual-dependencies/README.md");
    expect(contents).toContain("workspace/workflow/manual-dependencies/configuration.json");
    expect(contents).toContain("workspace/workflow/manual-dependencies/.steamharnessignore");
    expect(contents).not.toContain("workspace/workflow/manual-dependencies/.env\n");
    expect(contents).not.toContain(".DS_Store");
  });

  it("packs explicit source paths with a writable App packs directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-pack-app-"));
    const appRuntimeRoot = path.join(root, "app-runtime");
    const packsDir = path.join(root, "app-packs");
    const workspaceRoot = path.join(root, "external-workflows");
    const sourceProjectDir = path.join(workspaceRoot, "conversation");
    const siblingProjectDir = path.join(workspaceRoot, "openai-agents");

    await mkdir(appRuntimeRoot, { recursive: true });
    await mkdir(sourceProjectDir, { recursive: true });
    await mkdir(siblingProjectDir, { recursive: true });
    await writeFile(
      path.join(sourceProjectDir, "package.json"),
      JSON.stringify({
        id: "2dc44605-66d9-4a07-8090-72eb83d708a7",
        name: "@steamharness/conversation-workflow",
        version: "0.1.0",steamHarness:declaration(),
      }),
      "utf8",
    );
    await writeFile(
      path.join(sourceProjectDir, "index.ts"),
      'import { openaiAgentsProject } from "../openai-agents/index";\n',
      "utf8",
    );
    await writeFile(path.join(sourceProjectDir, "README.md"), "# Conversation\n", "utf8");
    await writeFile(path.join(siblingProjectDir, "package.json"), '{"name":"openai-agents"}\n', "utf8");
    await writeFile(path.join(siblingProjectDir, "index.ts"), "export const openaiAgentsProject = {};\n", "utf8");
    await writeFile(path.join(siblingProjectDir, "README.md"), "# OpenAI agents\n", "utf8");

    const previousRepoRoot = process.env.STEAMHARNESS_REPO_ROOT;
    const previousPacksDir = process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR;
    process.env.STEAMHARNESS_REPO_ROOT = appRuntimeRoot;
    process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR = packsDir;
    try {
      // Packaged uploads use a writable directory outside app.asar.
      const packedPath = await packProject("conversation", undefined, sourceProjectDir);
      expect(packedPath.startsWith(packsDir)).toBe(true);

      const result = await runTarList(packedPath);
      expect(result).toContain("workspace/workflow/conversation/index.ts");
      expect(result).not.toContain("workspace/workflow/openai-agents/index.ts");
    } finally {
      if (previousRepoRoot === undefined) {
        delete process.env.STEAMHARNESS_REPO_ROOT;
      } else {
        process.env.STEAMHARNESS_REPO_ROOT = previousRepoRoot;
      }
      if (previousPacksDir === undefined) {
        delete process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR;
      } else {
        process.env.STEAMHARNESS_WORKSPACE_PACKS_DIR = previousPacksDir;
      }
    }
  });

  it("formats project permission failures and preserves request-specific details", () => {
    // The CLI default locale is zh-CN, so the translated output keeps the
    // original Chinese text verbatim.
    initI18n({ preference: "zh-CN" });
    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Project data access is not granted.",
    })).toBe("403: Project data access is not granted.");

    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Permission denied.",
    })).toBe("403: 当前账号对该项目没有足够权限。");
  });

  it("localizes forbidden messages to English after --locale en", () => {
    // --locale en resolves to initI18n({ preference: "en" }) and switches the
    // shared CLI namespace to English while keeping the "403: " prefix.
    initI18n({ preference: "en" });
    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Project source download is not granted.",
    })).toBe("403: Project source download is not granted.");

    expect(formatForbiddenMessage({
      errCode: 403,
      errMessage: "Permission denied.",
    })).toBe("403: Your account does not have sufficient permission for this project operation.");
  });

});

function declaration(){return {defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'workflow',root:'.',entry:'index.ts',databases:[]}]};}
function createProjectInfo():Record<string,unknown>{return {localizedNames:{},declarations:[],platformSupport:{mode:'agnostic'}};}

function runNode(
  scriptPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_OPTIONS: removeNodeOptionsConditions(process.env.NODE_OPTIONS ?? ""),
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function removeNodeOptionsConditions(value: string): string {
  return value
    .split(/\s+/)
    .filter((part) => part !== "--conditions=development" && part !== "--conditions" && part !== "development")
    .join(" ")
    .trim();
}

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function runTarList(archivePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tzf", archivePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
