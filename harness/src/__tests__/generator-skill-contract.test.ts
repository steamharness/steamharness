import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { workflowRuntimeApi } from "../runtime-api";

// Core 是运行时 API 的唯一来源，而面向项目生成 agent 的 workflow-code-generator
// skill 在三个仓库里各有一份 vendored 副本。新增或改名运行时 API 时，若不同步
// 这份生成规则，小助手就会继续按旧契约生成项目（历史上入口分区、媒体输入输出、
// OpenAI Responses 网关都长期缺失过）。这里在 Core 侧当场失败，把修复入口
// 明确指到下面这个文件。

const skillRoot = path.resolve(import.meta.dirname, "../../.agents/skills/workflow-code-generator");
const apiReferencePath = path.join(skillRoot, "references", "steamharness-api.md");
const skillPath = path.join(skillRoot, "SKILL.md");

function mentionsWorkflowMember(corpus: string, member: string): boolean {
  // 用标识符边界而不是裸子串：`createOutputItem` 是 `createOutputItemChunk` 的前缀。
  return new RegExp(`workflow\\.${member}(?![\\w-])`).test(corpus);
}

test("the vendored generator skill documents every runtime API member", async () => {
  const referenceFiles = (await readdir(path.join(skillRoot, "references")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(skillRoot, "references", name));
  const corpus = (
    await Promise.all([skillPath, apiReferencePath, ...referenceFiles].map((file) => readFile(file, "utf8")))
  ).join("\n");

  const missing = Object.keys(workflowRuntimeApi).filter((name) => !mentionsWorkflowMember(corpus, name));

  assert.deepEqual(
    missing,
    [],
    `新增或改名了运行时 API，但没有更新 ${path.relative(process.cwd(), apiReferencePath)}：${missing.join(", ")}。`
      + "同步 Core、Desktop 与 build-in-developer-assistant 三份 generator skill 副本后再提交。",
  );
});
