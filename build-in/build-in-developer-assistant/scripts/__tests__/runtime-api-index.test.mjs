import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRuntimeApiIndex,
  readRelatedProjectMembers,
  readRuntimeApiIndex,
  readRuntimeNamespaceMembers,
  renderRuntimeApiIndex,
  writeRuntimeApiIndex,
} from "../runtime-api-index.mjs";

/** A Core source tree holding just the files the readers look at. */
async function createCoreSource(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runtime-api-index-"));
  await mkdir(path.join(dir, "kv"), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, relative), contents, "utf8");
  }
  return dir;
}

/**
 * The assistant answers "does the runtime support X?" by reading this, so it
 * has to be true. Everything in it comes from Core's source rather than from
 * anyone's memory of it, and these tests are what keeps the two together.
 */
describe("the runtime API index", () => {
  it("matches Core's runtime", async () => {
    const { differences } = await checkRuntimeApiIndex();

    expect(differences).toEqual([]);
  });

  it("says what a related project exposes and what it does not", async () => {
    const { relatedContext } = await readRuntimeApiIndex();
    const storage = relatedContext.find((context) => context.name === "RelatedProjectStorageContext");
    const signatures = storage.members.map((member) => member.signature);

    expect(signatures).toContain("kv");
    expect(signatures).toContain("knowledge");
    expect(signatures).toContain("runEntrypoint(entrypointId, args)");
    // The line the surface must not cross: a relation is not a way to read the
    // target's conversation, and it is not a way to reach a third project.
    expect(signatures).not.toContain("conversation");
    expect(signatures).not.toContain("relatedProjects");
  });

  it("carries the boundary in words, next to the list", async () => {
    const index = await renderRuntimeApiIndex();

    expect(index).toContain("这里没有列出的能力就是没有");
    expect(index).toContain("只走一跳");
    expect(index).toContain("会话 KV");
  });

  // A member the reader cannot name would vanish from both artifacts while the
  // drift check still passed — it compares this script's output with itself —
  // so the assistant would be told a capability does not exist. Loud is the
  // only safe answer, and these are the shapes that would do it.
  it("refuses a runtime member it cannot name", async () => {
    const coreSource = await createCoreSource({
      "runtime-api.ts": "const outer = {};\nconst workflowRuntimeApi = { ...outer, defineWorkflow };\n",
    });

    await expect(readRuntimeNamespaceMembers(coreSource)).rejects.toThrow(/cannot read/);
  });

  it("refuses a context member it cannot name", async () => {
    const coreSource = await createCoreSource({
      "kv/related-projects.ts": [
        "export interface RelatedProjectStorageContext { kv: string; [key: string]: unknown }",
        "export interface RelatedProjectKnowledgeContext { getDocument(id: string): void }",
        "export interface RelatedProjectRunner { run(id: string): void }",
      ].join("\n"),
    });

    await expect(readRelatedProjectMembers(coreSource)).rejects.toThrow(/cannot read/);
  });

  it("refuses a context that publishes no members", async () => {
    const coreSource = await createCoreSource({
      "kv/related-projects.ts": [
        "export interface RelatedProjectStorageContext { kv: string }",
        "export interface RelatedProjectKnowledgeContext {}",
        "export interface RelatedProjectRunner { run(id: string): void }",
      ].join("\n"),
    });

    await expect(readRelatedProjectMembers(coreSource)).rejects.toThrow(/no members to publish/);
  });

  it("refuses to overwrite a reference page it cannot find the generated block in", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runtime-api-index-page-"));
    const indexFile = path.join(dir, "runtime-api-index.md");
    await writeFile(indexFile, "# 手写的参考页\n\n没有生成标记。\n", "utf8");

    await expect(writeRuntimeApiIndex({
      indexFile,
      capabilitiesFile: path.join(dir, "capabilities.ts"),
    })).rejects.toThrow(/has no <!-- runtime-api-index:begin -->/);
  });

  it("leaves what is written around the generated block alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runtime-api-index-page-"));
    const indexFile = path.join(dir, "runtime-api-index.md");
    await writeFile(
      indexFile,
      "## 前言\n\n<!-- runtime-api-index:begin -->\n\nout of date\n\n<!-- runtime-api-index:end -->\n\n## 后记\n",
      "utf8",
    );

    const { written } = await writeRuntimeApiIndex({
      indexFile,
      capabilitiesFile: path.join(dir, "capabilities.ts"),
    });

    expect(written).toBe(true);
    const next = await checkRuntimeApiIndex({
      indexFile,
      capabilitiesFile: path.join(dir, "capabilities.ts"),
    });
    expect(next.differences).toEqual([]);
  });
});
