import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import ts from "typescript";

/**
 * Keeps the tool-authoring contract in the generator skill honest.
 *
 * `references/steamharness-api.md` has to describe what a custom tool looks
 * like, because that is what the assistant writes when a project needs one —
 * and the shape belongs to the SDK, not to us. A hand-copied version of it goes
 * wrong the first time pi renames a member, and goes wrong quietly: the
 * document still reads like a contract, and the code written against it stops
 * compiling.
 *
 * So the block in the document is generated from the installed types, and
 * `checkAgentToolContract` — run by `pnpm test` — compares the two. A member
 * added, renamed, retyped or removed fails the build and names it, and
 * `pnpm agent-tool-contract` writes the new block. The rules around it (write
 * JSON Schema rather than reaching for TypeBox, report errors instead of encoding
 * failures in `content`, declare the tool in `executor.tools`) are ours rather
 * than the SDK's, and stay hand-written.
 */

const root = path.resolve(import.meta.dirname, "..");

/** The document the contract lives in, and the fence it lives between. */
export const CONTRACT_FILE = path.join(
  root,
  "skills/steamharness-generator/references/steamharness-api.md",
);
const BEGIN_MARKER = "<!-- agent-tool-contract:begin -->";
const END_MARKER = "<!-- agent-tool-contract:end -->";

/**
 * Which package declares which interface.
 *
 * `AgentTool` extends `Tool`, and the two live in different packages, so both
 * are read. They are looked up beside the `steamharness` this project builds
 * against rather than by name from here: that is the version the host runs a
 * project on, and it is the one the document has to describe.
 */
const CONTRACT_INTERFACES = {
  Tool: "@earendil-works/pi-ai",
  AgentTool: "@earendil-works/pi-agent-core",
  AgentToolResult: "@earendil-works/pi-agent-core",
};

/**
 * The contract, as the document presents it.
 *
 * Every `source` is the declaration exactly as the SDK writes it (whitespace
 * collapsed, trailing semicolon dropped) and is compared against the installed
 * types — including the members marked `omit`. Those are left out of the
 * document because they name types a project cannot resolve, and publishing
 * them invites the reader to go looking for those instead of writing a tool;
 * they are still compared, because a rename is a change either way.
 */
export const AGENT_TOOL_CONTRACT = {
  Tool: {
    typeParameters: "TParameters extends TSchema = TSchema",
    members: [
      { source: "name: string", doc: "工具 id，模型看到的名字；必须与 executor.tools 声明里的 name 逐字一致。" },
      { source: "description: string", doc: "给模型看的一句话：什么时候该用它。" },
      { source: "parameters: TParameters", doc: "参数 schema：直接写一个 JSON Schema 对象，项目里没有 TypeBox 可用。" },
      { source: "constrainedSampling?: false | ConstrainedSamplingConfig", omit: true },
    ],
  },
  AgentTool: {
    typeParameters: "TParameters extends TSchema = TSchema, TDetails = any",
    typeParametersDoc: "TParameters = unknown, TDetails = any",
    extends: "Tool<TParameters>",
    members: [
      { source: "label: string", doc: "宿主 UI 里的展示名。" },
      { source: "prepareArguments?: (args: unknown) => Static<TParameters>", omit: true },
      { source: "outputSchema?: TSchema", render: "outputSchema?: object", doc: "structuredContent 的 JSON Schema。" },
      {
        source: "execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>",
        // The SDK's callback type is public but unnamed in any way a project
        // can use; spelling out what it takes is the whole signature.
        render: "execute: (toolCallId: string, params: TParameters, signal?: AbortSignal, onUpdate?: (partial: AgentToolResult<TDetails>) => void) => Promise<AgentToolResult<TDetails>>",
        doc: "执行。失败必须 throw 或设置 isError: true，不要只把错误写进 content。",
      },
      { source: 'replay?: "never" | "safe"', doc: "崩溃时结果未知的调用：默认 never，不自动重做；只有可安全重复的操作声明 safe。" },
      { source: "executionMode?: ToolExecutionMode", omit: true },
    ],
  },
  AgentToolResult: {
    typeParameters: "T = JsonValue | undefined",
    typeParametersDoc: "TDetails = any",
    members: [
      {
        source: "content: (TextContent | ImageContent)[]",
        // The two block types are described rather than renamed: they are the
        // SDK's, and a project that wanted to send an image back has to name
        // the same fields the SDK does.
        doc: '回给模型的内容块：`{ type: "text", text }`，或给模型看图时的 `{ type: "image", data, mimeType }`（`data` 为 base64）。',
      },
      { source: "details: T", render: "details: TDetails", doc: "给宿主渲染和日志用的结构化细节；模型看不到它。" },
      { source: "structuredContent?: JsonValue", render: "structuredContent?: unknown", doc: "匹配 outputSchema 的 JSON 结果；与给模型的 content 分开。" },
      { source: "usage?: Usage", omit: true },
      { source: "isError?: boolean", doc: "失败时设置 true。" },
      { source: "terminate?: boolean", omit: true },
    ],
  },
};

