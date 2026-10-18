import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import docusaurusConfig from "../../docusaurus.config.mjs";
import { activateDocsService, stopDocsProcess } from "../activate-docs.mjs";
import { buildDocs, rewriteOpenApiServers } from "../build-docs.mjs";
import { deployDocs } from "../deploy-docs.mjs";
import { createArtifactFilter } from "../generate-api-docs.mjs";
import { prepareOpenApiSpecs } from "../prepare-openapi.mjs";
import { parseDocsDeploymentMetadata } from "../recover-docs.mjs";
import { createDocsServer } from "../serve-docs.mjs";
import { validateDocs, validateStandaloneDocsSource } from "../validate-docs.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const commit = "7316652cf77bcbf766084839971208f3399aecc9";

test("standalone Docs validates paired navigation, pages, links, and OpenAPI", async () => {
  const result = await validateDocs({ root });
  assert.deepEqual(result.languages, ["zh-Hans", "en"]);
  assert.ok(result.pages > 0);
  assert.ok(result.openapiPaths > 0);
});

test("OpenAPI exposes storage APIs without project execution contracts", async () => {
  for (const relativePath of [
    "openapi/steamharness.openapi.yaml",
    "en/openapi/steamharness.openapi.yaml",
  ]) {
    const specification = YAML.parse(await readFile(path.join(root, relativePath), "utf8"));
    const sourceAccessReason = specification.paths["/api/project-source-access/{token}/requests"]
      .post.requestBody.content["application/json"].schema.properties.reason;

    assert.equal(specification.components.schemas.OpenAIResponse, undefined);
    for (const endpoint of [
      "/api/workflows/{workflowName}/run", "/api/workflows/{workflowName}/runs",
      "/api/workflows/{workflowName}/structure", "/api/workflows/{workflowName}/resolve-params",
      "/api/admin/runners", "/v1/responses",
    ]) assert.equal(specification.paths[endpoint], undefined);
    for (const endpoint of [
      "/api/project-storage", "/api/workflows/{workflowName}/knowledge-documents",
      "/api/workflows/{workflowName}/source-archive",
    ]) assert.ok(specification.paths[endpoint], endpoint);
    const legacyPrivateCatalog = ["sub", "2api"].join("");
    const legacyLlmModels = ["llm-", "models"].join("");
    const legacyAdminBinding = ["sub", "2api-binding"].join("");
    for (const endpoint of [
      `/api/auth/${legacyPrivateCatalog}/catalog`, `/api/auth/${legacyPrivateCatalog}/llm-proxy/v1/responses`,
      `/api/auth/admin/${legacyLlmModels}/catalog`, `/api/auth/admin/users/{userId}/${legacyAdminBinding}`,
    ]) assert.equal(specification.paths[endpoint], undefined, endpoint);
    const legacySchema = ["WorkflowSub", "2ApiCatalog"].join("");
    assert.equal(specification.components.schemas[legacySchema], undefined);
    assert.equal(sourceAccessReason.enum, undefined);
    assert.equal(sourceAccessReason.minLength, 2);
  }
});

test("Docusaurus keeps docs-only routes and local search aligned", () => {
  const [, docsOptions] = docusaurusConfig.plugins.find(([name]) => name === "./plugins/localized-content-docs.mjs");
  const [, searchOptions] = docusaurusConfig.plugins.find(([name]) => name === "@easyops-cn/docusaurus-search-local");

  assert.equal(docsOptions.routeBasePath, "/");
  assert.equal(searchOptions.docsRouteBasePath, docsOptions.routeBasePath);
  assert.equal(docusaurusConfig.plugins[1][1].config.workflowZh.specPath, ".docusaurus-openapi/steamharness.zh.yaml");
  assert.equal(docusaurusConfig.plugins[1][1].config.workflowEn.specPath, ".docusaurus-openapi/steamharness.en.yaml");
  assert.deepEqual(docusaurusConfig.i18n.locales, ["zh-Hans", "en"]);
});

test("Docs recovery accepts only a recorded immutable build commit", () => {
  const commitSha = "a".repeat(40);
  assert.deepEqual(parseDocsDeploymentMetadata({ schemaVersion: 1, commitSha }), { commitSha });
  assert.throws(() => parseDocsDeploymentMetadata({ schemaVersion: 1, commitSha: "main" }));
});

test("Studio documentation replaces Desktop navigation in both languages", async () => {
  const navigation = await readFile(path.join(root, "docs.json"), "utf8");
  assert.doesNotMatch(navigation, /guides\/(?:desktop\/|releases\/(?:desktop|downloads))/u);
  for (const prefix of ["", "en/"]) {
    assert.ok(navigation.includes(`${prefix}guides/studio/overview`));
    const source = await readFile(path.join(root, prefix, "guides/studio/overview.mdx"), "utf8");
    assert.match(source, /@steamharness\/cli/u);
    assert.match(source, /npm run dev:web/u);
    await assert.rejects(lstat(path.join(root, prefix, "guides/desktop/overview.mdx")), { code: "ENOENT" });
  }
});

