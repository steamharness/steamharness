import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { workflowRuntimeApi } from "steamharness/runtime-api";
import { inspectWorkflowStructure } from "steamharness/executor/rules";

// 这组断言守住 project assistant 生成器 skill 的契约：Core 新增运行时 API 或
// executor/entrypoint 定义字段后，只要依赖版本 bump 到包含该变化的 Core，
// 这里就会失败，直到 skill 文档补齐。文档被审计发现长期漂移过一次
// （入口分区 group、媒体输入输出、OpenAI Responses 网关等都曾长期缺失），
// 所以用测试代替人工记忆。

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "skills", "workflow-generator");

// 宿主内部面：由 Core 注入宿主使用，不面向项目源码，因此不要求出现在生成规则里。
const HOST_INTERNAL_RUNTIME_API = new Set<string>([]);

const DOCUMENTED_DEFINITION_TYPES = [
  "EntrypointDefinition",
  "EntrypointGroupDefinition",
  "ExecutorDefinition",
  "ParamDefinition",
  "ConversationDefinition",
  "ConversationUserInputDefinition",
  "ExecutorContext",
] as const;

async function readSkillCorpus(): Promise<string> {
  const referencesDir = path.join(skillRoot, "references");
  const referenceFiles = (await readdir(referencesDir)).filter((name) => name.endsWith(".md"));
  const parts = await Promise.all([
    readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    ...referenceFiles.map((name) => readFile(path.join(referencesDir, name), "utf8")),
  ]);
  return parts.join("\n");
}

