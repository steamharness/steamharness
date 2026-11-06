import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateDocs, validateStandaloneDocsSource } from "../validate-docs.mjs";

const root = path.resolve(import.meta.dirname, "../..");

test("Bot declarations use Core while conversation protocol terms remain valid", () => {
  for (const source of [
    'projectType: "conversation"',
    'steamharness.createAgentConversationProject({})',
    'steamharness.defineAgentConversationExecutor({})',
    'steamharness.defineExecutor({ projectType: "bot", workflow: custom })',
  ]) {
    assert.throws(() => validateStandaloneDocsSource("guide.mdx", source), /removed Bot declaration/u);
    assert.doesNotThrow(() => validateStandaloneDocsSource("guides/releases/core/v0.1.0.mdx", source));
  }
  assert.doesNotThrow(() => validateStandaloneDocsSource("guide.mdx",
    'steamharness.defineBot({}); conversationId; context.entries.conversations; presentation: "conversation"'));
});

test("current documentation rejects old project and storage contracts while preserving release history", () => {
  for (const source of ["steamHarness.projectType", "projectInfo.relatedProjects", "context.storage.local", "--project-group", "dataStorage.mode"]) {
    assert.throws(() => validateStandaloneDocsSource("concepts/example.mdx", source), /removed single-entry project/);
    assert.doesNotThrow(() => validateStandaloneDocsSource("guides/releases/core/v0.1.0.mdx", source));
  }
});

test("OpenAPI languages expose the same aggregate and database endpoints", async () => {
  const specs = await Promise.all(["", "en/"].map(prefix => readFile(path.join(root, prefix, "openapi/steamharness.openapi.yaml"), "utf8")));
  const paths = source => [...source.matchAll(/^  (\/[^\n]+):$/gmu)].map(match => match[1]).sort();
  assert.deepEqual(paths(specs[0]), paths(specs[1]));
  for (const source of specs) {
    assert.match(source, /\/api\/databases\/bindings\/resolve/u);
    assert.match(source, /\/api\/databases\/\{databaseId\}\/query/u);
    assert.doesNotMatch(source, /database-spaces|KVEntry|ProjectDataSummary|kv\.getValue|kv\.setValue/u);
    assert.match(source, /accessRevision/u);
    assert.match(source, /\/api\/projects\/\{projectId\}\/entries\/\{entryId\}\/resources\/read/u);
    assert.doesNotMatch(source, /related-projects|ProjectDependencyLock|ProjectStorageRequest|dataStorage/u);
  }
});

test("public docs validate paired navigation, pages, links, and OpenAPI files", async () => {
  const result = await validateDocs({ root });
  assert.deepEqual(result.languages, ["zh-Hans", "en"]);
  assert.ok(result.pages > 0);
  assert.equal(result.openapiFiles, 2);
});

test("public docs no longer ship a Docusaurus site", async () => {
  for (const relativePath of [
    "package.json",
    "docusaurus.config.mjs",
    "sidebars.zh.mjs",
    "plugins",
    "src",
  ]) {
    await assert.rejects(lstat(path.join(root, relativePath)), { code: "ENOENT" });
  }
});

test("Studio documentation replaces Desktop navigation in both languages", async () => {
  const navigation = await readFile(path.join(root, "docs.json"), "utf8");
  assert.doesNotMatch(navigation, /guides\/(?:desktop\/|releases\/(?:desktop|downloads))/u);
  for (const prefix of ["", "en/"]) {
    assert.ok(navigation.includes(`${prefix}guides/studio/overview`));
    const overview = await readFile(path.join(root, prefix, "guides/studio/overview.mdx"), "utf8");
    for (const page of ["run-debug", "installation"]) {
      assert.ok(overview.includes(`/${prefix}guides/studio/${page}`));
      assert.ok(navigation.includes(`${prefix}guides/studio/${page}`));
    }
    const runtime = await readFile(path.join(root, prefix, "guides/studio/run-debug.mdx"), "utf8");
    const installation = await readFile(path.join(root, prefix, "guides/studio/installation.mdx"), "utf8");
    assert.match(runtime, /@steamharness\/cli/u);
    assert.match(installation, /npm run dev:web/u);
  }
});

test("public docs reject removed Desktop Web and legacy monorepo references", () => {
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