test("standalone Docs rejects removed Desktop Web and legacy monorepo references", () => {
  for (const legacySource of [
    "`packages/steamharness/src/index.ts`",
    "`packages/cli/dist/index.js`",
    "`app/builtin-projects/conversation`",
    "`pnpm -C app build`",
    "`pnpm -C server/web build`",
    "`pnpm -C workspace workspace help`",
    "`pnpm app:dev`",
    "`app/out/studio-web`",
    "http://localhost:7133",
  ]) {
    assert.throws(
      () => validateStandaloneDocsSource("example.mdx", legacySource),
      /removed Desktop Web Studio|legacy monorepo/,
    );
  }

  assert.doesNotThrow(() => validateStandaloneDocsSource(
    "example.mdx",
    "Server Web remains in the Server repository at `web/src/App.tsx`.",
  ));
});

test("standalone Docs rejects the relay and Web entry that replaced the Web Studio", () => {
  // The Chinese term is the reason this list is literals rather than
  // word-bounded: `\b` is ASCII-only in a JS regex, so `\bWeb 入口\b` matches
  // neither "Web 入口页面" nor a bare "Web 入口" — it would have guarded
  for (const legacySource of [
    "运行到 Web",
    "运行到 Web 的链接",
    "项目的 Web 入口页面",
    "Web entry point",
  ]) {
    assert.throws(
      () => validateStandaloneDocsSource("example.mdx", legacySource),
      /removed Desktop Web Studio/,
    );
  }

  assert.doesNotThrow(() => validateStandaloneDocsSource(
    "example.mdx",
    "The Web version is served at the root of `alpha-web.steamharness.yuhe.space`.",
  ));
});

test("standalone Docs rejects the removed Desktop app identity", () => {
  for (const legacySource of [
    "/guides/app/overview",
    "/guides/releases/app",
    "STEAMHARNESS_APP_CONFIG_DIR",
    "workflow-app.json",
    "@steamharness/app",
    "minAppVersion",
    "appVersion",
    "workflow.isApp()",
    "https://example.test/app/stable/latest.yml",
    "app/v1.2.3",
    "source=app",
    'source = "app"',
    "STEAMHARNESS_RUNTIME_PLATFORM=app",
  ]) {
    assert.throws(
      () => validateStandaloneDocsSource("example.mdx", legacySource),
      /removed Desktop app identity/,
    );
  }

  assert.doesNotThrow(() => validateStandaloneDocsSource(
    "example.mdx",
    "Desktop uses workflow.isDesktop(), source=desktop, desktop/v1.2.3, and SteamHarness.app.",
  ));
});

test("standalone Docs rejects ISO display timestamps on generated release pages", () => {
  assert.throws(
    () => validateStandaloneDocsSource(
      "guides/releases/server.mdx",
      "> - 生成时间：2026-08-10T15:36:54.927Z",
    ),
    /YYYY-MM-DD HH:mm:ss/,
  );
  assert.throws(
    () => validateStandaloneDocsSource(
      "en/guides/releases/server.mdx",
      "> - Generated: 2026-08-10T15:36:54Z",
    ),
    /YYYY-MM-DD HH:mm:ss/,
  );
  assert.doesNotThrow(() => validateStandaloneDocsSource(
    "guides/releases/server.mdx",
    "> - 生成时间：2026-08-10 15:36:54",
  ));
  assert.doesNotThrow(() => validateStandaloneDocsSource(
    "guides/server/deployment.mdx",
    "API 示例仍可使用协议时间 2026-08-10T15:36:54.927Z。",
  ));
});

