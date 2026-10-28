import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { resolveSiblingWorkspaceRoot } from "./prepare-local-siblings.mjs";

/**
 * Generates what the runtime can do, from the runtime itself.
 *
 * The assistant's worst habit — and the one that costs the most turns — is
 * answering "does SteamHarness support X?" by opening an installed
 * `steamharness` and grepping its build output. It does that because nothing
 * it reads first states the surface: the skill describes each feature, and a
 * feature that is *missing* has no page saying so.
 *
 * So the surface is generated instead of described. Two artifacts come out of
 * this one source: a reference in the skill, and a short block the system
 * prompt carries — the prompt one matters most, because the prompt is read
 * before any tool call, which is exactly when the assistant decides whether to
 * go looking.
 *
 * Everything here is derived from Core's own source: the members of the
 * `workflow` namespace, and the members of the entry and database contexts it
 * hands a run. Nothing is editorial, so nothing here can quietly disagree with
 * the runtime — a renamed member fails `pnpm test` and `pnpm runtime-api-index`
 * writes the new text.
 */

const root = path.resolve(import.meta.dirname, "..");

/** Where the generated artifacts live. */
const INDEX_FILE = path.join(
  root,
  "skills/workflow-generator/references/runtime-api-index.md",
);
const CAPABILITIES_FILE = path.join(root, "runtime-capabilities.generated.ts");

/** The harness source, which everything below is read from. */
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const HARNESS_SOURCE = path.join(resolveSiblingWorkspaceRoot(root, manifest), "harness", "src");

const BEGIN_MARKER = "<!-- runtime-api-index:begin -->";
const END_MARKER = "<!-- runtime-api-index:end -->";

const RESOURCE_INTERFACES = [
  { file: "entries/index.ts", name: "EntriesContext", title: "聚合入口目录" },
  { file: "entries/index.ts", name: "EntryContext", title: "Workflow 入口" },
  { file: "databases/index.ts", name: "DatabasesContext", title: "数据库目录" },
  { file: "databases/index.ts", name: "DatabaseContext", title: "独立数据库空间" },
  { file: "databases/index.ts", name: "DatabaseKnowledgeContext", title: "知识库与附件" },
];

export async function readRuntimeApiIndex() {
  const [runtimeMembers, resourceContexts] = await Promise.all([
    readRuntimeNamespaceMembers(), readResourceContextMembers(),
  ]);
  return { runtimeMembers, resourceContexts };
}

/** The `steamharness.*` members a project may call. */
export async function readRuntimeNamespaceMembers(coreSource = HARNESS_SOURCE) {
  const file = path.join(coreSource, "runtime-api.ts");
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(source) !== "projectRuntimeApi") continue;
      const initializer = declaration.initializer;
      if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) continue;
      // Every member has to be a name this script can read. A spread or a
      // computed key would otherwise be dropped from both artifacts in
      // silence, and the drift check compares this script's output with
      // itself, so nothing downstream would notice the missing capability.
      return initializer.properties.map((property) => {
        if (property.name === undefined || !ts.isIdentifier(property.name)) {
          throw new Error(
            `runtime-api.ts declares projectRuntimeApi with a member this script cannot read: ${property.getText(source)}`,
          );
        }
        return property.name.text;
      });
    }
  }

  throw new Error("runtime-api.ts no longer declares projectRuntimeApi as an object literal.");
}

/** Parse the public entry and database interfaces without dropping unknown members. */
export async function readResourceContextMembers(coreSource = HARNESS_SOURCE) {
  return Promise.all(RESOURCE_INTERFACES.map(async ({ file: relative, name: interfaceName, title }) => {
    const file = path.join(coreSource, relative);
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName);
    if (!declaration) throw new Error(`${relative} no longer declares ${interfaceName}.`);
    // An empty interface renders as an empty list here and as an empty
    // sentence in the prompt, which reads as "this is not available" — the
    // opposite of what the assistant should conclude.
    if (declaration.members.length === 0) {
      throw new Error(`${relative} declares ${interfaceName} with no members to publish.`);
    }
    return {
      name: interfaceName,
      title,
      members: declaration.members.map((member) => {
        if (member.name === undefined) {
          throw new Error(
            `${relative} declares ${interfaceName} with a member this script cannot read: ${member.getText(source)}`,
          );
        }
        const name = member.name.getText(source);
        const parameters = ts.isMethodSignature(member)
          ? member.parameters.map((parameter) => parameter.name.getText(source)).join(", ")
          : undefined;
        return {
          signature: parameters === undefined ? name : `${name}(${parameters})`,
          text: member.getText(source).replace(/\s+/g, " ").trim(),
        };
      }),
    };
  }));
}