/** Interfaces a project writes, in the order the document shows them. */
const RENDERED_INTERFACES = ["AgentTool", "AgentToolResult"];

/** What the SDK calls a value that a plain JSON Schema describes. */
const SDL_INTERNAL_TYPES = /\b(TSchema|Static<|TypeboxLike|AgentToolUpdateCallback)\b/;

/** Reads the three interfaces out of the installed packages. */
export async function readAgentToolContract() {
  // Before reading anything: the SDK on disk has to be the one Core builds
  // against, or every member below describes a different version.
  for (const packageName of new Set(Object.values(CONTRACT_INTERFACES))) {
    await assertSdkMatchesCore(packageName);
  }
  const entries = await Promise.all(
    Object.entries(CONTRACT_INTERFACES).map(async ([name, packageName]) => [
      name,
      await readInterface(packageName, name),
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * Reports every way the installed types and the contract table disagree.
 *
 * All of them, not the first: one SDK upgrade can rename several members, and
 * seeing them together is what makes the fix a single edit.
 */
export async function compareAgentToolContract(contract = AGENT_TOOL_CONTRACT) {
  const declared = await readAgentToolContract();
  const differences = [];

  for (const [name, parsed] of Object.entries(declared)) {
    const entry = contract[name];
    const expected = [entry.typeParameters, ...entry.members.map((member) => member.source)];
    const actual = [parsed.typeParameters, ...parsed.members].filter((text) => text !== "");
    if (entry.extends !== undefined) expected.push(entry.extends);
    if (parsed.heritage !== "") actual.push(parsed.heritage);

    for (const source of expected) {
      if (!actual.includes(source)) differences.push(`${name} no longer declares "${source}"`);
    }
    for (const source of actual) {
      if (!expected.includes(source)) differences.push(`${name} declares "${source}", which the contract table does not list`);
    }
  }

  return differences;
}

/** The markdown block the document carries, generated from the table. */
export async function renderAgentToolContract() {
  const version = await readPackageVersion("@earendil-works/pi-agent-core");
  const lines = [
    "```ts",
    `// 本段由 scripts/agent-tool-contract.mjs 依据 @earendil-works/pi-agent-core@${version} 生成。`,
    "// 要改就改脚本里的契约表并运行 `pnpm agent-tool-contract`；手改会在 `pnpm test` 里失败。",
  ];

  for (const [index, name] of RENDERED_INTERFACES.entries()) {
    if (index > 0) lines.push("");
    const declared = AGENT_TOOL_CONTRACT[name];
    // `AgentTool` carries `Tool`'s members inline: a project writes one object,
    // not two, and `Tool` is not an interface it ever names.
    const members = name === "AgentTool"
      ? [...AGENT_TOOL_CONTRACT.Tool.members, ...declared.members]
      : declared.members;

    lines.push(`interface ${name}<${declared.typeParametersDoc ?? declared.typeParameters}> {`);
    for (const member of members) {
      if (member.omit === true) continue;
      const rendered = substitute(member.render ?? member.source);
      lines.push(member.doc === undefined ? `  ${rendered};` : `  /** ${member.doc} */\n  ${rendered};`);
    }
    lines.push("}");
  }

  lines.push("```");
  return [BEGIN_MARKER, ...lines, END_MARKER].join("\n");
}

/**
 * Compares the document with the types.
 *
 * `differences` empty means the two agree; otherwise it names what changed, so
 * the failure reads as instructions rather than as a checksum mismatch.
 */
export async function checkAgentToolContract() {
  const document = await readFile(CONTRACT_FILE, "utf8");
  const begin = document.indexOf(BEGIN_MARKER);
  const end = document.indexOf(END_MARKER);
  if (begin === -1 || end === -1) {
    throw new Error(
      `${path.relative(root, CONTRACT_FILE)} has no ${BEGIN_MARKER} … ${END_MARKER} block.`,
    );
  }

  const differences = await compareAgentToolContract();
  const expected = await renderAgentToolContract();
  if (document.slice(begin, end + END_MARKER.length) !== expected) {
    differences.push("the generated block in the document is not what the contract table renders");
  }

  return { differences, expected };
}

/** Rewrites the block; `written` says whether anything had to change. */
export async function writeAgentToolContract() {
  const { differences, expected } = await checkAgentToolContract();
  if (differences.length === 0) {
    return { written: false, differences };
  }

  const document = await readFile(CONTRACT_FILE, "utf8");
  const begin = document.indexOf(BEGIN_MARKER);
  const end = document.indexOf(END_MARKER);
  await writeFile(
    CONTRACT_FILE,
    `${document.slice(0, begin)}${expected}${document.slice(end + END_MARKER.length)}`,
    "utf8",
  );
  return { written: true, differences };
}

/**
 * Turns the SDK's spelling of a member into the one a project reads.
 *
 * `Static<T>` resolves a TypeBox type to the value it describes. A project
 * hands over a plain JSON Schema and receives that schema's own shape, so the
 * member is written with the type parameter — for the same reason the document
 * tells the reader to skip `Type` entirely. A member that still names an
 * SDK-internal type after this fails loudly rather than being published.
 */
function substitute(text) {
  const rendered = (text.replaceAll("Static<TParameters>", "TParameters"));
  if (SDL_INTERNAL_TYPES.test(rendered)) {
    throw new Error(
      `The contract cannot be written without naming SDK-internal types: "${text}". `
      + "Teach scripts/agent-tool-contract.mjs how to translate them.",
    );
  }
  return rendered;
}

async function readInterface(packageName, interfaceName) {
  const file = await findPackageFile(packageName, "dist/types.d.ts");
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);

  for (const node of source.statements) {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== interfaceName) continue;
    return {
      typeParameters: (node.typeParameters ?? [])
        .map((parameter) => normalize(parameter.getText(source)))
        .join(", "),
      heritage: node.heritageClauses === undefined
        ? ""
        : normalize(
            node.heritageClauses
              .map((clause) => clause.getText(source).replace(/^extends\s+/, ""))
              .join(" "),
          ),
      members: node.members.map((member) => normalize(member.getText(source))).filter((text) => text !== ""),
    };
  }

  throw new Error(`${packageName} does not declare ${interfaceName} any more.`);
}

/** Whitespace and a trailing semicolon only: reformatting the SDK is not a change. */
function normalize(text) {
  return text.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

async function readPackageVersion(packageName) {
  const file = await findPackageFile(packageName, "package.json");
  return JSON.parse(await readFile(file, "utf8")).version;
}

/**
 * The SDK a contract describes is the one `steamharness` builds against, so a
 * copy that only *looks* like it is worse than none: on the release channels
 * there is no sibling checkout to read it from, and this project's own
 * `node_modules` is then the only copy — which may resolve a different version
 * than the Core the host runs. The version `steamharness` declares is what
 * pins the two together, so a Core that moves to a new one fails here instead
 * of silently describing the wrong SDK.
 */
export async function assertSdkMatchesCore(packageName) {
  const coreManifest = JSON.parse(await readFile(await findPackageFile("steamharness", "package.json"), "utf8"));
  const declared = [coreManifest.dependencies, coreManifest.devDependencies, coreManifest.peerDependencies]
    .map((section) => section?.[packageName])
    .find((value) => typeof value === "string");
  if (declared === undefined) {
    throw new Error(`steamharness no longer declares ${packageName}; the tool contract cannot say which SDK to describe.`);
  }
  const installed = await readPackageVersion(packageName);
  if (!semver.satisfies(installed, declared)) {
    throw new Error(
      `${packageName} ${installed} is installed, but steamharness declares ${declared}; `
      + "update this project's devDependency to match before regenerating the tool contract.",
    );
  }
  return { declared, installed };
}

/**
 * Locates a file inside a package, in the layouts this repo can be installed
 * in: beside `steamharness` (which is what resolves at runtime), hoisted to
 * the top level, or only in pnpm's virtual store.
 */
async function findPackageFile(packageName, relativeFile) {
  const candidates = [
    path.join(root, "node_modules/steamharness/node_modules", packageName, relativeFile),
    path.join(root, "node_modules", packageName, relativeFile),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }

  const store = path.join(root, "node_modules/.pnpm");
  const prefix = `${packageName.replace("/", "+")}@`;
  const stored = [];
  for (const entry of await readdir(store).catch(() => [])) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = path.join(store, entry, "node_modules", packageName, relativeFile);
    if (await isFile(candidate)) stored.push(candidate);
  }
  // Nothing above resolved, so the copy in the store is a guess. Several
  // versions at once means the guess is between a version this project runs and
  // one it does not, and the contract would describe the wrong SDK.
  if (stored.length > 1) {
    throw new Error(
      `Cannot tell which ${packageName} ${root} resolves; ${stored.length} copies are installed:\n  - ${stored.sort().join("\n  - ")}`,
    );
  }
  if (stored.length === 1) return stored[0];

  throw new Error(`Cannot find ${packageName}/${relativeFile} from ${root}.`);
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.includes("--fix")) {
    const { differences, written } = await writeAgentToolContract();
    console.log(written
      ? `Regenerated the agent tool contract in ${path.relative(root, CONTRACT_FILE)}:`
      : "The agent tool contract already matched the installed SDK types.");
    for (const difference of differences) console.log(`  - ${difference}`);
    return;
  }

  const { differences } = await checkAgentToolContract();
  if (differences.length === 0) {
    console.log("The agent tool contract matches the installed SDK types.");
    return;
  }

  console.error("The agent tool contract is out of date with the installed SDK types:");
  for (const difference of differences) console.error(`  - ${difference}`);
  console.error("Run `pnpm agent-tool-contract` to regenerate it.");
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