test("Docs build packages the generated Docusaurus site and runtime with the exact commit", async () => {
  const tempRoot = await mkdtemp(path.join(root, ".docs-build-test-"));
  const siteDir = path.join(tempRoot, "docusaurus-build");
  const outputDir = path.join(tempRoot, "dist", "site");
  try {
    await writeDocusaurusBuild(siteDir, "Built docs");
    await buildDocs({ root, siteDir, outputDir, commitSha: commit, builtAt: "2026-08-12T00:00:00.000Z" });
    const deployment = JSON.parse(await readFile(path.join(outputDir, "deployment.json"), "utf8"));
    assert.equal(deployment.commitSha, commit);
    assert.equal(deployment.framework, "docusaurus");
    assert.equal(deployment.apiBaseUrl, "https://api.steamharness.yuhe.space");
    assert.match(await readFile(path.join(outputDir, "index.html"), "utf8"), /Built docs/u);
    assert.ok((await lstat(path.join(outputDir, ".workflow", "activate-docs.mjs"))).isFile());
    assert.ok((await lstat(path.join(outputDir, ".workflow", "serve-docs.mjs"))).isFile());
    for (const generatedPath of ["docs.json", "docusaurus.config.mjs", "scripts", "openapi"]) {
      await assert.rejects(lstat(path.join(outputDir, generatedPath)), { code: "ENOENT" });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Docs static server resolves Docusaurus routes and protects deployment internals", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-docs-server-"));
  const siteRoot = path.join(tempRoot, "site");
  const port = await reservePort();
  let server;
  try {
    await writeDocsSite(siteRoot, commit, "Static home");
    server = await createDocsServer({ root: siteRoot, host: "127.0.0.1", port });

    const route = await fetch(`http://127.0.0.1:${port}/guides/studio/overview`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /Studio overview/u);
    assert.equal(route.headers.get("x-workflow-docs-framework"), "docusaurus");
    assert.equal(route.headers.get("x-workflow-docs-commit"), commit);
    assert.equal(route.headers.get("cache-control"), "public, max-age=0, must-revalidate");

    const asset = await fetch(`http://127.0.0.1:${port}/assets/js/app.12345678.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const hiddenRuntime = await fetch(`http://127.0.0.1:${port}/.workflow/serve-docs.mjs`);
    assert.equal(hiddenRuntime.status, 404);
    assert.match(await hiddenRuntime.text(), /Custom not found/u);

    const missing = await fetch(`http://127.0.0.1:${port}/missing-page`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Custom not found/u);

    const head = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const method = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET, HEAD");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Docs deploy atomically switches current and rolls it back when the hook fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-docs-deploy-"));
  const sourceDir = path.join(tempRoot, "source");
  const deployRoot = path.join(tempRoot, "published", "docs");
  try {
    await writeDocsSite(sourceDir, commit, "First deploy");
    await deployDocs({ sourceDir, deployRoot, commitSha: commit, deployedAt: "2026-08-12T00:00:00.000Z" });
    assert.equal(await readlink(path.join(deployRoot, "current")), path.join("releases", commit));
    assert.ok((await lstat(path.join(deployRoot, "current"))).isSymbolicLink());

    const nextCommit = "a".repeat(40);
    const hookReleaseRoots = [];
    await writeDocsSite(sourceDir, nextCommit, "Changed deploy");
    await assert.rejects(
      deployDocs({
        sourceDir,
        deployRoot,
        commitSha: nextCommit,
        hook: path.join(tempRoot, "hook"),
        hookArgs: [],
        execFile: async (_executable, _args, options) => {
          hookReleaseRoots.push(options.env.STEAMHARNESS_DOCS_RELEASE_ROOT);
          if (hookReleaseRoots.length === 1) throw new Error("restart failed");
        },
      }),
      /restart failed/,
    );
    assert.equal(await readlink(path.join(deployRoot, "current")), path.join("releases", commit));
    assert.deepEqual(hookReleaseRoots, [
      path.join(deployRoot, "releases", nextCommit),
      path.join(deployRoot, "releases", commit),
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Docs activation preflights and replaces a legacy Mint PID with the exact Docusaurus release", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-docs-activation-"));
  const runtimeRoot = path.join(tempRoot, "runtime");
  const productionPort = await reservePort();
  const preflightPort = await reservePort();
  const firstCommit = "1".repeat(40);
  const secondCommit = "2".repeat(40);
  try {
    const firstRelease = await writeDocsRelease(tempRoot, firstCommit, "First release");
    const first = await activateDocsService({
      releaseRoot: firstRelease,
      runtimeRoot,
      commitSha: firstCommit,
      port: productionPort,
      preflightPort,
      startupTimeoutMs: 10_000,
      activatedAt: "2026-08-15T00:00:00.000Z",
    });
    assert.match(await (await fetch(`http://127.0.0.1:${productionPort}/`)).text(), /First release/u);

    await rename(
      path.join(runtimeRoot, "docusaurus-static.pid"),
      path.join(runtimeRoot, "mint-dev.pid"),
    );

    const secondRelease = await writeDocsRelease(tempRoot, secondCommit, "Second release");
    const second = await activateDocsService({
      releaseRoot: secondRelease,
      runtimeRoot,
      commitSha: secondCommit,
      port: productionPort,
      preflightPort,
      startupTimeoutMs: 10_000,
      activatedAt: "2026-08-15T00:01:00.000Z",
    });
    assert.notEqual(second.pid, first.pid);
    const response = await fetch(`http://127.0.0.1:${productionPort}/`);
    assert.match(await response.text(), /Second release/u);
    assert.equal(response.headers.get("x-workflow-docs-framework"), "docusaurus");
    assert.equal(response.headers.get("x-workflow-docs-commit"), secondCommit);
    const deployment = JSON.parse(await readFile(path.join(runtimeRoot, "deployment.json"), "utf8"));
    assert.equal(deployment.framework, "docusaurus");
    assert.equal(deployment.commitSha, secondCommit);
    assert.equal(deployment.sourceDir, secondRelease);
  } finally {
    await stopDocsProcess(path.join(runtimeRoot, "docusaurus-static.pid"));
    await stopDocsProcess(path.join(runtimeRoot, "docusaurus-preflight.pid"));
    await stopDocsProcess(path.join(runtimeRoot, "mint-dev.pid"));
    await stopDocsProcess(path.join(runtimeRoot, "mint-preflight.pid"));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("OpenAPI release rewriting removes local servers and prepares both Docusaurus specs", async () => {
  const source = "openapi: 3.1.0\nservers:\n  - url: http://localhost:7125\n    description: local\npaths:\n  /api/health: {}\n";
  assert.match(rewriteOpenApiServers(source, "https://example.com/api"), /^  - url: https:\/\/example\.com$/m);

  const outputDir = await mkdtemp(path.join(root, ".docs-openapi-test-"));
  try {
    await prepareOpenApiSpecs({ root, outputDir, apiBaseUrl: "https://example.com/api" });
    for (const file of ["steamharness.zh.yaml", "steamharness.en.yaml"]) {
      const prepared = await readFile(path.join(outputDir, file), "utf8");
      assert.match(prepared, /^  - url: https:\/\/example\.com$/m);
      assert.doesNotMatch(prepared, /localhost:7125/u);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function writeDocsRelease(root, commitSha, body) {
  const releaseRoot = path.join(root, "releases", commitSha);
  await writeDocsSite(releaseRoot, commitSha, body);
  return releaseRoot;
}

async function writeDocusaurusBuild(siteRoot, body) {
  await Promise.all([
    mkdir(path.join(siteRoot, "en"), { recursive: true }),
    mkdir(path.join(siteRoot, "assets", "js"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(siteRoot, "index.html"),
      `<!doctype html><html><head><meta name="generator" content="Docusaurus v3.10.2"></head><body>${body}</body></html>\n`,
      "utf8",
    ),
    writeFile(path.join(siteRoot, "en", "index.html"), `<!doctype html><html><body>${body} EN</body></html>\n`, "utf8"),
    writeFile(path.join(siteRoot, "404.html"), "<!doctype html><html><body>Custom not found</body></html>\n", "utf8"),
    writeFile(path.join(siteRoot, "assets", "js", "app.12345678.js"), "console.log('docs');\n", "utf8"),
  ]);
}

async function writeDocsSite(siteRoot, commitSha, body) {
  await rm(siteRoot, { recursive: true, force: true });
  await writeDocusaurusBuild(siteRoot, body);
  await Promise.all([
    mkdir(path.join(siteRoot, "guides", "studio", "overview"), { recursive: true }),
    mkdir(path.join(siteRoot, ".workflow"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(siteRoot, "guides", "studio", "overview", "index.html"),
      "<!doctype html><html><body>Studio overview</body></html>\n",
      "utf8",
    ),
    writeFile(path.join(siteRoot, "deployment.json"), `${JSON.stringify({
      schemaVersion: 1,
      framework: "docusaurus",
      commitSha,
    })}\n`, "utf8"),
    cp(path.join(root, "scripts", "activate-docs.mjs"), path.join(siteRoot, ".workflow", "activate-docs.mjs")),
    cp(path.join(root, "scripts", "serve-docs.mjs"), path.join(siteRoot, ".workflow", "serve-docs.mjs")),
  ]);
}

test("OpenAPI docs generation drops only the per-artifact lines", () => {
  const chunks = [];
  const filter = createArtifactFilter((suppressed) => chunks.push(`Generated ${suppressed} OpenAPI docs artifacts.`));
  const output = [
    filter.push('Successfully created "./reference"\nCleanup succeeded for "./reference/sidebar.ts"\n'),
    filter.push("Successfully created \"./reference/list-workflows.api.mdx\"\nCould not merge values, they are probably incompatible\n"),
    filter.flush(),
  ].join("");
  assert.equal(output, "Could not merge values, they are probably incompatible\n");
  filter.report();
  assert.deepEqual(chunks, ["Generated 3 OpenAPI docs artifacts."]);
});

test("OpenAPI docs generation holds a trailing partial line until the stream ends", () => {
  const chunks = [];
  const filter = createArtifactFilter((suppressed) => chunks.push(`Generated ${suppressed} OpenAPI docs artifacts.`));
  assert.equal(filter.push('Successfully created "./reference/a.json"\nKept without'), "");
  assert.equal(filter.flush(), "Kept without");
  filter.report();
  assert.deepEqual(chunks, ["Generated 1 OpenAPI docs artifacts."]);
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || address === null) throw new Error("Unable to reserve a TCP port.");
  return address.port;
}