/** The skill's reference page. */
export async function renderRuntimeApiIndex() {
  const { runtimeMembers, resourceContexts } = await readRuntimeApiIndex();
  const lines = [
    BEGIN_MARKER,
    "",
    "# 运行时 API 索引（生成物）",
    "",
    "由 `scripts/runtime-api-index.mjs` 依据 Core 源码生成，`pnpm test` 校验它与运行时一致。",
    "**判断「运行时有没有某个能力」时先读这里**，不要去安装包的 `dist/*.d.ts` 或打包产物里翻：",
    "那是某个历史版本的构建产物，不是契约，而且答案就在下面。这里没有列出的能力就是没有。",
    "",
    "## 聚合入口与数据库（`context.entries` / `context.databases`）",
    "",
  ];

  for (const context of resourceContexts) {
    lines.push(`### ${context.title}（\`${context.name}\`）`, "");
    for (const member of context.members) {
      lines.push(`- \`${member.signature}\``);
    }
    lines.push("");
  }

  lines.push(
    "数据库按 alias 访问，根 config.json 集中记录 alias 与已获批的 databaseId，各入口在 steamharness.json 中仅声明使用的数据库别名；父项目显式登记子目录后才加载其配置，STEAMHARNESS_PROJECT_CONFIG 可覆盖部署值。支持多库和跨入口共享，权限由宿主维护。每次访问重新校验授权。",
    "会话 KV 按 projectId + entryId + conversationId 隔离。跨入口调用保留用户身份、取消信号与工具权限，加载目标配置快照。",
    "",
    "## 运行时成员（`steamharness.*`）",
    "",
    "项目源码里能调用的运行时成员，除此之外的 `steamharness.*` 都不存在：",
    "",
    ...runtimeMembers.map((name) => `- \`steamharness.${name}(...)\``),
    "",
    "每个成员的契约（参数、返回值、错误码）在 `references/steamharness-api.md` 里按小节说明。",
    "",
    END_MARKER,
  );

  return lines.join("\n");
}

/** The block the assistant's system prompt carries: short, and only what it acts on. */
export async function renderRuntimeCapabilities() {
  const { resourceContexts } = await readRuntimeApiIndex();
  return [
    "// Generated by scripts/runtime-api-index.mjs from Core's source. Do not edit.",
    "export const RUNTIME_CAPABILITIES = `Runtime surface (generated from Core):",
    ...resourceContexts.map(context => `- ${context.name}: ${context.members.map(member => member.signature).join(", ")}.`),
    "- context.entries.get(entryId) calls Workflow operations inside this aggregate with the original actor and tool restrictions.",
    "- context.databases.get(alias) resolves a project alias to its databaseId; root config.json only stores alias-to-ID mappings, package entries list the aliases they use, STEAMHARNESS_PROJECT_CONFIG overrides deployment values, and hosts maintain all permissions.",
    "- Database grants are rechecked on every access; knowledge and attachments require knowledge permissions.",
    "`;", "",
  ].join("\n");
}

export async function checkRuntimeApiIndex(options = {}) {
  const indexFile = options.indexFile ?? INDEX_FILE;
  const capabilitiesFile = options.capabilitiesFile ?? CAPABILITIES_FILE;
  const [index, capabilities] = await Promise.all([
    readFile(indexFile, "utf8").catch(() => undefined),
    readFile(capabilitiesFile, "utf8").catch(() => undefined),
  ]);
  const [expectedIndex, expectedCapabilities] = await Promise.all([
    renderRuntimeApiIndex(),
    renderRuntimeCapabilities(),
  ]);

  const differences = [];
  if (index === undefined) {
    differences.push(`${path.relative(root, indexFile)} does not exist`);
  } else {
    const begin = index.indexOf(BEGIN_MARKER);
    const end = index.indexOf(END_MARKER);
    if (begin === -1 || end === -1) {
      differences.push(`${path.relative(root, indexFile)} has no generated block`);
    } else if (index.slice(begin, end + END_MARKER.length) !== expectedIndex) {
      differences.push(`${path.relative(root, indexFile)} no longer matches Core`);
    }
  }
  if (capabilities !== expectedCapabilities) {
    differences.push(`${path.relative(root, capabilitiesFile)} no longer matches Core`);
  }

  return { differences, expectedIndex, expectedCapabilities };
}

export async function writeRuntimeApiIndex(options = {}) {
  const indexFile = options.indexFile ?? INDEX_FILE;
  const capabilitiesFile = options.capabilitiesFile ?? CAPABILITIES_FILE;
  const { differences, expectedIndex, expectedCapabilities } = await checkRuntimeApiIndex({
    indexFile,
    capabilitiesFile,
  });
  if (differences.length === 0) {
    return { written: false, differences };
  }

  const existing = await readFile(indexFile, "utf8").catch(() => undefined);
  const begin = existing?.indexOf(BEGIN_MARKER) ?? -1;
  const end = existing?.indexOf(END_MARKER) ?? -1;
  if (existing !== undefined && (begin === -1 || end === -1)) {
    // Writing the generated block alone would throw away every hand-written
    // word around it. The markers are the only thing that says where the
    // generated part starts, so their absence is what has to be fixed first.
    throw new Error(
      `${path.relative(root, indexFile)} has no ${BEGIN_MARKER} / ${END_MARKER} block to replace.`,
    );
  }
  const nextIndex = existing === undefined
    ? `${expectedIndex}\n`
    : `${existing.slice(0, begin)}${expectedIndex}${existing.slice(end + END_MARKER.length)}`;

  await writeFile(indexFile, nextIndex, "utf8");
  await writeFile(capabilitiesFile, expectedCapabilities, "utf8");
  return { written: true, differences };
}

async function main() {
  if (process.argv.includes("--fix")) {
    const { differences, written } = await writeRuntimeApiIndex();
    console.log(written
      ? `Regenerated the runtime API index:\n  - ${differences.join("\n  - ")}`
      : "The runtime API index already matches Core.");
    return;
  }

  const { differences } = await checkRuntimeApiIndex();
  if (differences.length === 0) {
    console.log("The runtime API index matches Core.");
    return;
  }
  console.error("The runtime API index is out of date with Core:");
  for (const difference of differences) console.error(`  - ${difference}`);
  console.error("Run `pnpm runtime-api-index` to regenerate it.");
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