// 用标识符边界而不是裸子串：`createOutputItem` 是 `createOutputItemChunk` 的前缀，
// 子串匹配会把未文档化的 API 误判成已覆盖。
function mentionsIdentifier(corpus: string, identifier: string): boolean {
  return new RegExp(`(?<![\\w.$-])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(corpus);
}

function resolveSteamHarnessTypeDefinitionFile(): string {
  // steamharness 的 exports 只声明了 types/import 条件，没有 require 条件，
  // 也没暴露 ./package.json；因此直接按 Node 解析规则从仓库根查找包目录。
  const manifestPath = [process.cwd(), root]
    .map((base) => path.join(base, "node_modules", "steamharness", "package.json"))
    .find((candidate) => existsSync(candidate));
  if (manifestPath === undefined) throw new Error("steamharness is not installed.");
  const packageRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { types?: string };
  if (typeof manifest.types !== "string") throw new Error("steamharness does not declare a types entry.");
  return path.join(packageRoot, manifest.types);
}

/**
 * Builds the type checker over the installed Core once.
 *
 * A program per question — the loop below asks one per definition type — parses
 * and binds the same declarations six times over, which put the test past
 * vitest's default timeout once Core's definitions grew: it failed on coverage
 * builds (instrumented, and slower) and passed on plain ones. Built once, the
 * cost is paid where it belongs.
 */
type DefinitionChecker = { check(typeName: string): string[]; hasExport(typeName: string): boolean };
let cachedDefinitionChecker: DefinitionChecker | undefined;

function createDefinitionChecker(): DefinitionChecker {
  if (cachedDefinitionChecker !== undefined) return cachedDefinitionChecker;
  const definitionFile = resolveSteamHarnessTypeDefinitionFile();
  const program = ts.createProgram([definitionFile], {});
  const sourceFile = program.getSourceFile(definitionFile);
  if (sourceFile === undefined) throw new Error("steamharness type definitions are unavailable.");
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) throw new Error("steamharness type definitions export nothing.");

  cachedDefinitionChecker = {
    hasExport(typeName: string): boolean {
      return checker.getExportsOfModule(moduleSymbol).some((symbol) => symbol.getName() === typeName);
    },
    check(typeName: string): string[] {
      const exported = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === typeName);
      if (exported === undefined) throw new Error(`${typeName} is not exported by steamharness.`);
      const type = checker.getDeclaredTypeOfSymbol(exported);
      return checker.getPropertiesOfType(type).map((property) => property.getName()).sort();
    },
  };
  return cachedDefinitionChecker;
}

describe("workflow-generator contract", () => {
  it("distinguishes binary file migration from project publication and global runtime discovery", async () => {
    const rules = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const prompt = await readFile(path.join(root, "assistant-prompt.ts"), "utf8");
    expect(rules).toContain("context.files");
    expect(rules).toContain("不属于全局成员清单");
    expect(rules).toContain("window.steamHarnessKanban.files.createFile");
    expect(rules).toContain("file-upload");
    expect(rules).toContain("file-download");
    expect(prompt).toContain("Binary uploads are distinct from project source publication");
    expect(prompt).toContain("verify the downloaded bytes");
    expect(prompt).toContain("never chunk binary images into KV");
  });
  it("routes API tasks to real references and exported Core types", { timeout: 15_000 }, async () => {
    const taskMap = await readFile(path.join(skillRoot, "references", "task-map.md"), "utf8");
    const prompt = await readFile(path.join(root, "assistant-prompt.ts"), "utf8");
    expect(prompt).toContain("references/task-map.md");

    for (const relative of [
      "references/runtime-api-index.md",
      "references/param-panels.md",
      "references/steamharness-api.md",
      "assets/examples/agent-conversation/index.ts",
      "scripts/create_workflow.py",
    ]) {
      expect(taskMap).toContain(relative.split("/").at(-1));
      expect(existsSync(path.join(skillRoot, relative)), `${relative} must exist`).toBe(true);
    }

    const { hasExport } = createDefinitionChecker();
    for (const name of [
      "EntrypointDefinition", "ExecutorDefinition", "ConversationExecutorDefinition",
      "ExecutorContext", "ParamDeclaration", "ParamResolverContext",
      "ParamResolveResult", "RunOutputPayload", "OutputItem",
      "RunContext", "RelatedProjectStorageContext", "AgentInput",
      "AgentOutputPayload", "AgentNodeOptions", "AgentProjectOptions", "RuntimeApi",
    ]) {
      expect(taskMap).toContain(name);
      expect(hasExport(name), `${name} must be exported by steamharness`).toBe(true);
    }
  });

  it("keeps the Agent project example statically discoverable", () => {
    const exampleDir = path.join(skillRoot, "assets", "examples", "agent-conversation");
    const structure = inspectWorkflowStructure({
      cwd: exampleDir,
      projectDir: exampleDir,
      projectName: "assistant",
    });

    expect(structure.diagnostics.violations).toEqual([]);
    expect(structure.projectType).toBe("conversation");
    expect(structure.params?.map((param) => param.name)).toEqual(["workdir", "provider", "model", "plan"]);
    expect(structure.paramLayout?.actions.map((action) => action.kind)).toEqual(["auxiliary", "quick", "slash"]);
    expect(structure.params?.find(param => param.name === "plan")).toMatchObject({ panel: "slash", type: "boolean", defaultValue: "false" });
    expect(structure.conversation?.footer).toEqual([{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" },
      when: { param: "plan", value: "true" } }]);
    expect(structure.conversation?.commands?.map(command => command.command)).toEqual(["export", "compact"]);
    expect(structure.conversation?.userInput).toEqual({ effects: [{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }] });
    expect(structure.tools?.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
    expect(structure.conversation?.openai?.outputItemId).toBe("assistant-answer");
    expect(structure.conversation?.recovery).toEqual({ enabled: true });
    expect(structure.tokenUsage).toEqual({ enabled: true, display: true });
  });

  it("documents every runtime API member of the pinned Core version", async () => {
    const corpus = await readSkillCorpus();
    const missing = Object.keys(workflowRuntimeApi)
      .filter((name) => !HOST_INTERNAL_RUNTIME_API.has(name))
      .filter((name) => !mentionsIdentifier(corpus, `workflow.${name}`));

    expect(missing, `skills/workflow-generator 未覆盖这些 workflow.* 成员：${missing.join(", ")}`).toEqual([]);
  });

  it("documents every executor, entrypoint and param definition field", async () => {
    const corpus = await readSkillCorpus();
    const { check } = createDefinitionChecker();
    const missing: string[] = [];
    for (const typeName of DOCUMENTED_DEFINITION_TYPES) {
      for (const field of check(typeName)) {
        if (!mentionsIdentifier(corpus, field)) missing.push(`${typeName}.${field}`);
      }
    }

    expect(missing, `skills/workflow-generator 未覆盖这些定义字段：${missing.join(", ")}`).toEqual([]);
  });

  // 这组断言来自一次真实排查：宿主（Desktop）把自己的 STEAMHARNESS_*_STORE_DIR 注入到
  // 小助手的 shell，项目里的 CLI 因此读写宿主自己的本地存储；把项目钉到旧版本后，
  // 旧 CLI 在共享根目录里读到当前版本写下的条目，直接以存储格式错误失败，而文档
  // 既没说清本地检查要隔离存储，也没说清精确版本要从哪条通道取，排查被带偏了很久。
  it("documents local-run storage isolation and exact-version resolution", async () => {
    const corpus = await readSkillCorpus();
    for (const token of [
      "STEAMHARNESS_KV_STORE_DIR",
      "STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR",
      "STEAMHARNESS_FILE_STORE_DIR",
      "Local workflow KV entry is invalid and cannot be read safely.",
      "dist-tags",
      "os.tmpdir()/steamharness-kv",
    ]) {
      expect(corpus, `skills/workflow-generator 未覆盖本地运行必需的事实：${token}`).toContain(token);
    }
    expect(corpus, "解析精确版本时不得把 registry 的 latest 标签当作版本来源").toContain("不要用 `latest`");
  });

  it("keeps the generator scaffold able to produce publishable package metadata", async () => {
    const script = await readFile(path.join(skillRoot, "scripts", "create_workflow.py"), "utf8");
    for (const required of ["projectCard", "release", "projectType"]) {
      expect(script, `create_workflow.py 未生成 steamHarness.${required}`).toContain(required);
    }
  });

  it("generates Conversations with only the standard message input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "workflow-standard-input-"));
    try {
      execFileSync("python3", [path.join(skillRoot, "scripts/create_workflow.py"), "standard-input", "--project-type", "conversation", "--dir", directory], { encoding: "utf8" });
      const structure = inspectWorkflowStructure({ cwd: directory, projectName: "standard-input", projectDir: directory });
      expect(structure.diagnostics.violations).toEqual([]);
      expect(structure.params ?? []).toEqual([]);
      expect(structure.conversation).toBeUndefined();
      const source = await readFile(path.join(directory, "index.ts"), "utf8");
      expect(source).toContain("workflow.parseConversationDefaultInputArgs(args).message");
      expect(await readFile(path.join(directory, "README.md"), "utf8")).toContain('steamharness run . -- --message "input text"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Desktop 的 check-desktop-identity 会扫描它自己的 skill 副本，命中已移除的 App
  // 标识就直接失败。skill 内容随制品发布并被同步进 desktop，所以必须在发布前拦住，
  // 否则会在发布之后才由 desktop CI 报错。
  it("does not reintroduce removed App identity markers", async () => {
    const referencesDir = path.join(skillRoot, "references");
    const files = [
      path.join(skillRoot, "SKILL.md"),
      ...(await readdir(referencesDir)).filter((name) => name.endsWith(".md")).map((name) => path.join(referencesDir, name)),
      path.join(skillRoot, "scripts", "create_workflow.py"),
    ];
    const forbidden: Array<[string, RegExp]> = [
      ["package", /@steamharness\/app\b/u],
      ["environment", /\b(?:STEAMHARNESS_APP_[A-Z0-9_]*|APP_LOCAL_[A-Z0-9_]*)\b/u],
      ["config-file", /\bworkflow-app\.json\b/u],
      ["runtime-helper", /\b(?:workflow\.)?isApp\s*(?:\(|:)/u],
      ["runtime-marker", /STEAMHARNESS_RUNTIME_PLATFORM\s*=\s*["'`]?app\b/u],
      ["runtime-value", /\b(?:runtime|platform)\s*[:=]\s*["'`]app["'`]/u],
      ["compatibility", /\b(?:minAppVersion|appVersion)\b/u],
    ];

    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const [kind, pattern] of forbidden) {
        if (pattern.test(content)) violations.push(`${kind}: ${path.relative(root, file)}`);
      }
    }

    expect(violations, `skill 内容重新引入了已移除的 App 标识：${violations.join(", ")}`).toEqual([]);
  });
});
