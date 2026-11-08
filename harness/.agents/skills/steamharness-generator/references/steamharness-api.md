# steamharness API 参考

## 源码约定

workflow 源码是自包含业务代码。本地宿主和 CLI 把 runtime API 作为名为 `steamharness` 的全局命名空间注入；Server 只保存源码与数据。

不要在 workflow 源码中从 `"steamharness"` 导入 runtime API。Workflow、Conversation 和 Kanban 的 `package.json` 都必须在 `devDependencies` 中精确记录 `steamharness` 与 `@steamharness/cli` 版本；Core 用于宿主兼容判断，CLI 独立发版并提供外层 `steamharness` 命令。

## SteamHarness Database 定义与生成

关系模型使用 `steamharness/database` 的 `defineDatabase({schema:"./database/main/steamharness.schema"})`（默认别名 main）或 `defineDatabases({main:{schema:"./database/main/steamharness.schema"},audit:{schema:"./database/audit/steamharness.schema"}})`，默认导出到 `steamharness.database.ts`。模型文件统一叫 `steamharness.schema`，只写 Prisma 模型、枚举、关系和约束，不写 datasource、generator、连接 URL、资源 ID 或凭据。生成固定 PostgreSQL / Prisma 7.10.1；多个别名可复用 schema，但各自保留独立描述符。

命令为 `steamharness database init|validate|generate [aggregate-directory] [--entry <entryId>]`，简写 `steamharness db`。init 不覆盖已有定义，为已有 dev/build 脚本加入生成前置步骤。手写定义后，类型检查与构建前先 generate；生成目录 `dist/steamharness/generated/database` 加入 `.gitignore`，不加入 `.steamharnessignore`。Node 使用 `node/index.js`，Browser 使用 `browser/index.js`。模型与输入类型从对应 `<target>/<alias>.js` 导入，`DatabaseClient<typeof main>` 从 `steamharness/database` 获得该库查询类型。两个库可分别定义不同的 User；不能混用字段。模型名首字母小写后必须唯一，不得为 constructor、prototype、__proto__、then 或 transaction；例如 User/user 不能在同库共存，Transaction 也不可用。

Browser 描述符不得加载 Node 客户端、驱动或连接配置。生成产物含 JS 与 TS、模型元数据、标准内部 schema、引擎运行资产及校验清单，不手动维护。workspace pack 自动为根和注册入口生成并带入产物；Server 只校验静态文件，不执行定义。失败保持上一份完整生成，去掉别名后重新生成清理旧产物。

资源管理使用 `steamharness database create|list|inspect|retry|grant|revoke`，迁移使用 `migrate dev|deploy|status --database <uuid> [--alias main]`；`dev --draft` 保存 SQL、模型快照和校验清单，资源需要目标 Server 的账号授权。不同资源对应独立 PostgreSQL database；创建者是唯一迁移所有者。已应用历史不可修改，漂移、破坏性变更和失败重试需遵循公开数据库文档。Node 项目使用 `const db = await context.databases.connect(main)`，main 从生成的 `node/index.js` 导入。db 仅暴露模型 CRUD、关系、聚合和 `transaction(async tx => ...)`；事务结束后不能保留 tx，不暴露 SQL、PrismaClient 或连接池。先 migrate，再通过 `database bind <aggregate-root> --entry <id> --alias main --database <uuid> [--mode read]` 建立宿主绑定；bindings/unbind 使用同样的目录和入口。关系别名在入口 manifest.databases 声明为字符串数组，不写 config.databases，宿主按当前账号 + projectId + entryId + alias 存映射，映射不能授予资源权限。同别名跨项目和入口独立，只有显式同 UUID 才共享。每次查询与事务提交检查绑定、权限和 schemaHash；绑定变化须显式重新 connect，撤销会中断 SQL 并回滚事务。运行结束和取消由宿主释放；不自动重放写入，不回退本地存储。Browser 描述符通过宿主查询代理访问模型 rows/insert/update/delete；不能把描述符当作资源身份或授权。旧 KV、PersistentValue、本地 KV 与 KV 工具已删除，无兼容入口或自动迁移。

## 用户设置与权限继承

项目用 `steamharness.getUserSettings(): UserSettings` 读取当前执行的只读快照，形状为 `{ readonly agent: { readonly permissionPolicy: AgentPermissionPolicy; readonly models?: readonly Readonly<UserAgentModel>[] } }`。`AgentPermissionPolicy` 仍只有 `"read-only" | "workspace" | "auto"`。宿主从 SDK 导入 `withUserSettings<T>(settings: UserSettings, run: () => T): T` 注入执行上下文，或用 `parseUserSettings(value: unknown): UserSettings` 校验并复制冻结输入；这两个宿主 API 不注入项目命名空间。非法值（包括用户设置中的 `inherit`）直接抛 `TypeError`，并发上下文互不覆盖；无宿主时 `getUserSettings()` 返回 `auto`。

Agent 输入、运行时／节点选项和项目权限参数使用 `AgentPermissionPolicySetting = AgentPermissionPolicy | "inherit"`。本轮输入优先于开发者默认；两处都不填仍默认 `workspace`。只有选中的值为 `inherit` 才读取用户设置，无宿主时回退 `auto`。参数与会话保存原始 `inherit`，在实际执行时解析；工具筛选、路径范围和运行时初始化必须使用同一个具体权限值。

Studio 在用户级 `studio.agent.permissionPolicy` 保存设置，默认 `auto`，工作区配置不能覆盖。内置小助手使用 `userSetting: { key: "agent.permissionPolicy", mode: "fixed" }`，直接显示具体权限并跳转设置，不显示额外继承选项；固定绑定忽略已保存覆盖值；编码工具、提示词与 Studio Control 使用同一快照。当前及后台、子任务不随设置变化；持久会话在任务全部结束、空闲后重挂载原数据库，再处理等待新设置的输入。恢复保留启动快照、历史、队列与请求身份。CLI Web 承接宿主注入与能力握手更新，独立 CLI 本期不保存此偏好。

## 版本兼容与宿主门禁

精确依赖与运行兼容是两个不同约束：

- 项目必须写完整的 `devDependencies.steamharness`，例如 `"0.2.7"` 或 `"0.2.7-20260826001"`。`^0.2.7`、`0.2.x`、`workspace:*`、`file:` 和其它 range 都是无效项目声明。`@steamharness/cli` 也必须精确，但独立版本化。
- Core 运行门禁只比较宿主与项目的 `major.minor`。`0.2.0`、`0.2.99`、`0.2.4-20260826001` 和 `0.2.4-beta.1` 都属于 `0.2.x`；宿主 patch 无论较新或较旧都可直接运行，不比较 patch、日期或预发布顺序。`0.1.x`、`0.2.x` 和 `1.2.x` 不兼容。
- patch 版本因此不得引入需要新兼容线的破坏性 Core API；此类 API 变化必须提升 minor。遇到 major/minor 不匹配时，保留项目精确声明并升级本地宿主或 CLI，不要把项目依赖改成 range 绕过门禁。
- Desktop 精确绑定 Core/CLI，并在本地运行、恢复、参数解析和结构检查前校验项目 Core。CLI 同时校验实际 Core、CLI 自身的精确 Core 绑定和项目 Core，peer 只覆盖绑定 Core 的同一 minor。Server 只校验静态元数据，不加载或执行项目。
- 内置项目发布索引还必须声明精确 `components.core` 与 `components.cli`。Desktop 只选择最低 Desktop 版本已满足且两个组件分别处于宿主同 `major.minor` 兼容线的发布；下载包的精确 Core/CLI 依赖必须与索引逐字一致。

## 项目名称与展示声明

项目展示信息在 `steamharness.json` 声明。根 `name` 是必填默认名称；中英文名称、手工声明和展示平台放在 `steamharness.json.projectInfo`：

`steamharness.json`

```json
{
  "name": "Default Name",
  "projectInfo": {
    "localizedNames": {
      "zh-CN": "中文名称",
      "en": "English Name"
    },
    "declarations": [
      "multilingual",
      "multiplatform"
    ],
    "platformSupport": {
      "mode": "specific",
      "platforms": [
        "macos",
        "windows",
        "web"
      ]
    }
  }
}
```

名称显示优先使用当前界面 locale 的名称，再回退根 `name`；搜索覆盖默认名称及所有本地化名称。`declarations` 是不验证真实功能的手工展示标签，当前注册 `multilingual` 与 `multiplatform`。`platformSupport` 只描述展示平台：平台无关使用 `{ "mode": "agnostic" }`；`specific` 至少包含一个平台，当前注册 `macos`、`windows` 与 `web`。符合小写 ID 格式的未来语言、声明和平台值必须原样保留。


## 聚合项目声明与交付

根 steamharness.json.id 是整个聚合项目唯一 UUID。类型属于入口，可注册多个同类型入口；entryId 唯一且与 Workflow 内部 entrypointId 分别传递。注册路径必须位于聚合目录内，禁止绝对路径、上级路径、符号链接越界、node_modules 和 .git。Workflow/Conversation 各模块导出自己的 executor，类型必须与注册匹配；静态分析仅遍历该模块的相对导入图。

`steamharness.json`

```json
{
  "id": "d9232d44-28ca-48e9-a89a-157ee143bcdc",
  "name": "Example",
  "defaultEntry": "chat",
  "entries": [
    {
      "entryId": "chat",
      "root": "agent"
    },
    {
      "entryId": "jobs",
      "root": "jobs"
    },
    {
      "entryId": "board",
      "root": "board"
    }
  ],
  "version": "1.0.0"
}
```

`agent/steamharness.json`

```json
{
  "type": "bot",
  "name": "Chat",
  "entry": "index.ts",
  "databases": []
}
```

`jobs/steamharness.json`

```json
{
  "type": "workflow",
  "name": "Jobs",
  "entry": "index.ts",
  "databases": []
}
```

`board/steamharness.json`

```json
{
  "type": "kanban",
  "name": "Board",
  "entry": "dist/steamharness/build/main/index.html",
  "databases": []
}
```

每个入口可指定相对其 root 的 configuration JSON 和 schedulePresets。会话、草稿、工具权限、运行记录、定时计划、配置方案及快照按 projectId + entryId 隔离。配置修改在下一次执行生效。

`context.entries.list()` 列出注册；`context.entries.get("jobs").listEntrypoints()` 列举 Workflow 操作；`runEntrypoint("refresh", ["--limit", "10"])` 调用操作。保留原用户、取消信号和工具权限，重新校验目标配置快照及授权。目标操作使用目标入口的数据库授权；调用方不会因此获得直接数据库句柄。嵌套调用上限 16。

一个聚合是一个上传、版本和 Store 安装单元。打包包含所有注册代码、配置、依赖清单和 Kanban 静态产物，保留根 config.json 中的数据库映射；引用本身不授予权限。普通 npm dependencies 保持包管理行为。Server 只处理静态元数据、文件和数据访问，不加载执行项目代码。

## 项目卡片（steamharness.json.projectCard）

可选的项目卡片展示元数据，Desktop 首页、发布对话框和分享卡片读取：

`steamharness.json`

```json
{
  "projectCard": {
    "icon": "bot",
    "iconColor": "#0f766e",
    "iconBackgroundColor": "#0f766e"
  }
}
```

- `icon` 必须是注册的图标名：`workflow`、`message-circle`、`bot`、`sparkles`、`code`、`git-branch`、`boxes`、`zap`、`database`、`file-text`、`cpu`、`brain`。
- `iconUrl` 作为自定义图标，只接受 `http://` 或 `https://`；`iconColor` 与 `iconBackgroundColor` 必须是 `#RRGGBB`。缺失时宿主按项目类型取默认值。
- 旧键 `appCard` 仍会被兼容读取，但 `appCard.kind` / `projectCard.kind` 已移除并会校验失败——项目类型由 executor 的 `projectType` 或 注册入口的 `type: "kanban"` 决定，不要写 `kind`。
- 只有用户明确要求品牌化展示信息时才写入；不写时宿主使用项目类型默认图标。

## Workflow 定时建议

Workflow 可以在 package 中声明建议计划；Conversation 和 Kanban 声明该字段会被 Structure 拒绝：

`steamharness.json`

```json
{
  "schedulePresets": [
    {
      "id": "business-hours",
      "title": "工作时段同步",
      "entrypointId": "sync",
      "timezone": "Asia/Shanghai",
      "trigger": {
        "kind": "window-interval",
        "weekdays": [
          1,
          2,
          3,
          4,
          5
        ],
        "windows": [
          {
            "start": "09:30",
            "end": "17:30"
          }
        ],
        "intervalMinutes": 5
      },
      "paramValues": {
        "scope": "active"
      }
    }
  ]
}
```

`id` 唯一且匹配 `[a-z][a-z0-9_-]{0,63}`，`entrypointId` 必须命中 executor 的静态入口。时区使用 IANA 名称；触发可使用不重叠且包含端点的 `window-interval`，或 `{ "kind": "cron", "expression": "五字段 Cron" }`。`paramValues` 必须是 JSON 对象并符合入口静态参数。

字段上限与格式：

- `schedulePresets` 最多 20 项；每项可带可选 `description`（≤500 字符）；`title` ≤100 字符。
- `window-interval` 每天最多 12 个窗口；`intervalMinutes` ≤1440；窗口必须互不重叠且包含端点。
- `weekdays` 取值 1–7，`1` 表示周一、`7` 表示周日，会自动去重排序。
- 每项只允许 `id`、`title`、`description`、`entrypointId`、`timezone`、`trigger`、`paramValues`；未知字段会直接报错，不要塞入自定义键。

Structure 将预设返回给宿主，但导入、打开或发布项目都不会自动创建计划；用户必须确认。计划不处理日期占位模板，动态日期由 Workflow 自行读取业务时区时间。

## Kanban 静态入口

在 entries 注册 type: "kanban"，root 指向代码目录，entry 指向已构建 HTML 产物（例如 dist/steamharness/build/main/index.html）。不生成 executor。宿主只消费产物，不安装依赖、执行构建脚本或连接 dev server。HTML/CSS/JS、图片和字体使用产物内相对路径。页面位于 allow-scripts sandbox 和离线 CSP，不能访问 Node、父页面 DOM、公网或顶层导航。

`window.steamHarnessKanban.getConfiguration()` 读取当前命名配置；监听 `steamharness:kanban-configuration-change`。`getPresentation()` 返回 full/card 展示，监听 `steamharness:kanban-presentation-change`。无参数时使用全幅布局，在手机、平板、低高度卡片中保留草稿与保存状态。

```ts
import { data } from "./dist/steamharness/generated/database/browser/index.js";
const database = await window.steamHarnessKanban.databases.connect(data);
const configurationId = window.steamHarnessKanban.getConfiguration().id || "default";
const page = await database.task.rows({ where: { configurationId } });
const row = await database.task.insert({ id: crypto.randomUUID(), configurationId, title: "Review", status: "todo" });
await database.task.update({ key: { id: row.values.id }, rowVersion: row.rowVersion, data: { status: "done" } });
const knowledge = window.steamHarnessKanban.knowledgeBases.get("docs");
const file = await knowledge.files.createFile({ name: "map.png", buffer: blob });
const { buffer } = await knowledge.files.readFile(file.id);
```

知识 alias 必须在当前入口的 knowledgeBases 声明并通过 Server 绑定。知识库通过 knowledgeBases.get(alias)，附件通过该上下文的 files；页面不能选择知识库 ID、项目、授权或数据路径。知识库和业务库的同名 alias 独立，不能互相绕过授权。订阅只返回 alias 和不透明 revision，卸载时调用取消函数。单文件上限 50 MiB，附件和聚合 Workflow 调用超时 120 秒，其他请求 15 秒，并发上限 16。所有请求处理 reject，未绑定或撤销显示恢复入口，不自动创建数据库。

模板与生成器先 generate 再 build，入口为 dist/steamharness/build/main/index.html。业务任务保存在 Task 行中，按 configurationId 筛选。未绑定或加载失败禁用编辑；写入失败保留草稿，不显示保存成功。生成器先检查全部目标文件冲突，再写入；数字开头的名称转换为合法 TypeScript 标识符，多行提示词转义为字符串字面量。

页面方法通过 `window.steamHarnessKanban.methods.register({name,description,inputSchema,readOnly?}, handler)` 注册（准确参数见公开类型）。资源卡片与方法调用必须带 projectId、entryId；先发现实例再使用 instanceId、configurationId、method、args 调用。不同入口和同一入口不同实例互不控制。相对缩放、平移和写入超时后先查询状态，不自动重试。

文件导入先识别消费端：CLI `workspace file-upload/file-download` 的普通项目托管文件、File 配置字段的配置附件、`knowledgeBases.get(alias).files` 的数据库附件不是同一种读取权限或通道。数据库附件引用包含 `storage: "database"` 与 `spaceId`；配置附件使用配置所属项目、入口与版本的窄权限读取。通用项目文件下载成功不能证明配置附件或数据库附件可用。迁移前保留原引用，按页面真实调用路径读回相同字节，再查询页面就绪状态（例如 `imageReady`）；无页面证据时如实报告。附件 404 后转向数据库仍失败时检查引用归属，不盲目换接口。大文件超时先诊断传输与存储，不把压缩、有损转码、分片或迁移当作默认修复。

上传由根 .steamharnessignore 选择文件，不使用 .gitignore；不能排除注册模块、配置或静态产物。发行包不携带数据库、凭据、历史或用户配置。

## 必需本地类型

在 `interface.ts` 或等价本地文件中保留这些最小类型：

```ts
export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json" | "audio" | "video";

export interface OutputDisplay {
  type: "ring";
  placement?: "inline" | "composer-right";
}

export interface RingContent {
  value: number;
  total?: number;
  unit?: string;
}

export interface OutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: OutputContentType;
  display?: OutputDisplay;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunOutputPayload extends RunPayload {
  items: OutputItem[];
}

export interface TimerPayload extends RunPayload {
  timerId: string;
  title: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TimerRecord extends TimerPayload {
  status: "running" | "success" | "failed" | "cleared";
  endedAt?: string;
  durationMs?: number;
  message?: string;
}

export interface ExecutorResult<Output extends RunPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}
```

所有节点 payload 类型都必须包含 `RunPayload`。成功输出统一使用：

```ts
errCode: 0,
errMessage: "",
items: [],
```

用户可见输出使用 `RunOutputPayload.items`，不要使用顶层 `content` 聚合。每个 item 可以渲染为 `markdown`、`text`、`json`、`audio` 或 `video`。对象和数组内容应保持原始 JSON 值。`audio` 的 `content` 设置为 `{ src, mimeType, name, size, durationMs?, format? }`；`src` 可以是安全的 `data:audio/...;base64,...` URL 或 `http(s)` URL。`video` 的 `content` 约定为 `{ src, mimeType: "video/mp4", name: "output.mp4", durationMs?, format?: "mp4" }`；`src` 同样只接受安全的 `data:video/...;base64,...` 或 `http(s)` URL，宿主使用原生 `<video controls preload="metadata" playsInline>` 渲染，不安全的协议会被丢弃而不是报错。只有确实产出视频文件时才使用 `video` item；不要把视频地址写成 Markdown 链接或 base64 塞进 `text`/`json`。

用户可见答案默认使用流式输出，尤其是 LLM、agent、API workflow，否则用户必须等待完整 run 结束。使用 `steamharness.createOutputNode({ async *stream, format })`，并用 `steamharness.runStreamNode(...)` 执行；非流式 `steamharness.runNode(...)` 只保留给小型内部转换或瞬时输出。可见文本流完后，finalizer 仍可写入业务表、conversation message 和 token usage。

数值辅助输出可声明 `display: { type: "ring", placement: "composer-right" }`，`content` 为 `{ value, total?, unit? }`：`value` 必须是非负有限数，`total` 若提供必须大于零。Conversation 按稳定 item id 保留最近值并固定在输入栏右侧，不在正文重复展示；缺省或 `placement: "inline"` 时在输出列表中展示。圆环只显示比例，hover/focus 的浅色提示框显示标题、百分比和精确数值。Core Agent 的上下文用量使用这一标准输出项；不要在项目或宿主里另写 context 字段读取和专用展示逻辑。默认 Markdown/text 主回答继续直接平铺。

输出 item 的展示边界必须明确：

- LLM/AI/agent 的正文、最终答案、解释文字、普通状态文案默认直接 `yield "文本"`。runtime 会自动创建 inline `Output` Markdown item。
- 如果正文必须手动创建 item 以稳定 live/final 合并 id，该 item 也必须保持 inline 条件：`title: "Output"`、`contentType: "markdown"` 或 `"text"`、`collapsed` 不是 `true`、没有 `metadata`、没有 `icon`、没有 `iconPreset`。
- 手动创建正文 item 时，正文段不能跨过工具调用继续 patch 同一个 item。遇到工具调用前先结束当前 inline `Output` 段，工具调用输出 detail item 后，后续 AI 正文重新创建新的 inline `Output` item。最终 `items` 必须按事件顺序交错呈现为 `正文段 -> 工具 detail -> 正文段`，不能把全部工具调用挤到最终答案下面。
- 不要给正文 item 添加 `metadata.kind = "answer"`、`iconPreset` 或自定义 icon。shared UI 会把带 `metadata` 或 icon 的 item 当成 detail/block，而不是普通正文。
- `steamharness.createOutputItemChunk(...)` 主要用于工具调用、trace、调试 JSON、日志、音频/文件描述等结构化辅助项。工具项应带 `metadata.status: "running" | "success" | "failed"`，并 patch 同一个 item id，展示进行中到完成的状态变化。
- `steamharness.createDetailsOutputNode(...)` 或 `collapsed: true` 只用于确实需要折叠的辅助详情；不要用于 AI 正文、最终答案或用户要求直接展示的内容。

## Workflow 与 Executor

```ts
import type { Input, OutputPayload } from "./interface";

export const exampleProject = steamharness.defineProject<Input, OutputPayload>({
  name: "example",
  async run(input, context) {
    const result = await steamharness.runStreamNode(outputNode, input, context);
    return requireOutput(result.output);
  },
});

export const executor = steamharness.defineExecutor<Input, OutputPayload>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<Input, OutputPayload>({
      id: "main",
      title: "完整流程",
      workflow: exampleProject,
      tools: [
        {
          name: "search",
          label: "Search",
          description: "调用搜索服务。",
          enabled: true,
          autoApprove: false,
        },
      ],
      params: [
        {
          name: "input",
          flag: "--input",
          type: "positional",
          required: false,
          description: "Input text.",
        },
      ],
      createInput({ args }) {
        return args.join(" ");
      },
    }),
  ],
});

export { exampleProject as workflow };
export default exampleProject;
```

- `steamharness.defineProject<Input, Output>()` 定义业务 workflow：**只接收一个对象字面量** `{ name, async run(input, context) {...} }`，没有 `(name, runFn)` 形式的重载。返回值原样就是 workflow 对象，宿主按 `typeof value.name === "string" && typeof value.run === "function"` 识别它——少写 `name`、或按别的签名调用，都会在运行时报「must declare workflow and createInput on its executor」。`interface.ts` 里的本地类型只是声明，不会改变运行时的实际形状。
- `steamharness.defineExecutor<Input, Output>()` 定义项目运行模式；Workflow 使用 `steamharness.defineEntrypoint<Input, Output>()` 定义一个或多个独立运行入口。
- `projectType` 是 executor 运行模式的唯一真相源，必填且只接受 `"workflow"` 或 `"conversation"`。Workflow executor 不得声明 `conversation`；Conversation executor 自动启用 conversation context，禁止使用已移除的 `conversation.enabled`。
- `steamharness.defineExecutor(...)` 必须接收内联对象字面量，并把返回值作为模块 executor 导出。Workflow 的 `defaultEntrypoint` 必须是命中入口 ID 的静态字符串，`entrypoints` 必须是非空静态数组且每项直接调用 `steamharness.defineEntrypoint({...})`。入口 ID 匹配 `/^[a-z][a-z0-9_-]{0,63}$/`，项目内唯一；标题必填，描述可选。每个入口的 `workflow` 必须引用项目源码中由 `steamharness.defineProject(...)` 定义的标识符；跨文件可通过项目内相对路径使用命名、别名或 default import，不能传入外部包值或动态构造值。旧的 Workflow 顶层 `workflow/params/createInput/...` 已移除。Conversation 保持单入口顶层配置且不接受 entrypoint。
- `steamharness.getConfig(name)` 为 CLI 和本地宿主 读取运行时配置。
- `steamharness.getRuntimePlatform()` 返回 `"cli"` 或 `"desktop"`；`steamharness.isCli()` 与 `steamharness.isDesktop()` 是便捷判断函数。
- `steamharness.getRuntimeLocale()` 返回 `"zh-CN"` 或 `"en"`，用于已明确要求国际化的 Workflow 或 Bot 项目按宿主语言生成用户可见输出；未注入时回退 `"zh-CN"`。
- `steamharness.createUserInputNode(...)` 创建可持久化的人工输入暂停。它的表单 `params` 应遵循所选 entrypoint（Conversation 则为 executor）的 params，且每个返回 payload 必须包含 `errCode` 和 `errMessage`。
- `steamharness.createToolApprovalGate()` 创建工具审批包装器。它依赖所选 entrypoint（Conversation 则为 executor）的 `tools` 注册工具元数据，并复用 user-input 机制暂停和恢复；未自动批准的工具只在 plan 模式的 agent 回合停下来问，build 回合直接执行。
- 静态结构 report 会在 `definitions.apiCalls` 中列出识别到的 `steamharness.*` 调用。执行序列只记录 `run()` 内由 `steamharness.runNode`、`steamharness.runStreamNode`、`steamharness.runIf`、`steamharness.runFor` 或 `steamharness.runWhile` node hooks 支撑的调用。
- `context.files.createFile({ name, mimeType, buffer, kind })` 把 workflow 生成的文件写入 server-backed runtime file storage。
- Workflow entrypoint 上的 `tokenUsage: { enabled: true, display?: boolean }` 会为该入口启用 token usage 收集；Conversation 仍在 executor 上配置。
- Workflow entrypoint 上的 `tools: ToolPermissionDefinition[]` 会启用该入口的工具策略元数据；Conversation 仍在 executor 上配置。每项包含 `name`、可选 `label/description`、`enabled` 默认值和 `autoApprove` 默认值。
- `params` 描述结构化 Desktop、server、external input。
- `createInput({ args, paramValues, config, projectName, projectDir, entrypointId, entrypointTitle, abortSignal, hostInput, conversationId, toolPermissionPolicies })` 把 argv 或宿主结构化输入转成 workflow input。`paramValues` 是宿主按入口静态参数解析出的结构化值；`hostInput` 是宿主注入的请求级输入（普通运行缺省 `undefined`），不进入通用 run metadata；`conversationId`、`toolPermissionPolicies` 只在宿主提供时出现。
- 把 `workflow` 作为别名导出，既保持现有平台发现稳定，又避免定义遮蔽全局命名空间的本地常量。
- 入口的可选 `requiredProviders: ExecutorProviderName[]` 声明该入口运行需要的 provider，当前内置名称只有 `"llm"`；Conversation executor 同样支持。它是 Workflow 顶层被移除的 legacy key，只能写在入口上。
- 入口的可选 `createContext({ ...ExecutorContext })` 返回 `Partial<RunContext>`，用于为该入口增补 `providers`、`metadata` 和 hooks。`storage`、`conversation`、`files` 的注入与作用域由 runtime 负责，返回对象里不要试图替换它们。

### 入口分区（group）

多入口项目可以在入口对象上声明可选分区，把同一业务域的入口折叠成 Desktop Run 区和 CLI Web 里的一个分区：

```ts
interface EntrypointGroupDefinition {
  id: string;
  title: string;
  order?: number;
}

steamharness.defineEntrypoint<Input, Output>({
  id: "media-export",
  title: "媒体导出",
  group: { id: "media", title: "媒体处理", order: 10 },
  workflow: mediaExportProject,
  params: [],
  createInput() {
    return { errCode: 0, errMessage: "" };
  },
});
```

- `group` 是可选的展示元数据，不表达父子执行关系，也不改变入口的扁平运行目录。用户直接运行任一入口时只创建该入口的 run，不会先运行默认入口或同分区其它入口。需要在一个 run 内组合多个业务流程时继续用 `steamharness.runProject(...)`，不要把业务层级编码进 `group.id` 或入口 ID。
- `group` 必须是**静态内联对象字面量**，并且只包含 `id`、`title` 和可选 `order` 三个属性；`group` 为 `null`、数组、非对象、或来自变量/函数调用时，`steamharness structure` 直接报 violation。
- `id` 和 `title` 必须是非空静态字符串字面量；`order` 一旦被声明就必须是非负整数——包括显式写 `order: undefined` 也会失败。省略 `order` 与写上 `order` 是两种不同声明。
- **同一个 `group.id` 在所有入口上的 `title` 和 `order` 必须逐字一致**（含“有 order”与“无 order”的差异）：`steamharness.defineExecutor(...)` 在加载时校验，`steamharness structure` 在静态分析时校验，不一致会分别抛出 `input_validation` 和 violation。
- Desktop 与 CLI Web 只在至少一个入口声明了 `group` 时才启用分区层；显式 `order` 按升序排列，同值按源码首次出现顺序，未声明 `order` 的分区排在其后，未分组的入口归入本地化“未分组”分区并按第一个未分组入口的位置参与排序。分区展开状态按 `projectId + resolved target` 使用版本化键持久化，不在项目源码里配置。
- 本地 CLI、MCP 和 OpenAI 接口 只按 `entrypoint.id` 执行，忽略分区；`group` 不影响 `defaultEntrypoint`、调度预设或参数解析。
- 只有确实需要按业务域折叠多个入口时才声明 `group`；单入口项目或不需要分组的多入口项目保持不声明，界面会自动保持扁平列表。

## 错误与暂停语义（HarnessError）

运行时把失败归类为类型化错误。项目源码抛出的普通 `Error` 会被包成 `project_execution`，宿主只能看到泛化原因；需要宿主、Desktop 或 Server 识别具体失败种类（尤其是暂停与取消）时，必须显式抛出 `steamharness.HarnessError`：

```ts
throw new steamharness.HarnessError({
  type: "input_validation",
  message: "行情代码必须是大写字母加数字。",
  nodeName: "load-quotes",
  metadata: { symbol },
});
```

`ErrorOptions` 为 `{ type, message, nodeName?, cause?, metadata? }`；`cause` 会被脱敏成 `{ name, message, statusCode?, url?, isRetryable?, responseBody?, cause?, validation? }` 并进入 report，`metadata` 只放可公开的结构化信息。

| `type` | 触发与宿主语义 |
| --- | --- |
| `input_validation` | 输入、参数或项目配置不合法。宿主直接展示原因，不会重试。 |
| `user_input_required` | 节点正在等待人工输入。宿主进入等待状态，提交答案后用同一个 `runId` 恢复；由 `steamharness.createUserInputNode(...)` 与工具审批产生。 |
| `execution_aborted` | 用户取消或 `abortSignal` 生效。宿主停止 run，不当作故障重试。 |
| `tool_permission_denied` | 工具被策略拒绝或未启用。 |
| `node_execution` | 单个节点执行失败，例如 `runIf` 没有任何分支命中且未声明 `else`、循环超过 `maxIterations`。 |
| `provider_call` | 模型或 provider 调用失败，例如 provider 无法解析（`getLLMProvider` 找不到任何来源）、绑定的 provider/model 不存在。 |
| `project_execution` | workflow 级失败，例如 `runProject` 嵌套过深、计时器未启动或重复结束、知识库缺少原子 mutation 能力。 |
| `stream_interrupted` | 流式输出在完成前中断。 |

- `steamharness.runNode(...)` 会把 `user_input_required` 和 `execution_aborted` 原样向上抛出并保持等待/取消状态；不要把这两个错误吞掉、包装、转成成功返回值，否则宿主无法恢复同一个 run。
- 不要用字符串或自定义 `errCode` 表达暂停与取消语义；只有 `HarnessError.type` 会被宿主识别。
- `steamharness.HarnessError` 可以从项目源码构造，但在节点内部捕获后重新抛出时，保留原始 `type`，必要时用 `metadata` 补充上下文。

## 业务计时器

当业务阶段需要在 本地桌面与 本地运行回放 中显示为计时卡片时，使用 `steamharness.createTimerNode(...)`。该节点启动可序列化的 `TimerPayload`；`steamharness.endTimer(...)` 会把它标记为 `success` 或 `failed`，并把 `endedAt` / `durationMs` 写入 runtime events 和最终 report。

```ts
const timerNode = steamharness.createTimerNode({
  title: "外部接口调用",
});

const timer = await steamharness.runNode(timerNode, {
  timerId: "api-call",
  metadata: { provider: "example" },
}, context);

try {
  const result = await callApi(input);
  await steamharness.endTimer(timer, context, { message: "接口完成" });
  return result;
} catch (error) {
  await steamharness.endTimer(timer, context, {
    status: "failed",
    message: error instanceof Error ? error.message : "接口失败",
  });
  throw error;
}
```

必须 `await` `steamharness.endTimer(timer, context, { status?, message?, metadata? })`：`timer` 可以是 `steamharness.createTimerNode` 返回的 payload，也可以是 `timerId` 字符串；结束一个未启动的计时器、或重复结束同一个计时器，都会抛 `project_execution`。如果 workflow 业务代码在计时器仍为 `running` 时返回或中止，runtime cleanup 会在终端 report 前把它标记为 `cleared`，避免 UI 保留过期 running 卡片。

## 业务数据库与独立知识库

业务模型在 `steamharness.database.ts` 和 `steamharness.schema` 定义，通过 CLI database generate/migrate 生成并应用。Node 导入 `dist/steamharness/generated/database/node/index.js` 的描述符后使用 `context.databases.connect(descriptor)`。关系库资源和账号、项目、入口、alias 绑定保存在 Server；不写旧 config.databases。连接不自动建库或迁移，模型不符、撤权和断连明确失败。Browser 导入 browser/index.js 描述符，经宿主提供模型 rows/insert/update/delete；不是 Node ORM，Decimal、BigInt 用字符串、Bytes 用 Base64；DateTime 必须输入带时区的 ISO 字符串并按 UTC 读写，Date 原生类型返回 UTC 零点，Time/Timetz 返回 1970-01-01 日期。映射枚举读写模型声明值，列表未提供且无默认值时写空数组。

知识库无需项目定义 schema。入口声明 `"knowledgeBases": ["docs"]`，根 `config.json` 使用 `"knowledgeBases": { "docs": "<Server 创建的 UUID>" }`。`STEAMHARNESS_PROJECT_CONFIG` 可按别名覆盖；不自动读取 .env，打包保留文件值。使用 `steamharness knowledge create/bind/grant/revoke` 管理，账号必须先登录 Server。绑定不授予权限。多入口可复用 alias；业务库与知识库的同名 alias 独立。

## 项目知识文档

使用独立上下文，不生成旧 PersistentValue helper：

```ts
const knowledge = context.knowledgeBases.get("docs");
const created = await knowledge.createDocument({ title: "Runbook", markdown: "# Runbook" });
const current = await knowledge.getDocument(created.id);
if (current) await knowledge.editDocument({ id: current.id, markdown: "# Updated", expectedRevision: current.revision });
const page = await knowledge.listDocuments({ pageSize: 20 });
const matches = await knowledge.searchDocuments({ query: "on-call", pageSize: 20 });
const lines = await knowledge.readDocumentLines({ documentId: created.id, startLine: 1, endLine: 10 });
const file = await knowledge.files.createFile({ name: "notes.txt", buffer });
const resolved = await knowledge.files.readFile(file.id);
const latest = await knowledge.getDocument(created.id);
if (latest) await knowledge.deleteDocument(latest.id, latest.revision);
```

文档、分块和索引同一 SQL 事务提交；附件正文在私有文件存储，SQL 不保存 Base64。文档包含 revision，编辑和删除推荐传 expectedRevision，冲突保留草稿并重新读取。listDocuments 返回 items、total、hasMore 和可选 nextCursor；搜索支持中文和字面子串，cursor 绑定查询及资源 revision，变化后重新搜索。列表页上限100，搜索pageSize/maxMatches上限1000，前后文各最多100行，行读取最多1000行。

附件引用保留 storage: "database" 与 spaceId（知识库 UUID），单文件最多50 MiB，文件桥超时120秒。Node readFile 下载一次，保留句柄每次读取重新鉴权。账号授权、绑定或访问版本变化使旧客户端失效，必须重新打开入口。Server 或 PostgreSQL 不可达时明确失败，不使用本地 KV 回退。显式测试 fixture 可离线运行，不能充当生产存储。

Conversation 历史、队列、Agent checkpoint 和 Token usage 使用平台关系表。不要为它们生成 KV、JSON 或 SQLite 回退；无需为每个会话创建业务数据库。需要把会话整理成知识文档时，由工作流显式调用上述知识 API，并按会话生成稳定文档 ID。

`tokenUsage.enabled` 为 false 或省略时，`context.tokenUsage.report(...)` 是安全 no-op，生成的 workflow 不应添加自己的 fallback storage。启用后，runtime report 包含 `tokenUsage.run`；只有 `display` 为 true 时，本地宿主或 CLI Web 才显示 compact badge。手动上报字段包括 `inputTokens`、`outputTokens`、`totalTokens`、`reasoningTokens`、`cachedInputTokens` 和 `cacheCreationTokens`；本地宿主 badge 可见文本只显示总量，hover/focus 明细分别展示 Input、Output、Reasoning、Cache read、Cache write 和 Calls。

需要在自己的逻辑里读取本次 run 的用量时用 `context.tokenUsage.getRunUsage()`，它返回本 run 的聚合值（含调用次数），未启用或没有调用时返回空聚合；不要在 workflow 内自行累计 KV。

Conversation workflow 在 executor 上启用 conversation state：

```ts
export const executor = steamharness.defineExecutor<Input, OutputPayload>({
  projectType: "bot",
  workflow: conversationProject,
  conversation: {
    attachments: {
      images: true,
      videos: true,
      files: true,
    },
    inputQueue: { enabled: true },
  },
  createInput({ args }) {
    const defaults = steamharness.parseConversationDefaultInputArgs(args);
    return {
      message: defaults.message,
      images: defaults.images,
      videos: defaults.videos,
      files: defaults.files,
    };
  },
});
```

Conversation 始终使用标准主输入框，不提供关闭或自定义主输入配置；附件能力写在 `conversation.attachments`。输入协议不会自动修改 workflow context。生成 conversation workflow 时：

- 主文本固定读取 `--message`
- 图片附件固定读取 `--images`
- 视频附件固定读取 `--videos`
- 普通文件附件固定读取 `--files`
- 不要在 `params` 里声明主文本/主附件字段；只允许 Auxiliary、Quick、Mode、Slash 入口，主输入的四个固定 flags 不得重复声明

`steamharness.parseConversationDefaultInputArgs(args)` 返回 `{ message, images, videos, files }`。`--images` / `--videos` / `--files` 复用同一套 file reference 协议，既支持 managed file JSON refs，也支持本地 path。只有显式声明 `attachments.videos: true` 的项目才使用 `--videos`；未开启视频附件的项目里，用户拖入的视频继续走 `--files`。阶段一里，普通文件附件只需要做到接收、展示、持久化和回放；只有图片默认进入多模态 LLM 输入，视频和普通文件由项目显式适配到模型支持的输入协议，不要自动当作模型内容处理，除非业务逻辑明确需要。

Bot 项目可选接入本地宿主提供的 OpenAI Responses 网关（本地宿主和 CLI Web 在用户选择 OpenAI 兼容模型时注入）：

```ts
conversation: {
  openai: {
    enabled: true,
    outputItemId: "assistant-response",
  },
},
createInput(context) {
  const openai = steamharness.readOpenAIConversationHostInput(context);
  if (openai !== undefined) {
    return {
      messages: openai.messages,
      model: openai.model,
      instructions: openai.instructions,
      settings: openai.settings,
    };
  }
  // 宿主不是 OpenAI Responses 时继续走普通 Desktop/CLI 输入路径。
  const defaults = steamharness.parseConversationDefaultInputArgs(context.args);
  return { message: defaults.message, images: defaults.images, files: defaults.files };
}
```

- `conversation.openai` 必须同时声明 `enabled: true` 和指向最终纯文本答案的稳定 `outputItemId`；框架负责 OpenAI 协议、Key、状态、持久化和传输，项目只负责把宿主输入映射到自己的业务输入。
- `steamharness.readOpenAIConversationHostInput(context)` 只在 `context.hostInput.kind === "openai.responses"` 时返回宿主输入，其它情况返回 `undefined`；形状不合法时抛 `input_validation`。项目必须保留非 OpenAI 的普通输入分支，不要假设宿主一定注入。
- 走 OpenAI Responses 模式时不要再把请求或答案正文追加到普通 workflow conversation、KV、run 审计或自定义日志，否则同一轮对话会出现两份记录。
- `context.hostInput` 是宿主注入的请求级输入，普通 CLI/Desktop 运行缺省 `undefined`，不要把它写进 run metadata 或持久化。

当稳定 conversation id 只能在解析 provider payload 后得到时，`createInput` 可以返回非空 `conversationId` 或 `conversation_id`。显式 CLI 或 API conversation id 仍优先。

```ts
createInput({ args }) {
  const payload = JSON.parse(args[0] ?? "{}") as { issue?: { iid?: number } };
  return {
    payload,
    conversationId: payload.issue?.iid ? `issue:${payload.issue.iid}` : undefined,
  };
}
```

CLI Web 使用本地会话记录回放用户输入和附件，项目的参数与节点输入也只在本地运行详情中排查。Server 不保存或回放项目运行记录。

Chat 状态使用 conversation context：

```ts
const state = await context.conversation.getValue();
await context.conversation.appendMessage({ role: "user", content: input.message });
await context.conversation.setValue("topic", "weather");
await context.conversation.setTitle("Support triage");
```

`context.conversation.getValue()` 替代旧的 `getState()` API。Conversation state 使用当前账号和入口的 Server 平台关系表，不要求额外业务库；持久化运行需要账号登录与服务连接。

`context.conversation.setTitle(title)` 是可选 UI hint。它会规范化空白、存储 `state.title`，并为 本地宿主或 CLI Web 发出 `conversation_title_updated` runtime event。传入空白标题会清空存储标题。conversation mode 禁用时，`setTitle` 是安全 no-op，不应中断 workflow。

本地 CLI 检查可传入稳定 conversation id：

```bash
steamharness json . --conversation-id demo -- --message hello
```

## 参数

Workflow 的 `params` 必须是 `steamharness.defineEntrypoint({ ... })` 内的静态数组字面量；Conversation 的 `params` 继续位于 `steamharness.defineExecutor({ ... })`。静态结构分析不执行代码。

Workflow 的数组条目是 `ParamDeclaration`，普通主字段可直接声明。Conversation 的数组条目是 `BotParamDeclaration`，只允许 Auxiliary、Quick、Mode 和 Slash；标准主输入框始终展示，不声明普通主字段或保留的 `--message`、`--images`、`--videos`、`--files`。Auxiliary 和 Quick 声明 `{ kind, id, label, fields }`，Quick 还要有 `summary`；Conversation 的单击轮换模式直接声明 `{ kind: "mode", name, flag, options }`，Slash 声明 `{ kind: "slash", name, flag, type, options? }` 并出现在 `/` 菜单中。可重复声明多个入口，工具栏按数组顺序从左到右展示。组内字段是普通参数，不能再设置 `panel` 或嵌套分组。所有字段的 `name`、flag 和 Auxiliary/Quick 的 `id` 必须各自唯一。结构报告把字段展平到 `params`，用 `paramLayout.actions` 记录入口归属和顺序；`createInput({ paramValues })` 仍按字段名读取值。

Conversation 参数示例：

Quick 可声明静态 `icon` Codicon 名称（匹配 `/^[a-z][a-z0-9-]*$/`，省略为 `settings`），例如 AI 用 `sparkle`、权限用 `shield`。CLI Web 入口仅显示图标与 `summary` 当前选择，组名保留在菜单标题、悬停提示和无障碍名称中；空间不足时从右到左收起 Quick 文字，恢复宽度后自动展开。结构报告的 `paramLayout.actions` 保留图标。

```ts
params: [
  {
    kind: "auxiliary", id: "options", label: "选项", fields: [
      { name: "dryRun", flag: "--dry-run", type: "boolean", description: "Preview only." },
      { name: "trace", flag: "--trace", type: "boolean" },
    ],
  },
  { kind: "quick", id: "ai", label: "AI", icon: "sparkle", summary: ["model"], fields: [
    { name: "model", flag: "--model", type: "string", control: "select", options: [{ value: "sol" }] },
  ] },
  { kind: "mode", name: "agentMode", flag: "--agent-mode", options: [{ value: "ask" }, { value: "build" }] },
]
```

规则：

- `ConversationDefinition` 的 `recovery` 使用内联 `{ enabled: true }` 声明可跨进程恢复。只为持久 Agent 等可恢复项目启用；CLI Web / Studio 保存原 runId、args 和已解析答案，worker 意外退出最多自动恢复 3 次，再用现有 Retry 继续原运行。关闭宿主保留检查点，显式停止先保存取消意图、停 worker，再调用 `steamharness/agent` 的 `cancelStoredAgentConversation({ persistence, conversationId })`，重开不能复活。
- `ConversationDefinition` 的 `durable` 字段使用内联 `{ enabled: true }`，并在 Agent 选项设置 `session: { ... }`，启用持久输入队列、steer、后台任务及 Studio Trace 任务视图。Harness 是已提交输入、业务任务与执行历史的唯一权威。宿主可持久保留尚未提交的用户待发消息；忙碌时不提前放进 Pi inbox，失败或强退后暂停，只有成功用户轮次才顺序提交，后台 report 不能触发发送。CLI Web / Studio 通过稳定 requestId 的双向命令和快照确认提交；多客户端各自选择会话，共享同一个执行 owner。常驻 owner 调度由本地 CLI / Studio 宿主负责。
- Slash 只用于 Conversation，支持单选 `type: "string"` 和开关 `type: "boolean"`，不能声明 `control`、`panel` 或 `multiple`。单选须有非空 `options`，默认使用首项，显式默认值必须属于选项；boolean 不提供 `options`，默认 `"false"`。选项级 `command` 默认取 `value`，boolean 参数级 `command` 默认取 `name`，命令不带 `/`、在项目内唯一且匹配 `/^[a-z][a-z0-9_-]*$/`。`resolvedOptions` 也可提供命令，省略时沿用同值静态选项的别名再回退到 `value`，格式和唯一性仍须合法。菜单遵守 visibility/disabled，选择后更新普通参数值、移除光标处命令并触发 resolver，不直接发送消息。
- `ConversationDefinition.commands` 使用静态 `ConversationCommandDefinition[]` 定义通用执行命令，与 Slash 参数共享菜单；单独输入 `/` 展示全部命令。每项声明 `command`、非空 `label`、可选 `description` / `localizedLabel` / `localizedDescription` 和 `action`。`{ kind: "prompt", text: "..." }` 将声明的文字作为独立回合运行该项目，`{ kind: "export" }` 下载当前会话的完整 JSON 并在正文保存命令与结果。命令必须满足 `/^[a-z][a-z0-9_-]*$/`，不得与静态或动态参数命令重复。命令保留其他草稿正文和附件，在运行、等待审批、队列未清空或编辑队列时禁用。
- `ConversationDefinition.footer` 使用静态 `ConversationFooterItem[]` 在标准输入框外下方展示纯文字。每项只声明 `{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" } }` 或 `{ param: "plan" }`，可加 `when: { param: "plan", value: "true" }`。参数引用必须存在，显示当前选项标签或原值；隐藏的引用参数不展示，条件不匹配不展示。翻译缺失回退到 `text`，不解析 HTML/Markdown。小助手采用 `kind: "slash", name: "plan", type: "boolean", defaultValue: "false"`，单个 `/plan` 开关控制 Plan，默认 Build，`createInput` 映射 `paramValues.plan === "true" ? "plan" : "build"` 到 Agent 的 `agent`。
- `ConversationDefinition` 的 `userInput` 使用静态 `ConversationUserInputDefinition`。`hideComposer` 默认 true：等待任意用户输入请求期间隐藏底部主输入区，确认答案或停止后恢复，保留草稿、附件和参数；false 显式保留输入区。`effects: [{ when: { type?, nodeName?, values? }, params }]` 按声明顺序在运行时确认答案后执行一次，失败提交不执行。`type` 匹配请求 `metadata.type`，`nodeName` 匹配节点名，`values` 中所有字段精确匹配已解析答案（string / 有限 number / boolean / 有序 string 数组）；至少一个条件，多个条件须全部匹配。`params` 非空且只引用已有参数，值为字符串或字符串数组，boolean 使用 `"true"` / `"false"`。更新当前会话后续输入的参数、Slash/Quick/底部文字并持久化，当前运行仍用原始 args 恢复；旧参数刷新不能覆盖更新。小助手配置 `{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }`，普通节点可用任意类型、节点和答案配置，不允许宿主硬编码 Plan 判断。
- 小助手声明 `/export` 的 export action，以及 `/compact` 的 `{ kind: "prompt", text: "/compact" }` action。Core Agent 对精确 `/compact` 或 `compact: true` 立即调用真实模型总结全部已有上下文，不受自动压缩阈值限制；展示执行中、完成或失败，成功后替换并持久化 Agent transcript，后续回合使用摘要，失败保留原上下文。空上下文直接完成；原 Conversation 正文不删除。公开 `compactAgentMessages` 的 `force: true` 同样强制总结已有消息。
- `string` 和 `number`：追加 `flag value`。
- `boolean`：只有 true 时追加 `flag`。当 boolean param 默认值为 `"true"` 时，结构化表单可追加 `flag false`，让 `createInput` 可以向下游 API 传递显式 false。
- `positional`：把值追加到 argv 尾部；仍要提供稳定 `flag`。
- `file`：追加 `flag value`，其中 value 是一个 file reference 或 file reference 数组的 JSON 字符串。
- Params 可以声明 `control: "textarea"`（或显式的 `control: "text"`）用于长文本或单行文本输入，也可以声明 `options: [{ value, label, description }]` 和 `control: "radio" | "select" | "checkboxes"` 用于 本地宿主参数表单。
- 每个 param 可以声明 `label` 作为宿主表单的展示名；缺省时宿主回退到 `name`。`shortFlag` 与 `flag` 一起构成 CLI 的短/长参数；两者都要稳定，不要只改一个。
- **一次问多个独立问题时用 `step`（从 1 开始）分步**：同一步的字段一起问，声明了 `step` 的请求在用户输入节点里一次只展示一步，问题上方的「‹ 第 N / M 问 ›」前后翻页并标出还没答的必答题。同一个问题的多个字段（选项 + 它的补充输入）要留在同一步，不要把一张表单拆成向导。
- 音频输入使用 `type: "file"` 加 `control: "audio"`，并用 `audio: { maxDurationSeconds?, maxBytes? }` 限制单个录音文件：

```ts
{
  name: "voice",
  flag: "--voice",
  type: "file",
  control: "audio",
  label: "语音输入",
  audio: { maxDurationSeconds: 60, maxBytes: 5_000_000 },
}
```

  宿主负责录制、WAV 编码和上传，workflow 侧仍按普通 file param 用 `steamharness.createFileInputNode(...)` 或 file reference JSON 读取引用。音频参数必须是单文件（不能 `multiple: true`）、不能声明 `options`、不能放进 Quick；`maxDurationSeconds` 必须是正的有限数，`maxBytes` 必须是正整数，否则 `defineExecutor` / `defineEntrypoint` 直接抛 `input_validation`。Kanban 的 `configuration.json` 参数不支持音频控件。
- 日期字段继续使用 `type: "string"`，并声明 `control: "date" | "time" | "datetime" | "date-range"`。字符串格式固定为 `YYYY-MM-DD`、`HH:mm:ss`、本地 `YYYY-MM-DDTHH:mm:ss` 和闭区间 `YYYY-MM-DD/YYYY-MM-DD`；仅支持普通主字段或 Auxiliary，不用于 Quick，不声明 `options`、`multiple: true` 或 resolver option 补丁。无效非空默认值、Raw 参数或 resolver 值会原样保留并显示错误，修正前宿主不会提交。
- 用 `kind: "auxiliary"` 创建可收缩面板并把相关字段写进 `fields`。可声明多个 Auxiliary，每个里面也可放多个字段。
- 用 `kind: "quick"` 创建快捷摘要入口；`fields` 只包含带 `select` / `radio` / `checkboxes` 控件的字符串枚举，`summary` 明确列出显示在摘要中的本组字段名。多个 Quick 各有自己的菜单和重置操作。
- 用 `kind: "mode"` 创建 Conversation 独立模式开关，至少两个互不重复的非空选项，单击轮换；省略 `defaultValue` 时使用第一个选项，显式默认值必须属于选项。不依赖字段名 `agent` 特例。三种入口的完整呈现和限制见 `references/param-panels.md`。
- 需要互斥或联动时，在对应 entrypoint（Conversation 则为 executor）中定义无写入副作用、幂等的 `resolveParams({ draftText, paramValues, trigger, abortSignal })`，返回参数的 `value`、`visible`、`disabled`、`resolvedOptions` 和 option 状态补丁。初始化以及 main、Advanced、Quick 的 Form 参数变化都会触发。互斥字段隐藏时同时返回 `{ visible: false, value: null }`；单独返回 `visible: false` 会保留旧值并继续生成 args。Raw 模式初始化补丁只更新对应已声明参数，其它 Raw 参数保持不变。`resolvedOptions` 数组替换静态选项，`null` 恢复静态选项；替换时旧 option 状态会清除。只有联动依赖主输入文本时，才为相关参数设置 `resolveOnInput: true`。可以调用支持 `AbortSignal` 的只读目录 API，不得写数据库、文件或其它外部状态。
- File params 可以声明 `multiple`、`accept` 和 `format: "json"`，让 本地宿主和 CLI Web 在 run 前保存附件，并把 opaque references 传给 workflow。
- `defaultValue` 是字符串，必要时在 `createInput` 中转换。
- `ParamDefinition.userSetting` / `UserSettingParamBinding` 将单个 string 参数绑定用户设置，当前支持 `{ key: "agent.permissionPolicy" | "agent.model", mode?: "default" | "fixed" }`。`default`（省略时采用）保留三个实际权限选项，以用户设置为默认，允许项目覆盖；`fixed` 只显示当前系统值，点击打开 Studio 用户权限设置，忽略项目覆盖。不要同时声明 `defaultValue`，不支持 multiple、checkboxes、Mode 或 Slash。静态分析保留绑定，Core 在执行上下文内解析；宿主保存空覆盖标记而非显示值，显式选项才写入具体覆盖，重置恢复跟随。`createAgentProjectParams()` 与 `{ permissionPolicy: "inherit" }` 默认返回 fixed 绑定；需要允许会话覆盖时，通过 `paramOptions.fields.permissionPolicy.userSetting: { key: "agent.permissionPolicy", mode: "default" }` 显式指定。
- 参数变化时，同步更新 params、`createInput`、input type 和 README。

日期与日期范围互斥示例：

```ts
resolveParams({ paramValues, trigger }) {
  const date = typeof paramValues.date === "string" ? paramValues.date : "";
  const dateRange = typeof paramValues.dateRange === "string" ? paramValues.dateRange : "";
  const preferRange = trigger.kind === "param" && trigger.paramName === "dateRange";
  const useRange = dateRange !== "" && (preferRange || date === "");
  const useDate = date !== "" && !useRange;

  return {
    params: {
      date: useRange ? { visible: false, value: null } : { visible: true },
      dateRange: useDate ? { visible: false, value: null } : { visible: true },
    },
  };
}
```

File param 示例：

```ts
params: [
  {
    name: "images",
    flag: "--images",
    type: "file",
    multiple: true,
    accept: ["image/png", "image/jpeg", "image/webp"],
    format: "json",
    required: false,
    description: "Image attachments.",
  },
]
```

## 节点

```ts
const inputNode = steamharness.createInputNode<Input, Parsed>({
  name: "input",
  parse(input) {
    return { message: input.message.trim() };
  },
});

const parsed = await steamharness.runNode(inputNode, input, context);
```

File input node 示例：

```ts
const imageInputNode = steamharness.createFileInputNode({
  name: "images",
  accept: ["image/png", "image/jpeg", "image/webp"],
  multiple: true,
});

const images = await steamharness.runNode(imageInputNode, input.images, context);
const imageParts = await Promise.all(images.map((file) => file.toLLMImagePart()));
```

节点接收来自 file param 的 file references，并通过 `context.files.resolveFile(ref)` 解析单个引用。已解析文件暴露 `readBuffer()`、`readBase64()`、`readDataUrl()`、`toLLMImagePart()` 和 `toJSON()`；对非图片调用 `toLLMImagePart()` 会抛 `input_validation`。业务表或 conversation history 中只存 `toJSON()` 元数据，不要持久化 base64 文件内容。引用本身既可以是托管 file reference JSON、引用数组，也可以是本地绝对路径字符串（本地运行时按扩展名推断 mime）；URL 型存储位置不能在本地读取，路径在未配置 rootDir 时会抛 `input_validation`。

workflow 执行期间生成文件时，通过 `context.files.createFile(...)` 写入：

```ts
const frame = await context.files?.createFile?.({
  name: "frame.png",
  mimeType: "image/png",
  buffer,
  kind: "image",
});
```

`createFile` 是可选方法：只有 server-backed runtime file storage 存在时可用，否则抛 `project_execution`。本地宿主或 CLI 已显式连接服务器时可调用，未连接时报错，不回退本地。默认单文件上限 50 MiB，省略 `kind` 时按 mime 推导，返回 `{ storage: "server", url: "/api/projects/files/<id>" }`。Remote file store 可通过 `context.files.resolveFile(reference)` 鉴权读回服务器文件的原始字节，不使用引用中的任意 URL 或磁盘路径。

返回 reference 使用 server file URL 形态 `/api/projects/files/<fileId>`。Desktop 或 CLI 本地 run 只有连接 server 时才能创建这些 reference；否则调用会在 runtime 失败，而不是回退到本地文件。

Output node 示例：

```ts
const outputNode = steamharness.createOutputNode<Parsed, OutputPayload>({
  name: "output",
  async *stream(input) {
    yield input.message;
  },
  format(stream, input) {
    return {
      ...steamharness.createOutputPayload({
        items: stream.items,
      }),
      source: input.message,
    };
  },
});
```

LLM/agent 正文 inline 输出示例：

```ts
const outputNode = steamharness.createOutputNode<Parsed, OutputPayload>({
  name: "agent-output",
  async *stream(input) {
    for await (const event of input.agent.run(input.prompt)) {
      if (event.type === "text_delta") {
        yield event.text;
      } else if (event.type === "tool_start") {
        yield steamharness.createOutputItemChunk({
          type: "output_item_start",
          item: {
            id: `tool-${event.callId}`,
            title: `${event.toolName} running`,
            content: { args: event.args, status: "running" },
            contentType: "json",
            collapsed: true,
            iconPreset: "code",
            metadata: {
              kind: "agent-tool",
              status: "running",
              toolName: event.toolName,
            },
          },
        });
      }
    }
  },
  format(stream) {
    return steamharness.createOutputPayload({ items: stream.items });
  },
});
```

如果 agent 正文需要稳定 item id 来避免 live/final 合并重复，可以手动 start/delta/end，但仍不能加 metadata 或 icon：

```ts
yield steamharness.createOutputItemChunk({
  type: "output_item_start",
  item: {
    id: "agent-answer",
    title: "Output",
    content: "",
    contentType: "markdown",
    collapsed: false,
  },
});
yield steamharness.createOutputItemChunk({
  type: "output_item_delta",
  itemId: "agent-answer",
  delta: answerDelta,
});
```

Details output node 示例：

```ts
const detailsNode = steamharness.createDetailsOutputNode<Parsed>({
  name: "output",
  title: (input) => input.title,
  icon: "success",
  content(input) {
    return input.details;
  },
});

const details = await steamharness.runNode(detailsNode, parsed, context);
```

`createDetailsOutputNode` 返回普通 output node；默认 payload 包含 `errCode`、`errMessage` 和 `items`。单个 item 有 `title`、`icon`、可选 `iconPreset`、原始 `content`、推断出的 `contentType` 和 `collapsed: true`。需要多个 details 块时复用一个 details output node，不要声明多个名为 `output` 的节点。

- `steamharness.runNode` 运行普通节点。
- `steamharness.runStreamNode` 运行流式节点并返回 `{ chunks, output }`。`StreamNodeDefinition.accumulateChunk?(chunks, chunk): void` 可原地更新本次运行保留的 chunks，默认逐项追加；所有原始 chunk 仍依次触发 hooks。Core Agent 节点只保留最新完整会话快照，普通正文和工具事件不丢失；finalize 和返回值使用保留的 chunks。
- 流式 `createOutputNode` formatter 接收 `{ text, items, chunks }`。
- 字符串 chunk 会自动追加到默认 inline Markdown `Output` item，适合 LLM/AI/agent 正文和普通文本。结构化 chunk 使用 `steamharness.createOutputItemChunk(...)`，支持 `output_item_start`、`output_item_delta` 和 `output_item_end`，适合工具调用和辅助 detail。
- `steamharness.runIf` 运行显式分支节点。第一个命中的 `condition` 生效；没有任何分支命中且未声明 `else` 时抛 `node_execution`，所以要么覆盖全部情况，要么显式声明 `else`。
- `steamharness.runFor` 和 `steamharness.runWhile` 运行显式循环节点。迭代次数达到 `maxIterations` 时抛 `node_execution`；`maxIterations` 为 `undefined`、非有限数或 ≤ 0 时会静默回落到默认值（`runFor` 1000、`runWhile` 100），不会报错，所以不要用非法值表达"不限制"。
- `steamharness.runProject` 在当前 `RunContext` 内调用另一个 imported workflow，嵌套深度最多 16 层，超过后抛 `project_execution`；可传 `{ name?, metadata?, conversationMode?, outputVisibility?, emitNode?, maxDepth?, onOutputChunk?, onOutput? }`，`maxDepth` 用于收紧而不是放开默认上限。
- 用户可见的 terminal 或 Desktop 输出应来自 output-node stream chunks。
- 如果 stream node 没有产生最终 output，应抛出清晰错误，不要返回 `undefined`。

Branch node 示例：

```ts
const routed = await steamharness.runIf(input, context, {
  name: "Route branch",
  branches: [
    {
      label: "urgent path",
      description: "High-priority work.",
      condition: (value) => value.priority === "urgent",
      run: (value) => ({ ...value, route: "urgent" }),
    },
    {
      label: "review path",
      condition: (value) => value.needsReview,
      run: (value) => ({ ...value, route: "review" }),
    },
  ],
  else: {
    label: "normal path",
    run: (value) => ({ ...value, route: "normal" }),
  },
});
```

当 Diagram 需要显示每条 if / else-if / else 路径时，让 `branches` 与 `else` 保持对象或数组字面量。branch `run` 内部嵌套的 `steamharness.runIf` 也支持，只要静态可见就会显示在对应分支下。

Loop node 示例：

```ts
const rounded = await steamharness.runFor(input, context, {
  name: "Round loop",
  maxIterations: 6,
  items: (state) => Array.from({ length: state.rounds }, (_, index) => index + 1),
  async run(state, value, index, loopContext) {
    return steamharness.runNode(roundNode, { ...state, value, index }, loopContext);
  },
});

const boosted = await steamharness.runWhile(rounded, context, {
  name: "Boost until target",
  maxIterations: 8,
  condition: (state) => state.total < state.target,
  async run(state, loopContext, iteration) {
    return steamharness.runIf(state, loopContext, {
      name: "Choose boost strategy",
      branches: [
        {
          label: "burst",
          condition: (current) => current.target - current.total >= 7,
          async run(current, branchContext) {
            return steamharness.runFor(current, branchContext, {
              name: "Burst passes",
              maxIterations: 3,
              items: () => [4, 3],
              async run(passState, value, index, passContext) {
                return steamharness.runNode(boostNode, { ...passState, value, index, iteration }, passContext);
              },
            });
          },
        },
      ],
      else: {
        label: "finish",
        async run(current, branchContext) {
          return steamharness.runNode(boostNode, { ...current, iteration }, branchContext);
        },
      },
    });
  },
});
```

重复业务步骤需要在 Diagram 中可见时使用 loop node。`runFor` 默认最多 `1000` 次迭代，`runWhile` 默认最多 `100` 次。用户可见示例要显式设置 `maxIterations`；达到上限时节点以 `node_execution` 失败，而不是静默停止。

Nested workflow 示例：

```ts
import { openaiAgentsProject } from "../openai-agents/index";

const agentOutput = await steamharness.runProject(
  openaiAgentsProject,
  {
    message: input.query,
    defaultTools: false,
    memoryTools: false,
    testTool: false,
    writeConversation: false,
    writeAgentState: false,
    customTools,
  },
  context,
  {
    name: "OpenAI Agents core",
    conversationMode: "shared-readonly",
    outputVisibility: "hidden",
  },
);
```

Executor entrypoint 只提供一层扁平的独立启动目录，不表示父子执行关系。用户直接运行任一 entrypoint 时只创建该入口的 run，不会先运行默认入口；多级业务编排继续通过 `steamharness.runProject(...)` 显式表达，不要把层级编码到 entrypoint ID。

`conversationMode` 始终默认 `shared`，即使提供了 options object。除非父 workflow 显式使用 `shared-readonly`，否则子 workflow 可以写父 conversation；`shared-readonly` 会让该次调用中的 `appendMessage`、`setValue` 和 `setTitle` 成为 no-op。除非父 workflow 显式传入 `outputVisibility: "hidden"`，否则子输出仍可见。父 workflow 想避免重复 transcript 时，应由父 workflow 追加 user 或 assistant message、设置标题，并发出或转发最终 output item。业务数据库隔离由资源绑定决定，子工作流继承当前入口资源；需要独立业务数据时定义独立资源。

桥接型 workflow 优先保留子 workflow 输出，不要在父 workflow 中重建子文本或 tool items。可在父 output node 中使用以下模式：

```ts
async *stream(input, context) {
  // createAsyncQueue is a local helper, not a built-in workflow API. Implement
  // it in the workflow or replace it with an existing async iterable queue.
  const queue = createAsyncQueue<RunOutputStreamChunk>();
  const childRun = steamharness.runProject(childProject, input.childInput, context, {
    conversationMode: "shared-readonly",
    outputVisibility: "hidden",
    onOutputChunk(chunk) {
      queue.push(chunk as RunOutputStreamChunk);
    },
    onOutput(output) {
      for (const chunk of createChunksFromOutput(output)) {
        queue.push(chunk);
      }
    },
  }).finally(() => queue.end());

  yield* queue;
  await childRun;
}
```

LLM node 示例：

```ts
const llmProvider = steamharness.createLLMProviderRef("default", () => {
  return steamharness.createLLMProviderFromConfig();
});

const llmNode = steamharness.createLLMStreamNode<Input>({
  name: "answer-llm",
  provider: llmProvider,
  mapInput(input) {
    return {
      system: "You are a concise assistant.",
      prompt: input.message,
      maxOutputTokens: 300,
    };
  },
});
```

`steamharness.createLLMProviderFromConfig()` 通过 `steamharness.getConfig(name)` 读取 `LLM_TYPE`、`LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`。

需要使用当前登录账户在 SteamHarness Server 上开通的 AI 配置时，调用：

```ts
const credentials = await steamharness.getServerLLMCredentials({ signal: abortSignal });
const credential = credentials[0];
const provider = credential.createProvider({ model: credential.models[0] });
```

系统 AI 目录按服务地址和账号在进程内复用 30 秒，合并并发刷新；设置或显式刷新可传 `{ signal: abortSignal, fresh: true }`。临近过期的代理凭据仍在线刷新，401/403 后不得复用旧 token。目录和短期 token 不落盘，取消一次等待不取消其他调用的共享刷新。

每个凭据对象公开 `id`、`name`、`platform`、`providerType`、`models`、逐模型 `modelDetails`、`createProvider`、`startLLMProxyBridge` 和兼容方法 `startOpenAIProxyBridge`。`modelDetails` 包含模型显示名称以及 `vision`、`webSearch`、`reasoning`、`toolCalling`；未知模型的能力均为 `false`。短期代理 token 保存在 Core 闭包中，workflow 不应读取、持久化或输出它。联网搜索必须在 `credential.modelDetails` 中找到当前模型，且 `capabilities.webSearch` 明确为 `true` 时才调用 `credential.createProvider({ model, webSearch: true })`，workflow 不要自行按模型 ID 推断。系统 AI 连接只接受独立的 `STEAMHARNESS_AI_SERVER_URL` / `STEAMHARNESS_AI_API_KEY` 或 workspace CLI 保存的 `aiServerUrl` / `aiApiKey`；项目 Server 的 `STEAMHARNESS_SERVER_URL` / `STEAMHARNESS_SERVER_ADMIN_KEY` 不会作为回退，也不会被当作系统 AI 连接。URL 和 token 必须成对使用。Provider 会在调用前检查一小时短凭据，临近到期时合并并发刷新。

只接受 HTTP base URL 的 agent SDK 可以通过 `credential.startLLMProxyBridge({ signal })` 创建临时 loopback 桥。返回的 `baseUrl` 和 `apiKey` 只用于当前本地桥，`apiKey` 不是上游或 Server 凭据；OpenAI Responses 固定使用 `/responses`，Anthropic 固定使用 `/messages`，请求体上限为 50 MiB。兼容方法 `startOpenAIProxyBridge()` 仅允许 OpenAI Responses。调用方必须在 `finally` 中执行 `close()`。

每个凭据对象另有 `defaultModelId: string | null`，表示账号在该平台上配置的默认模型；用户没有显式指定模型时优先使用它，再把结果传给 `createProvider({ model })`，不要自行猜模型 ID。

非流式 LLM 节点使用 `steamharness.createLLMNode(...)`，适合小型内部转换或需要自定义输出映射的场景：

```ts
const classifyNode = steamharness.createLLMNode<Input, JudgmentPayload>({
  name: "judge",
  provider: llmProvider,
  mapInput(input) {
    return { prompt: input.text, system: "只输出 JSON。" };
  },
  mapOutput(output, input, context) {
    return { errCode: 0, errMessage: "", verdict: output.text.trim() };
  },
});
```

`createLLMNode({ name?, provider, mapInput, mapOutput?, historyLimit?, metadata? })`：`provider` 与 `mapInput` 必填，不声明 `mapOutput` 时节点输出原始 `LLMChatOutput`。`createLLMStreamNode({ name?, provider, mapInput, historyLimit?, metadata? })` 只接受这四个选项，流式节点固定输出拼接后的文本。

自定义节点内部解析 provider 时使用 `steamharness.getLLMProvider(context, nodeName, source?)`：它按「节点名绑定 → 传入的 `source` → 默认 provider → `context.providers.llm` → `source` 的 fallback 引用」顺序解析，并自动包一层 token usage 上报；无法解析时抛 `provider_call`。`context.providers` 提供 `llm`、`llmProviders`、`llmProviderBindings`、`defaultLLMProviderBinding` 和 `defaultLLMProviderId`，由入口的 `createContext` 或宿主注入；不要绕过它去读环境变量拼自己的 provider 选择逻辑。


## Agent（pi SDK 能力层）

Bot 使用 `steamharness.defineBot({ name?, agent?, tools?, params?, resolveParams?, conversation?, prepareInput?, onCompleted? })`，返回固定 `projectType: "bot"` 的 `BotExecutorDefinition`。输出固定为 `AgentOutputPayload`，最终正文地址为 `agent-answer`。不接受自定义 `workflow`、`coreAgent`、`createInput`、`tokenUsage` 或 `outputItemId`，旧 Conversation 项目类型与工厂已删除。

`agent` 保留 Core 的模型来源、提示词、技能、权限、工具与 session 配置。Model、Effort、Plan、权限参数自动继承；用 `agent.paramOptions` 定制默认值、分组、显隐和固定值，顶层 `params` 仅追加业务字段，不覆盖保留字段。固定参数在输入钩子后仍生效。

Core 统一解析文本、图片与 OpenAI 宿主输入。`prepareInput(input, context)` 返回扩展的 `AgentInput`，可读取配置、调用聚合入口或加载索引；context 提供资源、取消信号、args 与 paramValues。工具工厂 `agent.createTools(context, input)` 和 session 工厂 `agent.createSession(context, input)` 接收准备后的输入。会话队列、durable、recovery、用量和网关由 Core 固定提供；`conversation` 仅定制展示、命令、输入交互和 `recovery.startup: "automatic" | "manual"`。

`onCompleted({ requestId, output }, context)` 接收成功结果的只读快照，返回 void。按 requestId 幂等保存业务回执，不修改输出或再次运行模型。Core 持久化结果与通知状态；通知失败单独报告，恢复只补通知。持久宿主的后续消息也经过输入钩子与完成通知。`conversationId`、会话历史及 `context.entries.conversations` 继续表示会话。

独立 Workflow 需要 Agent 节点时仍可使用 `steamharness.createAgentNode`，脚本嵌入使用 `steamharness.createAgent`；这些能力不创建另一种 Bot 执行协议。Bot 项目示例见 `assets/examples/bot/index.ts`。

输入字段（`AgentInput`）：`prompt`、`images`、`workdir`、`allowedDirectories`、`systemPrompt`、`provider`、`model`、`baseUrl`、`apiKind`、`modelAttributes`、`webSearch`、`effort`、`agent`、`permissionPolicy`、`contextWindow`、`compact`、`hostInput`、`requestId`、`planResume`、`askResume`。

Bot 的最终答案 item 固定为 `agent-answer`；OpenAI 适配器使用相同地址，项目不能覆盖。

- `workdir` 与 `allowedDirectories` 合起来决定本轮内置工具能碰哪些路径（相对 `allowedDirectories` 按本轮的 `workdir` 解析，省略时就是 `[workdir]`）。**两者都是逐轮生效的**，所以宿主把外部文件夹挂进工作区时，按这一轮实际的工作区传进来，而不是在建运行时写死。
- `systemPrompt` 是本轮的系统提示词，逐轮生效并覆盖 `AgentProjectOptions.systemPrompt`。plan 模式下 plan 提示词仍在前，这段内容追加在后，所以 plan 的只读约束不能靠它改掉。
- `images` 取 `{ data, mimeType }`（`data` 为 base64），会随 prompt 一起真正发给模型。
- `effort` 取 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（也接受 `ultra`，等同 `max`）；超出模型支持范围时自动收敛到该模型支持的档位。**空字符串表示「交给模型决定」**，pi 用「不指定任何档位」来表达它——也就是 `off`：OpenAI 类端点因此收不到 `reasoningEffort`，与内置 OpenCode 项目的「Model default」一致；对 Anthropic 这一类则会把 `thinking` 显式关掉，想保留推理就挑一个具体档位。完全不传（`undefined`）才表示「没有选择」，本轮沿用运行时/项目自己的档位，无法识别的档位名同样回落到它。
- `agent` 取 `"build"`（默认，直接执行）或 `"plan"`（只调研并给出计划）。plan 模式结束后运行会暂停，通过 `user_input_required` 请求批准；批准后按同一 `requestId` 恢复执行。
  plan 模式下这一轮的正文**就是计划**，因此它只渲染成一条 `Plan` 行，不会再出现在主回答正文里（两处都渲染会让同一段文字显示两遍）；plan 轮的 conversation 消息取这条 Plan 行的内容。
  plan 轮的批准请求与内置 OpenCode 项目一致：一个 `decision` 单选（按计划执行 / 先不执行，各自带说明）加一个 `instructions` 文本框（补充要求，可选）。批准后会暂停并在**同一会话**里以 build 模式带着计划原文继续执行——计划会随恢复提示一起重发，中途发生压缩也不会丢。**拒绝不会结束会话**：它保持 plan 模式，把补充要求与这份计划一起交回计划 agent 修订一版（因此不会改动任何文件，但会再产生一轮模型调用）。待批准的计划存在 conversation value `agent.pendingPlanApproval` 里，恢复时按它取回。
- `permissionPolicy` 取 `"inherit"`、`"read-only"`、`"workspace"`（省略时默认）或 `"auto"`；`inherit` 按上文优先级解析用户快照，底层仍只有三个具体权限：`read-only` 隐藏写入与命令工具；`workspace` 在工作区内自动批准编辑和命令，读写与检索类工具（`read` / `write` / `edit` / `ls` / `grep` / `find`）只能落在工作区与 `allowedDirectories` 内；`auto` 批准一切未被显式拒绝的权限，包括工作区之外的路径。**三者都不会为内置工具弹出审批**——内置工具声明为 `autoApprove: true`，策略只决定「暴露哪些工具」和「工具能走多远」，宿主审批门只对宿主自己声明的工具生效。
  > **`bash` 不受路径限制。** 命令以宿主进程的身份在 `workdir` 里执行，`cwd` 只是工作目录而不是沙箱，命令本身可以读写工作区之外的任何位置；`read-only` 之所以更严，是因为它根本不暴露 `bash`。要限制命令的影响范围，只能靠宿主侧的沙箱，不要指望 `permissionPolicy`。参数面板上那句「工作区之外的路径一律拒绝」指的是文件类工具，**不要**据此认为命令也被关在工作区里。
- `hostInput` 用于「宿主自己保管这一轮的消息历史」的场景（OpenAI / Responses 网关就是这样）：带上它的一轮**不写 conversation 消息，也不读写下面这份 agent 记录**，与内置 Bot 项目在 `input.openai !== undefined` 时的处理一致。项目从 `steamharness.readOpenAIConversationHostInput(context)` 拿到宿主输入时，把它一并放进 `AgentInput` 即可。
- **Pi Durable Harness 是唯一执行历史来源。** 固定 Pi SDK / Durable 1.2.0，Node >=22.19.0。Conversation 节点默认按项目、入口、conversationId 和 sessionKey 选择宿主本地 SQLite 会话，实时提交消息、工具意图与结果、审批等待及用量记录；只有显式注入时才使用 Server PostgreSQL。普通模式每轮关闭运行时；session 模式由宿主 lease 保持工具与 AI bridge 存活，前台回答结束后仍能继续输入和执行后台任务。多个 Agent 节点用不同 sessionKey。没有旧 KV transcript 迁移或 fallback。编程式 `steamharness.createAgent({ databasePath })` 显式选择 SQLite，不传则使用 MemoryStorage，同一运行时内审批暂停仍保留原任务。`readTranscript()` 只读模型上下文投影，`restoreTranscript()` 只用于空存储的首轮 seed，不覆盖已有持久历史，不能恢复活动任务。流式回答强杀后把已提交正文和推理纳入持久续写上下文，丢弃未完成工具调用；续写沿用断流预算。运行结束必须 `await runtime.close()`。
Bot 使用 `steamharness.defineBot`，参见本节的固定契约。
- **崩溃恢复与子任务管理。** 活动 CLI Web / Studio 宿主中的 worker 意外退出最多自动恢复 3 次，沿用既有任务、子会话和已提交工具结果；用户主动停止或宿主强退重开时，未完成业务树仍暂停并等待明确输入。用户队列只由成功用户轮次推进，后台报告不能推进。主 Agent 可用 subagent list/get/wait 查询和等待，send 仅追加到运行中工作，retry 遵守失败类型和重试预算；未知副作用先核验，不用新 workId 绕过限制。
- **宿主协议。** `steamharness/agent` 导出 `createAgentSessionHost(scopeId)`（启动节点前创建，退出时 close）、`controlAgentSession(scopeId, command)` 和 `AgentSessionSnapshot`。scopeId 是原 workflow conversationId；`targetId` 是快照内数字 conversationId。`AgentRuntime.control` 可在 session 运行期间使用，等待就绪和排队前复制命令，调用方后续修改原对象不会改变操作。命令均带稳定 requestId：submit（steer / followUp / reject）、withdraw（inputId）、promote（inputId，原子将排队项转为 steer 并保存回执，保留原身份和图片）、compact、reset（可选 handoff）、fork（已提交 entryId）、delete（子会话）、configure（expectedVersion、已注册 model / effort）、plan（expectedVersion、items）、cancel（foreground / all / task）和 snapshot。相同身份不同载荷拒绝；撤回或提升已消费输入返回 already_placed / settled，不能撤销已完成副作用或重发消息。默认输入框忙碌时使用 followUp，空闲时直接执行；队列项的立即发送使用 promote。创建 fork 前由宿主显示确认弹窗。
- **共享自动恢复。** CLI Web / Studio 对 Agent 命令确认超时、暂未就绪和临时连接故障最多自动重试 3 次，每次最多等待 30 秒，沿用原 requestId、targetId 与载荷。命令持久化后即可返回回执，不等待快照发送；需要最新视图时等待相应快照或显式 snapshot。迟到回执与重试结果都核对原输入，项目连接恢复后可恢复 run 沿用原身份继续。快照投影失败及明确 replay: "safe" 的工具执行异常/isError 最多退避重试 3 次，成功后自动继续；工具每次重试重新校验权限。主动停止、宿主关闭、输入校验、权限拒绝、用户交互等待、retryable:false、宿主存储失败及默认/never/unsafe 工具的未知结果保持停止或核对边界，不通过重放已提交写入掩盖故障。
- **不依赖 AI 的存储分叉。** 没有活动 owner 时，宿主可调用 `steamharness.forkStoredAgentConversation({ persistence, conversationId, command: { type: "fork", requestId, entryId, targetId? } })`，其中 conversationId 是 workflow 会话 ID。该 API 要求恰有一个服务端 Agent session 并取得执行租约，与活动 fork 共用文档继承及持久回执，不加载项目、不校验 AI 凭据、不恢复待执行任务。活动 owner 使用原控制通道执行 fork；不要为分叉重新运行工作流。
- **独立对话分支。** Core 的 fork 保留同库历史关系；CLI Web / Studio 用户创建的分支必须再通过 `steamharness.isolateStoredAgentConversation({ persistence, sourceConversationId, conversationId, targetId, replacements?, retireSource? })` 复制成新 workflow 会话的独立根服务端会话。targetId 使用 forkId；该 API 一致读取源库而不执行恢复，保留可见历史与 asOf 文档检查点，即使内容相同也保留文档版本变化和删除后重建身份，不导入任务、提交队列、审批、provider 身份或用量。宿主独立复制附件并用 replacements 更新文件 ID/路径；无活动 owner 可 retireSource，有 owner 通过控制通道 delete 旧内部分支。新的分支模型、Plan、权限、停止、删除、执行锁和恢复独立于原会话；来源元数据仅用于导航，不作执行 owner。
- **重连与占用。** 重连已有 session 时使用 `createAgentSessionHost(scopeId, { resume: true })`，只重建工具、控制通道并恢复任务，不重发 workflow 初始消息；新输入使用 submit 命令。忙碌拒绝不持久化为原任务失败。Plan 审批和 hostInput 不使用此重连模式。CLI Web / Studio 对重复打开的同一会话显示只读提示，不同会话可并行；同一服务端会话的内部分叉由同一 owner 调度。 宿主失去控制连接时调用返回对象的 `suspend()`，等待 workflow 退出并释放资源，保留未完成输入与检查点；`close()` 等待当前工作结束，主动停止使用 `cancel`，不得把断开控制连接当作取消。
- **模型兜底重试。** 所有模型请求错误统一最多重试 10 次，不按错误文本、HTTP 状态或供应商错误码筛选；流式、持久会话、延迟响应与压缩摘要均适用。保留每次用量、已生成正文和已完成工具结果；失败响应内的工具调用不执行，失败和取消不推进队列。主动停止立即打断退避。运行配置授权校验失败（CONFIGURATION_FORBIDDEN）单独重新读取权限并校验原快照，最多额外重试 10 次，退避上限 8 秒；成功前不执行模型或工具请求，持续拒绝仍报告原错误。其他配置、工具权限、存储和宿主回调错误直接报告，不借重试放宽权限或重放未知写入。
- **等待与工具禁用。** 内置 `sleep({ seconds })` 接受 0–3600 秒（可带小数），可取消，不执行 shell。持久化截止时间，恢复只等剩余时间；进度返回预计结束时间，完成结果保留实际结束时间（details.wakeAt / endedAt 为毫秒时间戳），CLI Web / Studio 按浏览器本地时区显示。read-only 下仍可用，宿主可明确禁用。当前子任务全部结束且无排队项时，持久内部通知自动续行主 Agent，sleep 提前返回；每次清空只通知一次，恢复去重，停止和父失败不借此重启。通知轮次的 hiddenInput: true 要求宿主隐藏用户气泡和待发项，保留助手续答，不单独推进暂停的用户队列；失败、停止项不算成功，业务批次仍需读回核验。等待命名工作优先 `subagent({ action: "wait", taskId })`，定时查询批次前用 sleep，不用 bash sleep 或高频轮询。宿主禁用的内置及自带工具不提供给模型，调用仍校验权限。
- **快照与界面。** `session` 事件或 `metadata.kind: "agent-session"` 辅助输出提供 version、ownerId/revision、tasks/history、turns、contexts、plan、records、receipts、usage 和配置/提示摘要。宿主按 ownerId/revision 接受完整快照，以 receipt 补回丢失确认，不把快照当正文。Studio Trace 提供轨迹、任务、计划、记录、用量五个视图；CLI Web 保留正文、队列与分叉入口，正文 markdown 始终平铺。工具任务 arguments 保存提交参数（非修复或 hooks 后的审计），活动和完成历史均可逐层查看。历史工具按 assistant entry 关联，跨轮复用 call ID 不串任务；流式工具事件 toolCallId 是稳定的不透明展示身份。审批绑定持久 conversation/task/call ID，暂停恢复沿用原决定，后续同 ID、同参数的独立调用重新校验权限。reset 在输入边界进入新世代，保留旧正文；fork 在同一存储会话内新建独立 Harness conversation、provider 身份和队列，不复制活动任务或审批，计划依 planFork 继承。取消 foreground 不跨后台边界，all 包含 owned 子会话但不跨独立 fork，task 校验所属会话。删除子视图会取消并隐藏该子会话，根会话删除才回收底层存储。 未完成轮次的 `reason` 为原因码，`detail` 保留具体模型错误或重试耗尽原因；`model_error` 等显示失败，只有持久取消 `aborted` 显示已停止。未取消请求收到 provider aborted 按断流预算恢复，真实 Stop 不重试。
- **session 的配置与压缩。** 普通 Agent 与 session 都通过 Durable 阈值/溢出压缩事务在每次模型请求前检查，默认达到窗口的 90% 时先压缩；compact 可在活动任务期间提交并与其协调。运行中不允许通过 CLI 参数切换模型、权限或工作目录，空闲后提交会重建工具和 bridge；fork/子视图在主会话修改这些工作流参数。Core configure 使用版本 CAS，仅切换已注册模型/effort，在下一请求生效，不序列化凭据；提示只记录摘要和版本。Plan 模式及 hostInput 不持有 session lease，审批仍按原流程暂停。
- **持久扩展与任务。** 用 `steamharness.createAgentRegistry()`、`steamharness.defineAgentTask<Input, Checkpoint, Result>()`、`steamharness.defineAgentExtension()` 创建项目 registry，通过 `session.registry` 安装；`steamharness.defineAgentDoc()` 声明同事务业务文档，`steamharness.agentHook(steamharness.AgentToolTask / steamharness.AgentGenerationTask, hooks)` 安装工具或模型 hooks。任务定义必须提供稳定 name/version、initial、各 phase 和 abort；每个 phase 通过 `runtime.commit()` 保存进度或终态，依赖用 waiting/on/policy，定时用 `runtime.sleep(绝对毫秒时间, context)`，将同一时间存入 checkpoint.wakeAt 供侧栏展示。宿主 `task` 命令带 name、严格 JSON input（最多 256 KiB）及可选 background；Date、Map、函数、非有限数等在记录 requestId 前拒绝，receipt 与创建任务原子保存，同 requestId 不重复创建。不要覆盖 `pi.*`、`steamharness.*` 名称或已有工具。registry 热更新采用不可变快照，在途工具/hook 固定实现；定义缺失或不兼容在重新调度/重开时 blocked，重新安装兼容定义后唤醒。
- **授权目录与延迟 MCP。** 显式启用 `session.toolSearch`，目录经 `catalogs: [{ id, tools?, allowedTools?, open }]` 声明；tools 是不含 execute 的工具描述，allowedTools 使用最终 Agent 工具 id。未预声明 schema 时首次搜索才连接并持久化目录；重开旧会话后搜索仍会连接授权目录，发现并保存新增工具。有 schema 时打开会话先保存新工具定义，首次实际调用才连接。open 返回 `{ tools, close? }`，按名称、描述、schema 和 replay 核对每个已有工具的当前描述及首次持久化定义，同时更换宿主和服务描述也不能绕过。仅在授权范围内增加工具可兼容原会话，不使原有工具失效；已有定义漂移、缺失、名称重复或未授权工具均拒绝执行并关闭连接，改变已有定义须创建新会话，暂时连接失败可再次调用重试。`steamharness.createMcpToolCatalog({ definition, allowedTools, descriptors?, connect?, approve? })` 使用原始 MCP 名称白名单；不扫描任意服务或读取外部配置。`createTools` 也可返回 `{ tools, catalogs, close? }`，需要 session.toolSearch；显式工具权限列表仍须声明 tool_search 和目录中的最终工具名称。
- **Code Mode。** `session.codeMode: { memoryLimitBytes?, timeoutMs? }` 显式启用官方 QuickJS，默认关闭；默认 64 MiB/300 秒，上限 256 MiB/300 秒。脚本仅能访问本会话授权工具，不能直接访问 Node、凭据或独立模型；所有嵌套调用仍走 caller、权限、审批、replay 和取消。显式工具权限须包含 codemode。任务树提供脚本及嵌套调用，不改变主回答正文；小助手不提供 Code Mode 项目配置项；需要此能力时由项目宿主通过 `session.codeMode` 显式启用。
- **执行目标。** `session.environment: { id, label, open(target, context) }` 返回公开 `AgentExecutionEnv`，id/cwd 必须与目标一致，同一持久会话不能更换环境身份。read/write/edit/bash 使用该环境，grep/find/ls 不提供本机回退；文件范围与命令权限由远端环境负责执行。宿主关闭会在 Harness 停止后 cleanup，不提供云沙箱创建服务，凭据只由工厂重建。快照 resources 记录环境、registry、目录、存储及 Code Mode 状态，只供辅助诊断。
- **本地与服务端 Agent 存储。** 从 `steamharness/runtime-storage` 导入 `createLocalRuntimePersistence({ directory })`，将其 `agentStorage(conversationId, sessionKey)` 传给 `createAgent({ storage })`；与 databasePath 互斥。CLI/Studio 默认 Conversation、Workflow、助手历史和 Core Conversation/Usage 使用宿主本地 SQLite，不要求为历史存储登录或联网。云端按需接入 `createServerAgentStorage({ serverUrl, token, workspace, sessionKey })`：token 使用当前账号凭据或取值函数，不进入项目源码、URL 或模型输入；管理员密钥不代表账号。workspace 为 `{ kind: "project", projectId, entryId }`（逐请求校验项目与入口权限），或 `{ kind: "local" | "assistant", projectId, entryId, localKey }`（账号私有空间），也可复用 `{ id }`。显式 Server 仓储使用租约、递增 fence 和稳定请求 ID，断连或续租失败停止执行。系统 AI、业务关系表和知识库仍分别鉴权，不属于本地历史存储；旧云端与本地数据保留，不自动迁移或双写。
- **自定义存储与备份。** `storage: { label, open() }` 与 databasePath 互斥，open 返回 `{ storage: AgentStorage, failure?: AbortSignal, release?() }`，工厂负责独占 owner；Harness 先 close，再 release。宿主从 `steamharness/agent` 导入 `exportAgentDatabase({ databasePath, destination })` 与 `importAgentDatabase({ source, databasePath })`，只用于离线 SQLite；先停止并等待 worker，两个函数均获取源与目标的独占 owner 锁，校验 Durable 表结构并用 backup 包含 WAL，目标必须不存在且未被其他 owner 预留，不覆盖会话。它们不是注入的 workflow 全局成员。数据库备份不包含项目工作区文件或凭据。
- **自定义任务的离线取消。** 优先向活动 owner 提交 cancel，执行已注册的 abort。宿主先停止并等待 worker 后，也可调用 `steamharness/agent` 的 `cancelAgentConversation({ agentStoreDir, conversationId, registry })`，传入相同项目定义执行清理；缺少定义的任务仅能终结为 orphaned，不能执行项目清理代码。
- **联网搜索。** `AgentModelAttributes.webSearch` 声明端点能力；为 true 时默认添加 OpenAI Responses `web_search` 或 Anthropic Messages `web_search_20250305`（每次请求最多 5 次）。`AgentRuntimeOptions.webSearch` 与本轮 `AgentInput.webSearch` 为 boolean 开关，本轮优先；false 关闭，未声明能力的自建端点可显式 true，能力 false 或其他协议开启时报 input_validation。OpenAI 须用 `apiKind: "openai-responses"`，Chat Completions 不支持。保留本地工具，搜索由提供方执行，模型自主决定是否调用；摘要请求不启用。不要把 `web_search` 注册为本地 AgentTool。运行时产出 `web_search: { search: { id, status, query?, sources, error? } }` 和 `sources: { sources: { url, title?, citedText? }[] }`；节点显示搜索详情和可点击来源，持久会话在各自 turns[].items 保存投影，提供方原始内容只用于同提供方/模型续聊，不进入输出。关闭下一轮搜索仍保留有效搜索历史。Anthropic pause_turn 最多自动续接 3 次。内置参数表仅包含小助手的五个标准字段；高级 argv helper 仍支持 --web-search 的空字符串（自动）、true、false 三态；静态内联 params 的项目可在模型设置 auxiliary 中声明 `{ name: "webSearch", flag: "--web-search", type: "string", control: "select", defaultValue: "", options: [{ value: "", label: "自动" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }] }`，交由 createAgentProjectInput 解析。
- **自动压缩。** 普通 Agent 与持久会话在每次模型请求前检查上下文，包括同一轮工具执行后的继续请求；默认占用达到模型窗口的 90% 时先压缩较早的历史，再继续运行，`contextWindow` 覆盖值参与判断。事件为 `auto: true`，开始发送 start，成功后发送 end；失败或取消保留原记录，压缩失败会终止本次运行。提供方返回明确超限错误时尝试一次压缩后重试，再次超限直接报错。超限历史分块总结并合并摘要，每次摘要请求预留输出空间，所有调用计入用量。保留最近消息及完整工具调用与结果；剩余单条输入或工具结果仍超限时须缩短该内容。`session.compaction.enabled: false` 关闭自动压缩和溢出恢复，手动压缩仍可用。
- **恢复使用稳定请求身份。** Agent 节点从原 `runId` 派生 requestId，重试与恢复必须沿用原参数、已解析答案和 runId。已提交工具结果不重做；默认 `replay: "never"` 的未知结果工具返回中断错误，只有明确 safe 的工具自动重放。写、编辑和 bash 都为 never；这不提供外部副作用 exactly-once 保证。存储或投影失败终止运行，不能静默丢历史继续。审批等待期间也不能压缩或替换上下文。
- Agent 在运行开始、流式消息、工具结果和压缩后发送 `context_usage`，由节点转换为 `display: { type: "ring", placement: "composer-right" }` 的标准输出项；首次对话不等待模型响应即可出现圆环。宿主只消费通用输出协议，不能另读 Agent 字段实现专用显示。输出 payload 的 `contextUsage: { used, total }` 供程序读取，`--context-window` 可覆盖分母。`used` 优先取最近一次有效模型 usage（含缓存 token）加后续消息估算；没有有效 usage 时估算实际系统提示、命名提示段、工具定义与消息，西文按 4 字符约 1 token、CJK 按字符计、图片近似估算。实际压缩后保留的旧响应 usage 不再参与校准，恢复记录后同样生效。
- Durable 快照的 `turns[].startedAt` 是输入实际进入执行时的 Unix 毫秒时间，排队期间省略；`endedAt` 来自该轮执行任务的持久结束时间，运行中省略。宿主据此计时，首次打开子会话、刷新及重开均保留打开前的执行时间；跨度包含等待和恢复。字段可选，缺少可靠起止记录时不得从页面打开时间补造历史耗时。
- Durable 快照的 `tasks/history[].startedAt/endedAt` 为持久执行跨度，委派从子输入实际执行时开始，排队不计时；`usage` 是所属子会话树的已提交 `TokenUsageAggregate`，包含失败尝试。`capturedAt` 为 Unix 毫秒快照时间，断线/中断据此固定耗时，旧记录缺少可靠跨度时显示未知。`contexts[].tokenUsage` 汇总当前会话与 owned 子会话树的持久模型/工具用量，包括重试、失败、停止/reset 前的消耗及空闲压缩。每个 owned 子会话只统计一次，独立 fork 分开计费，隐藏子会话不扣减已消耗用量；宿主直接替换完整总量，不再叠加子任务或 owner 的累计事件。CLI Web / Studio 在子任务右侧显示耗时和 Token，用图标/详情保留状态，并在最新回答显示会话总量；项目禁用 Token 展示时隐藏统计。
- Durable 快照的 `turns[].usage` 为该回答轮次已返回的模型用量（标准 `TokenUsageAggregate`），包含工具循环、失败重试与轮内压缩；不得用 owner 工作流跨会话的累计 `token_usage_updated` 或最终报告覆盖回答。继承历史及其他 fork 不重复计入该轮。`contexts[].contextUsage` 提供各会话当前占用，Agent 节点将其转换为同 ID 的标准圆环 `contexts[].outputs`；宿主选择当前打开会话的通用输出覆盖历史值，保证后续轮次、fork、压缩与 reset 后同步。空闲后台压缩的消耗只保留在会话总用量，不回写已完成回答。
- 编程式 `AgentRuntime.getContextUsage()` 随时返回当前上下文占用，包含正在流式生成的消息；模型窗口不可用时返回 `undefined`。`updateContextUsage({ used, total })` 提交当前占用的绝对测量值，`used` 必须为非负有限数，`total` 必须为正有限数；运行中的 `context_usage` 立即发送该更新。后续估算在测量值上增长，直到有效模型 usage 或实际压缩重新校准；`total` 不修改模型配置，模型校准使用本轮 `contextWindow` 或模型窗口。`reset()` 同时清除测量值和恢复记录。独立 transcript 可通过 `steamharness/agent` 的 `estimateAgentContextTokens(messages)` 估算。
- AI 配置、模型和 Effort 放在一个 `kind: "quick"` 的 `fields` 中；Permission 用另一个 Quick。Agent 模式使用 `kind: "mode"` 独立开关，Context window 和工作目录可分别放在有明确标签的 Auxiliary 中。动作入口在 Desktop 上按声明顺序显示，具体形态见 `references/param-panels.md`。
- 直接把 prompt 写成 `/compact` 或 `/summarize`（或传 `compact: true`）会立即总结全部已有上下文，不调用模型生成普通回答；空上下文直接完成。先发送 `compaction` start，成功后发送 end 并持久化摘要，后续回合使用摘要，原对话正文保留。只有非空且正常结束（`stopReason: "stop"`）的摘要才替换 transcript；模型失败、截断或未完成时抛错并保留原始记录，取消以 `execution_aborted` 结束，取消后返回的摘要也不能写入。公开 `compactAgentMessages({ ..., force: true })` 同样总结全部已有消息。自动压缩才保留最近的一段对话：最近的窗口里没有用户轮次时退到最近的 assistant 轮次，最新一条消息永远保留。
- 总结响应的计费用量同样通过 `host.reportUsage` 上报，包括失败或取消响应中的已消耗 token；不能把它当作总结后的上下文大小。直接调用 `compactAgentMessages` 可传 `onUsage(usage)`，在摘要校验前接收模型返回的 pi `Usage`。
- **取消运行会中止本轮**：`context.abortSignal` 一触发就调用 pi 侧的 `agent.abort()`，模型流与正在执行的工具一起停下，本轮以 `execution_aborted` 结束（工作流据此把运行标成 aborted，而不是失败），已经花掉的 token 仍会照常上报。

底层 Agent 选项（Bot 通过 `BotAgentOptions` 暴露受限子集）：`workdir`、`systemPrompt`、`provider`、`model`、`baseUrl`、`apiKind`、`modelAttributes`、`webSearch`、`effort`、`permissionPolicy`、`mode`、`tools`、`toolDefinitions`、`allowedDirectories`、`extraTools`、`createTools`、`createSession`、`session`、`sessionId`、`sessionKey`、`databasePath`、`storage`、`name`、`historyLimit`，以及项目级 `executorName`、`projectName`、`outputItemId`、`params`。

内置工具为 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`，以及**只在 plan 模式提供**的 `ask_user`。问答和计划通过 `context.userInput` 暂停，跨进程以原 runId 恢复；工具从原持久意图继续，askResume 回填答案，plan 决定使用稳定续跑身份，旧决定不能批准新 run。文件类工具经 realpath 校验工作区与 allowedDirectories；grep/find 不跟随软链接。bash 以宿主身份执行，不是文件沙箱。工具审批复用 context.toolPermissions，plan 回合才对未自动批准工具提问，build 直接执行，禁用工具仍拒绝。模型用量携带稳定 recordId，Core 原子 upsert，重放不重复累计；上游强杀前未返回的用量须另行对账。

**调用方自带的工具。** 内置的 7 个工具以外，调用方可以按轮注入自己的工具：

- `AgentNodeOptions.createTools(context)` 在每次运行前调用，返回的 `AgentTool[]` 与本轮内置工具合并后交给模型；需要 `NodeContext`（storage、`context.toolPermissions` 等）时使用这个工厂。具有生命周期的资源返回 `{ tools, catalogs?, close?() }`；普通运行在轮末 close，session 模式持续到宿主 lease 释放并关闭 Harness。编程式运行时用 `AgentRuntimeOptions.extraTools` 传静态工具。
- 外部工具**不经 `permissionPolicy` 过滤**——策略只约束内置的那 7 个工具。它们由宿主自己的工具目录治理：项目在 `executor.tools` 里声明它们，声明里的 `enabled` 决定是否暴露、`autoApprove` 决定是否自动批准；`autoApprove: false` 的外部工具会暂停本轮等待用户批准（走 `context.toolPermissions`）。

**自己写的工具长什么样。** 下面这段形状由 `scripts/agent-tool-contract.mjs` 从当前 Core 依赖的 pi agent SDK 类型里生成，`pnpm test` 会校验它和安装的类型一致——所以它不会悄悄过期，你也不该按它在安装包里找那个 SDK 的类型声明：

<!-- agent-tool-contract:begin -->
```ts
// 本段由 scripts/agent-tool-contract.mjs 依据 @earendil-works/pi-agent-core@1.2.0 生成。
// 要改就改脚本里的契约表并运行 `pnpm agent-tool-contract`；手改会在 `pnpm test` 里失败。
interface AgentTool<TParameters = unknown, TDetails = any> {
  /** 工具 id，模型看到的名字；必须与 executor.tools 声明里的 name 逐字一致。 */
  name: string;
  /** 给模型看的一句话：什么时候该用它。 */
  description: string;
  /** 参数 schema：直接写一个 JSON Schema 对象，项目里没有 TypeBox 可用。 */
  parameters: TParameters;
  /** 宿主 UI 里的展示名。 */
  label: string;
  /** structuredContent 的 JSON Schema。 */
  outputSchema?: object;
  /** 执行。失败必须 throw 或设置 isError: true，不要只把错误写进 content。 */
  execute: (toolCallId: string, params: TParameters, signal?: AbortSignal, onUpdate?: (partial: AgentToolResult<TDetails>) => void) => Promise<AgentToolResult<TDetails>>;
  /** 崩溃时结果未知的调用：默认 never，不自动重做；只有可安全重复的操作声明 safe。 */
  replay?: "never" | "safe";
}

interface AgentToolResult<TDetails = any> {
  /** 回给模型的内容块：`{ type: "text", text }`，或给模型看图时的 `{ type: "image", data, mimeType }`（`data` 为 base64）。 */
  content: (TextContent | ImageContent)[];
  /** 给宿主渲染和日志用的结构化细节；模型看不到它。 */
  details: TDetails;
  /** 匹配 outputSchema 的 JSON 结果；与给模型的 content 分开。 */
  structuredContent?: unknown;
  /** 失败时设置 true。 */
  isError?: boolean;
}
```
<!-- agent-tool-contract:end -->

```ts
const readTask: AgentTool = {
  name: "db_get_task",
  label: "Read a task",
  description: "按 ID 读取当前业务数据库中的任务。",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "任务 ID" } },
    required: ["id"],
  },
  async execute(_toolCallId, { id }) {
    const db = await context.databases.connect(data);
    const value = await db.task.findUnique({ where: { id } });
    return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], details: { id } };
  },
};
```

- **`parameters` 直接写 JSON Schema，项目里没有 TypeBox 可用。** `Type` 由 Core 自己解析，`createMcpTools` 内部才用它去包装 MCP 服务的 schema；项目既不需要也拿不到它。schema 里的 `type`、`required`、`properties` 照常生效：参数不合规时 `execute` 根本不会被调用，模型收到的是一条工具错误。
- **`execute` 失败必须 `throw` 或返回 `isError: true`**。只把失败写进 `content` 仍会被当作成功。
- **声明和实现是两处，名字必须对上。** `executor.tools` 里那一项（`{ name, label, description, enabled, autoApprove }`）是宿主的工具面板与审批目录，`createTools` 返回的对象才是真正交给模型的实现；`enabled` 决定是否暴露、`autoApprove` 决定是否自动批准。工具没有出现在 `executor.tools` 里，用户就看不到、也无法授权它。

连接宿主提供的 stdio MCP 服务：

- `steamharness.normalizeMcpServers(servers, options?)`：在启动任何子进程之前校验服务定义——命令必须是绝对路径、`id` 匹配 `^[a-z][a-z0-9-]{0,63}$`、不得重复、`timeout` 落在 1–300 秒，最多 8 个服务。
- `steamharness.connectMcpServer(definition, options?)`：启动一个 stdio MCP 子进程、完成握手并列出它暴露的工具，返回 `{ id, tools, callTool(name, args, signal?), close() }`。
- `await steamharness.createMcpTools({ connection, approve?, createToolId? })`：把连接暴露的每个工具变成一个可交给 agent 的工具。返回 Promise，TypeBox 运行时由 Core 自己解析（`Type` 只在测试里显式传），项目不需要、也没有办法 import 这个 SDK。**工具名默认是 `<服务 id>_<工具名>`**（例如 `workflow-desktop_desktop_state`），与内置 OpenCode 项目一致，所以宿主已经声明的工具目录与权限面板不需要改名；`parameters` 用 `Type.Unsafe(tool.inputSchema)` 包装，服务的 JSON Schema 原样交给模型；工具返回 `isError` 时**抛错**而不是把错误当成正常输出。服务端发布的 schema 会先做形状检查——必须是对象、嵌套不超过 64 层、序列化后不超过 256 KiB——超过就抛错并且**不注册这个工具**：MCP SDK 把 `inputSchema` 当作 `unknown` 交出来，agent SDK 又把它当既成事实收下，深到能压爆栈的 schema 会在注册阶段把进程带走。
- 一个服务的工具总数上限 256，超出的分页在合并前就被拒绝；列目录时游标只在「有进展」时推进，重复游标会以循环为由中止。
- 生命周期是每轮连接、`finally` 关闭。SDK 在 `connectMcpServer` 内部用动态 `import()` 加载，不使用 MCP 的运行时不解析也不加载它。

Bot 使用 `steamharness.defineBot`，参见本节的固定契约。

Bot 在 `agent.skills.directories` 声明技能目录，Core 自动注册 skill 工具，并通过 `listLocalProjectSkills` / `readLocalProjectSkill` 提供宿主预览。

**技能按需读取，不注入提示词。** `await steamharness.createSkillTools({ directories, approve? })` 返回一个 `skill` 工具：

- `action: "list"`：按名称排序列出技能名、说明与文件清单；整页 JSON 最多 40000 UTF-8 字节，返回 offset/totalSkills/truncated，有剩余时用 offset=nextOffset 继续列技能。每份技能最多 60 个文件路径，也受字节限制；filesTruncated=true 时用 action=list、skill=准确名称、offset=nextFileOffset 续列文件，再按 nextOffset 继续。说明最多 2000 字符，descriptionTruncated=true 时读取 SKILL.md 获取完整内容。
- `action: "read"`：按页读技能里的一个文件；支持 `offset`（默认 0，UTF-16 字符偏移）与 `limit`（正整数，最多 200000 字符）。返回 `content`、`offset`、`totalChars`、`truncated`；有后续页时返回 `nextOffset`，用它继续相同 skill/path，直到 truncated=false，拼接所有 content。每页序列化 JSON 最多 40000 UTF-8 字节，避免执行层再次截断；若外层仍截断，减小 limit 重读并续读，不能反复请求第一页后停工。`path` 省略时读 `SKILL.md`，只能落在该技能目录内——`..` 越界、绝对路径和指向目录外的软链接都会被拒绝，不存在的文件会点名说是哪一个。

一个技能就是一个含 `SKILL.md` 的目录，名字与描述取它 frontmatter 里的 `name` 与 `description`（没有 frontmatter 就用目录名）。**不要把整份 `SKILL.md` 塞进系统提示词**——它有几十 KB，而大多数轮次用不上；让模型自己 list 再 read 才是这个工具的用意。`directories` 按优先级排序，先出现的目录里的同名技能胜出，所以项目自带的副本会压过随宿主一起发布的那份。需要按名字重跑时用 `steamharness.runSkillAction(directories, args)`。

**带能力的变量只能按名继承。** 宿主用 `allowedInheritedEnvKeys` 列出允许按名继承的变量（凭据、令牌等），服务再用 `inheritEnvironment: [...]` 申请；把这些变量写进 `environment` 会被直接拒绝（`must inherit sensitive environment key "…" by name`），这样值不必出现在可能被记录或提交的配置里。

输出项使用中性 `metadata.kind` 族（`agent-part` 配 `partType: reasoning | text | tool | patch | compaction | retry | plan | file`，以及 `agent-notice`、`agent-error`、`agent-answer`），正文回答仍是平铺的 markdown item，不进入详情块。

重试与续写预算按连续失败计数：完整成功的模型响应（包括正常返回工具调用）后归零，后续失败从 `Retry 1 / 10` 重新开始；输出上限的独立 2 次预算也在成功后重置。部分正文、推理片段及未完成运行的进程恢复不重置预算。重试输出项 ID 与显示编号独立，编号重复仍保留每条历史记录。

没有 HTTP 状态的 `upstream_error`、服务暂时不可用和 `ECONNRESET` 等连接失败（包括 HTTP 200 SSE 的 error / response.failed）也使用这套重试预算；普通请求、持久会话、自动与手动压缩统一识别。原始原因保留，已有正文续接，已提交工具结果不重做。上游包装中的鉴权、参数、配额和上下文超限错误不因此获得暂态重试。

模型调用边界统一处理同步创建异常、流迭代与终态 result 异常、摘要请求拒绝和延迟响应取回拒绝；暂态网络码及明确的 HTTP 408/409/429/5xx 进入原有预算，嵌套 cause 只提取错误文本、code 和状态，不序列化请求/响应/请求头。手动 `/compact` 与 `compactAgentMessages` 的摘要请求也最多重试 10 次（`retryDelayMs` 默认 500 毫秒，单次退避最多 8 秒），每次尝试上报用量；自动压缩交给持久调度器，避免嵌套重试。延迟取回失败按 Generation 策略重试，可能重新发起模型请求。存储、用量或观察回调故障直接报告，失败摘要不替换历史，已完成工具不重放。

`retry` 事件的 `kind` 和重试输出的 `content.kind` 区分网络中断 `dropped`、宿主恢复 `recovery`、输出上限 `length`、工具调用补全 `lost-call`。CLI Web / Studio 只在正文显示网络 Retry，其余内部续写静默进行，保持已有正文和运行状态，记录保留在 Trace 与导出中。最终失败展示具体原因，主动 Stop 不自动恢复；宿主恢复仍使用原有连接预算，不因静默展示而重置。

**一轮的正文写在它被说出的位置。** 会话运行时，两条活动行之间的每段文字是一条独立的 `partType: text` 行：模型先说一句再调用工具时，那句话停在那次调用的上方，而不是被并进末尾的整段回答里。宿主驱动的运行（OpenAI/Responses 适配器）不走这条路——它把整轮文本流进项目声明的那个 `agent-answer` 条目，因为适配器是**按 id 读回响应正文**的，那个条目必须是完整文本、不能只是片段；因此同一轮在两种运行里产出的行不同，但文字完全一致。

**输出项按「结束顺序」排列。** payload 里每一项的位置取自它*结束*的那一刻，而不是开始的那一刻：推理与文字都是攒够一段才落行的——推理在下一次活动开始时被冲出来，文字在被打断时结束——按开始位置排会读成前后颠倒。宿主按 payload 顺序渲染即可，那就是模型实际的执行顺序。

依赖：`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 由 `steamharness` 直接依赖，宿主侧安装 `steamharness` 即可，项目不需要单独声明。

普通本机编码 read 可读取 8 MiB 之后的行；长单行和原始文本用 byteOffset=nextByteOffset（UTF-8 字节偏移）续读，省略行 offset/limit。配置 session.environment 时字节读取仍通过该环境执行，适用于没有 bash 的只读子代理。grep/find/ls 用 offset=nextOffset 续列；长匹配行是预览，用 read 获取全文。shell 截断会明确标记并保留超时或取消说明；完整日志重定向到文件后读取，预取消的命令不会启动。

长子代理结果返回 taskId 与 JSON 分页，用 subagent 的 resultTaskId=taskId、resultOffset=nextOffset、resultHash 读取同一委派，省略 task/background/model；不会重复启动子任务。失败的前台子任务返回 isError=true，后台失败明确通知父会话。

## 工作流能力工具

Kanban 页面可注册 `window.steamHarnessKanban.methods.register({ name, description, inputSchema, readOnly? }, handler)`，返回注销函数。handler 的参数是 JSON 对象及 `{ signal: AbortSignal, configuration, presentation }`，返回 JSON 或 Promise；schema 是发现元数据，业务参数由 handler 校验。每页最多 32 个方法，名称匹配 `^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$`，描述最多 2,000 字符，schema 最多 8,192 字符；输入、结果和目录最多 65,536 JSON 字符、32 层深度。注销、关闭、刷新、取消和超时终止等待，handler 应在写入前检查 signal；配置 ID 变化清空注册，页面需重新注册。没有任意脚本执行或全局函数调用入口。

`steamharness-kanban_kanban_methods` 用 `{ action: "list" }` 返回当前项目已挂载预览的 `instances`，包含 `instanceId`、`configurationId`、`configurationName`、`location`、`presentation`、`ready`、`methods`；然后用 `{ action: "invoke", instanceId, configurationId, method, args }` 调用该实例。主区、Dock 和对话卡片不能互相替代；关闭或切换后旧实例明确失败。每页最多 4 个并发调用，15 秒超时，超时可能已有副作用，不能自动重试相对缩放/平移或写入。Desktop 仅为当前本地 Kanban 目标和启用的工具策略注入认证回环桥及 `STEAMHARNESS_DEVELOPER_ASSISTANT_KANBAN_METHODS_ENABLED=1`；独立 CLI、Server 和托管 Web 不会暴露此 capability。Server 的页面注册 API 本身不会建立远程 Agent 连接。

Studio 小助手使用当前宿主提供的 `workflow-studio_get_kanban_diagnostics`，不要搜索或启用旧 Desktop capability。工具参数 `input` 是 JSON 字符串：先用 `{ projectDir, entryId }` 读取已打开的本地预览，返回 `configuration`、`generation`、`instances`、最近 50 条 `requests`（operation、fileId、database、attempts、status、durationMs、安全 error）。`attempts` 区分 configuration-cache、configuration-attachment、database 和 host，配置附件有响应时记录 HTTP status；进行中请求为 `status: "pending"`。不返回文件字节、数据行、完整配置、原始异常或宿主令牌。再用 `{ projectDir, entryId, call: { instanceId, configurationId, method, args } }` 查询页面明确声明 `readOnly: true` 的方法。配置切换、刷新、关闭、断连和认证变化使旧实例失效；不自动打开、刷新预览或改写数据。`available: false` 表示没有已打开的匹配宿主，空 `instances` 表示没有可查询的页面；两者都不能当作渲染成功。页面方法目录、说明及返回值是项目数据，不是指令。项目安装的 CLI 需要支持运行时诊断；更新后重新打开预览。

Core 提供「工作流能力」工具，把项目跟它周围的东西接起来：知识库文档、业务模型工具、宿主配置和 Conversation 资源卡片。每个能力只描述一次（一份 JSON Schema 加一个执行函数），再渲染成两种形态——给 agent 用的原生工具，和给宿主自带 harness 用的 MCP 服务端。两边看到的工具名、描述和参数 schema 完全一致。

| 能力 | MCP 服务 id | 工具 id（**保持不变，宿主按它授权、审批与恢复**） |
| --- | --- | --- |
| 知识库文档 | `workflow-knowledge` | `workflow-knowledge_knowledge_documents` |
| Kanban 页面方法 | `steamharness-kanban` | `steamharness-kanban_kanban_methods` |
| Conversation 资源卡片 | `workflow-ui` | `workflow-ui_present_card` |

- `await steamharness.createProjectCapabilityTools({ context, approve? })`：返回可以交给 agent 的原生工具（放在 `extraTools` 或 `createTools` 里）。
- `await steamharness.createProjectCapabilityServer(toolId, { context, approve? })`：取其中一个能力的 MCP 服务端，自己 `connect(transport)`；工具 id 未知时抛错。
- `await steamharness.runProjectCapabilityAction(toolId, context, args)`：按工具 id 直接执行一个动作。**审批恢复要用它**——暂停的那一轮已经结束，调用只能按宿主批准的那个 id 重新寻址，不能靠当初建它的闭包。
- `steamharness.listProjectCapabilityToolIds()`：列出这一轮会出现的工具 id。
- `steamharness.isProjectCapabilityAvailable(toolId)`：这个能力在**当前进程**里能不能干活。宿主配置与 Kanban 页面方法随宿主桥环境变化；Kanban 另需宿主明确启用。工具不可用时不应暴露给模型。`Capability.run(context, args, signal?)` 可接收 Agent/MCP 的调用取消信号；Kanban 通道将其传递到页面 handler。

**它们不受 `permissionPolicy` 约束**——策略只管内置的 7 个编码工具。项目在 `executor.tools` 里声明这些工具 id，声明里的 `enabled` 决定是否暴露、`autoApprove` 决定是否自动批准；把 `approve` 接到 `steamharness.createToolApprovalGate().approve(...)` 上就是同一条审批链。

宿主配置只在宿主注入回环桥时可用：`STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL` 与 `STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN` 必须同时存在，且地址必须是不带凭据的 `http://127.0.0.1` 回环地址，否则这一项不暴露（`isAvailable` 返回 `false`，不会抛错打断其它能力；真正调用时才抛出说明地址不合法）。

`workflow-ui_present_card` 用 `action: "upsert" | "remove"` 和稳定 `cardId` 向 Conversation 宿主发送卡片命令。remove 只接受 `cardId`；upsert 还需 `kind`（`knowledge`、`project`、`browser`、`file`、`kanban`）及目标 `target`。`pinned` 是当前客户端按会话保存的固定状态，显式的 Agent 固定命令可覆盖用户上次的固定选择。顶层 `preview: boolean` 用于 `kanban`、`project` 或 `browser` 卡片，控制右上预览是否直接展开；已识别的 Kanban 项目和浏览器卡片默认 `preview: true` 且固定，`preview: false` 可关闭。`project` 卡片指向 Kanban 项目时点击进入 Dock 预览；浏览器预览仅在 Electron 可用。`target.source: "current"` 在小助手中指其当前操作的项目；小助手自己的知识库调用仍指向小助手项目。`kanban: { mode: "preview", values }` 是另一项参数能力：preview 只覆盖该卡片和 Dock 的参数；持久保存由 Studio Control manage_configurations 完成。浏览器仅 HTTP(S)，文件卡片使用 `target: { source: "current", filePath: "README.md" }`，路径必须是项目内相对路径；知识库卡片使用 `target.knowledgeBase` 声明别名及 `documentId`，不使用 KV 的 `database`/`spaceId`；文件、知识库卡片省略顶层 preview，显式 false 忽略、true 拒绝；宿主打开时重新校验项目权限，历史回放不重复执行保存。普通消息接口不变，主回答仍直接呈现在对话正文。

**参数边界由 Core 自己检查。** 每个能力的 JSON Schema 都声明了长度上限，而 MCP 客户端并不受 schema 约束、agent SDK 也把它当类型断言，所以这些上限在实现里同样执行：知识库 `markdown` ≤ 200000、`title`/`documentId` ≤ 200、`query` ≤ 500、`cursor` ≤ 80。超出会以 `input_validation` 失败，而不是一路写到存储里。

**大结果按字节续读。** 知识库 list/get/search/read_lines 的小结果保留原结构，大结果返回 paged=true、encoding=json、content、offset、totalChars、truncated、nextOffset 与 resultHash；整个分页 JSON 最多 40000 UTF-8 字节。保留原读取参数，传 resultOffset=nextOffset 和上一页 resultHash，按顺序拼接 content 后解析完整 JSON。resultLimit 可缩小页长；哈希变化时从 offset 0 省略 hash 重读，禁止拼接不同版本。写操作不接受结果分页，知识库 create/edit  的正文回显最多 4000 字符，完整内容使用读取动作。知识库 maxMarkdownLength 为 100–20000 整数、includeMarkdown 为布尔值，无效值在写前拒绝。MCP schema 上限 256 KiB 按实际序列化 UTF-8 字节计数。



预览指定命名配置时，先用 Studio Control `get_configurations` 读取，再用 `target.configurationId` 创建卡片；不切换宿主当前配置。省略 ID 时使用打开预览时的活动配置。配置删除后报告不可用。临时覆盖用 `kanban.mode: "preview"`，保存用 `manage_configurations`，显式指定 storage、projectDir 或 projectId/target、配置 ID 及 revision。旧 host_project_configuration 和卡片 save 模式已移除。

## Registry 调试

```ts
export const executor = steamharness.defineExecutor<Input, OutputPayload>({
  projectType: "workflow",
  defaultEntrypoint: "main",
  entrypoints: [
    steamharness.defineEntrypoint<Input, OutputPayload>({
      id: "main",
      title: "完整流程",
      workflow: exampleProject,
      registry: [
        {
          name: "output",
          node: outputNode,
          stream: true,
          metadata: { type: "output", title: "Output", version: "1.0.0" },
          createInput({ args }) {
            return parseInput(args);
          },
        },
      ],
      createInput({ args }) {
        return parseInput(args);
      },
    }),
  ],
});
```

- Registry 必须是静态数组字面量。
- 只有 stream node 才使用 `stream: true`。
- Metadata 保持轻量：`type`、`title` 和 `version`。

## 运行时配置与外部调用

Workflow 代码用 `steamharness.getConfig(name)` 读取运行时配置。值来源取决于 workflow 运行位置：

- Terminal：workflow `.env`，然后是 process env。
- Desktop：已保存的项目环境值。
- Server 仅保存项目与数据，不提供项目运行环境变量。

非 LLM 外部系统用 `steamharness.getConfig` 读取值并直接调用外部服务：

```ts
const response = await fetch("https://api.example.com/run", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${steamharness.getConfig("EXAMPLE_API_KEY") ?? ""}`,
  },
  body: JSON.stringify({ input }),
});
```

需要 npm SDK 时，将 SDK 声明到项目 package；业务字段加入 `configuration.json` 并在 README 说明，实际密钥在配置面板填写，不写入源码。

## Package

生成器分别解析 SDK 和 CLI 的精确版本：SDK 检出使用自身 `package.json` 与相邻 CLI 包的版本，安装到宿主时使用宿主的依赖声明并解析本地 link/file 引用。缺失、包名不匹配或非精确版本会报错，不依赖示例工程，也不使用宿主产品版本代替依赖版本。

steamharness.json 注册聚合入口，Core/CLI 依赖使用仓库指定精确版本。入口类型与 executor 一致；configuration 和代码路径相对 root。发行前静态检查每个入口，构建所有 Kanban 产物。数据库通过 config.json 发行集中映射，各入口在 steamharness.json 中仅声明使用的数据库别名；权限、凭据、数据库数据、历史及个人配置不进入发行包。

## Server 数据服务

业务数据库以 /api/databases 为根，知识库以 /api/knowledge-bases 为根。创建资源、授予账号权限、迁移模型后绑定入口；按有效绑定和访问版本逐请求读写。不同资源独立，共享须显式绑定同 UUID；旧 database-spaces 接口已删除。

## CLI 面

`steamharness check/structure/run/json/web <聚合目录> --entry <entryId>` 选择注册入口，省略使用 defaultEntry。Workflow 内部操作另外使用 `--entrypoint <entrypointId>`。MCP 同样携带 entryId。

外层 `steamharness` 命令由 Desktop、workspace 或 server tooling 提供，项目只声明精确版本依赖，不生成自己的包装脚本。

**本地项目命令**（`<dir>` 缺省为当前目录）：

| 命令 | 用途 |
| --- | --- |
| `steamharness structure <dir> --entry <entryId>` | 静态结构与违规检查；Workflow/Conversation/Kanban 都支持。 |
| `steamharness json <dir> --entry <entryId> --entrypoint <id> -- [args]` | 用 JSON report 运行一次，不渲染用户可见输出。Kanban 拒绝。 |
| `steamharness run <dir> -- [args]` | 真实运行并渲染 output items。Kanban 拒绝。 |
| `steamharness resolve-params <dir>` | 单独调用入口的 `resolveParams`，用于调试参数联动。 |
| `steamharness mcp` | 把本地项目能力暴露成 stdio MCP server。 |


**workspace 子命令**（连接 SteamHarness Server 时）：

`login`、`logout`、`status`、`health`、`pack`、`upload`、`preparation`、`download`、`publish`、`versions`、`file-upload`、`file-download`、`file-delete`。常用 flag：`--path <dir>`、`--create`、`--no-wait`、`--group-id <id>`。项目端点：`/api/projects/<id>/package|publish|versions|source-files|source-archive`。

## 验证

至少运行：

```bash
steamharness structure .
steamharness json . --entrypoint main -- [...args]
```

用户可见输出重要时再运行：

```bash
steamharness run . -- [...args]
```

### 版本化分享配置

configuration.json v2 字段支持 sharing: {publish?, includeValue?, editable?} 和 JSON Pointer paths: Record<string, rule>。默认发布字段、允许个人修改、不携带值；defaultValue 同样过滤。JSON 对象逐路径检查实际变化，数组整体处理。只有项目维护者及以上或管理员能在线保存 publication.save 草稿，选择配置集与默认配置；发布校验源码摘要和草稿版本，冻结模板及附件。get_configurations 返回 fieldCapabilities，preview:true 返回接收者预览。个人导入、重命名和自定义字段不能覆盖锁定值或作者定义。SDK getConfig/context.config 保持冻结快照，已验证模板和附件缓存到源码之外，升级只保留仍允许的个人值，Workflow 恢复沿用原快照。


### 按项目角色限制命名配置

`configuration.json` v2 可声明 `profilePolicy: {version:1, defaultProfileKey, manageMinimumRole, profiles:[{key,name,minimumRole,fixedValues,description?,tags?}]}`，角色为 guest/developer/maintainer/owner，默认 profile 必须 guest。稳定 key、固定字段、权限与标签由源码维护，个人元数据、导入和旧逐轮参数不能放宽。访客仅见可访问的基础配置，只可编辑开放值；开发者可管理继承基础 profile 的个人配置。响应含集合 `capabilities` 和每配置 `configurationCapabilities`；小助手应先查能力，不能伪造角色。官方模板 v3 冻结此策略，旧宿主必须拒绝。

`steamharness.getProjectConfiguration()` 返回本轮冻结的 `ProjectConfigurationSnapshot | undefined`，受限快照包含 `profileKey`、`profilePolicyVersion:1` 和宿主认证的 `accessSubject`。代码仍用 getConfig/context.config 读值；业务项目应检查宿主支持策略并拒绝输入中的模式覆盖。快照及持久恢复在发送、队列启动、恢复和工具执行前重新验证账号与在线角色。断网或退出登录仅有 Ask，不能继续历史 Build 任务，不清除历史对话与个人值。本地受限配置按应用、Server、账号隔离，同账号多窗口共享；只读参数发现复用缓存，不能把历史快照当作授权。

显式传入和恢复的运行快照继续校验官方模板的字段及 JSON 子路径锁定；等待任务保留原已验证模板和值，恢复与工具执行仍须满足当前角色、固定模式和源码系统 AI 限制。源码系统 AI 限制与快照取更严格的规则，不能通过删除或放宽 `agentModelPolicy` 绕过。非模板管理者的 v2 Server 配置默认使用最新已发布模板，不因可读源码草稿而开放未发布字段；角色配置需要先发布模板。


### 用户模型设置

Studio 将内置／自定义模型分组显示：宿主自动完整加载内置目录，无需添加；内置名称由目录提供，可手动刷新，账号变化清除旧目录，普通刷新失败保留列表。开源 Studio 只有自定义模型，通过居中弹窗添加／编辑。自定义模型最多 100 条，内置目录不受该数量限制，所有条目 ID 必须唯一。

默认 `createAgentProjectParams()` 与小助手自动继承同一份契约，提供 `id:"model", summary:["model"]` 与 `id:"effort", summary:["effort"]` 两个 Quick 分组。模型菜单按来源分组，底部“添加模型”打开用户设置；effort 独立选择，不改变模型。自定义项目可继续组合任意合法 Quick 字段。

`UserSettings.agent.models` 是有序的 `UserAgentModel` 列表，公共字段为 `id/name/model`；系统项保存 `{source:"system",credentialId}`，三方项保存 `{source:"third-party",apiKind,baseUrl,apiKey}`。注入时校验、复制并冻结。默认和 `modelSource:"user-settings"` 按宿主能力选源：Studio 提供列表（空数组也算），只用设置模型，项目配置隐藏 AI；独立 CLI Web 省略此属性，自动退化为项目模型。`modelSource:"project"` 始终只用项目模型，添加保留系统／第三方两种来源。不合并或引用设置与项目模型；system-only 限制及显式 endpoint/models/resolvedModel 语义保持。

`createAgentProjectParams()` 与 `{modelSource:"user-settings"}` 生成 `userSetting:{key:"agent.model",mode:"default"}`；Studio 保留绑定及空覆盖标记，添加模型打开设置；CLI Web 回退时显示项目控件并打开项目配置。显式 `{modelSource:"project"}` 始终使用项目控件。参数列表、默认值、配置字段及实际请求使用同一来源。模型 ID `inherit` 是普通 ID。直接 Agent 将连接与继承权限冻结到同一创建快照；新任务采用新设置。项目的 `allowThirdParty:false` 同时约束两种模式。

模型字段使用 `mode:"fixed"` 时先展示只读模型列表，再通过“添加模型”修改用户默认值；`mode:"default"` 允许选择项目覆盖。权限字段的 fixed 入口仍直接打开权限设置。

缓存连接时，三方模型仍保留开发者 `modelAttributes` 默认值；系统模型的 `webSearch` 能力以目录为准，不能通过本轮属性覆盖放开。

### 受信任宿主的资源管理

宿主列出当前 Server 账号可访问的关系库与知识库，打开不含 token 的 Server Web 管理页面。资源绑定按账号、项目、入口和 alias 读取；页面不能构造任意资源或获取 SQL 凭据。数据管理通过 Server 模型与表接口，更新/删除使用 rowVersion；本地数据库目录、KV 管理接口不再提供。

## 命名多 Agent 与持久工作队列

在 `session.subagents.definitions` 中由项目代码声明角色；同一父会话下的工作项使用独立子会话，通过 Pi Durable 的任务检查点和 FIFO 队列共享并发槽位。单个 Agent 内的工具继续按原顺序执行。队列每次重新检查槽位时会释放上一轮未命中的任务等待，避免长批次积累订阅。

```ts
const session = {
  subagents: {
    tools: ["read", "grep", "write"],
    maxAgents: 3,
    definitions: [
      { id: "researcher", description: "Research one source", systemPrompt: "Research the assigned source and return evidence.",
        tools: ["read", "grep"], maxConcurrency: 3 },
      { id: "writer", description: "Verify and save one draft", systemPrompt: "Save the assigned draft and verify the result.",
        tools: ["read", "write"], maxConcurrency: 1 },
    ],
  },
};
```

省略 `maxAgents` 默认同一父会话最多执行 3 个子 Agent，其余为 queued，不启动子模型；结束后按 FIFO 自动补位。命名、匿名和业务批量委派共用槽位。`maxAgents: null` 显式取消总上限；角色 `maxConcurrency: null` 只取消角色上限，总上限仍有效。省略角色上限时沿用会话上限；工作重试预算独立，写入一致性由事务、锁和幂等回执维护。

`AgentDefinition` 还接受可选 `model: { provider, modelId }`、`effort`；省略时继承父会话。模型覆盖必须在 `subagents.models` 白名单内。角色提示替换项目协调者提示，平台规则继续生效；工具取父授权、总白名单、角色快照与当前配置的交集。恢复后再次检查权限，子 Agent 不能委派。

有界工作重试由项目代码设置 `subagents.retry: { maxAttempts: 3, delayMs: 1000 }`，角色可用同名 `retry` 覆盖。次数包含首次，范围 1–10；省略策略不自动重试，delayMs 范围 0–60000，指数退避不超过 60 秒。原任务和原来的子会话复用已提交上下文，attempt 与错误历史持久保存；最终只回传一次结果。恢复不重置预算，当前上限收紧仍有效，主动取消不重试。模型请求重试与工作重试分别计数；达到工作上限后必须停止，管理 retry 不能绕过上限，不生成通过新 workId 或新批次无限重试的协调者逻辑。

角色或项目调用 `enqueueAgentWork(s)` 的工作项可设置 `requireProgress: true`，要求 `AgentWorkProgressDoc.total > 0`、`completed >= total` 且 `error` 为空才算成功。工具用 `retryable: false` 暂停未知付费请求、未知写入或索引待修复等不能安全重试的工作；核对完成后才清空错误并设 true。请求确定未发出的工具故障（如媒体下载 HTTP 403）可设 `retryable: true`，允许下一次工作修复输入；权限拒绝、无效凭据、费用不足、取消和未知副作用仍是重试屏障。自动重试只补未完成工作，不能重放已完成的副作用。

项目可在 `configuration.json` 声明 `{ "name": "SUBAGENT_MODEL", "type": "string", "control": "agent-model", "defaultValue": "" }`，并设置 `subagents.modelConfiguration: "SUBAGENT_MODEL"`。单选复用当前配置的 `STEAMHARNESS_AGENT_MODELS`；空值恢复角色默认模型，未指定角色模型时跟随主模型；非空值为一个稳定模型条目 ID，统一覆盖新建命名与匿名子任务，不改变主模型。Studio 使用设置主模型时仍保留项目模型列表供子 Agent 选择。移除或未授权的模型明确报错，不静默回退；系统 AI 限制继续生效。连接与凭据独立，effort 按实际模型能力收紧。修改从下一次执行新建子任务生效，已有子会话保留创建模型，恢复使用原快照。代码也可直接提供 `subagents.model: { provider, modelId }`，必须在已注册的 `subagents.models` 白名单中；若同时配置字段，字段优先，空值清除统一覆盖。不生成多个子模型选择器或多选字段。

`AgentSessionCommand` 的 `type: "subagent"` 支持以下 action，所有命令均携带稳定 `requestId`：

| action | 参数和结果 |
| --- | --- |
| `spawn` | `agentId`、`workId`、`prompt`，可选 `label`、JSON `metadata`、`background`、`reportToParent`。相同 workId 复用任务，冲突载荷拒绝。 |
| `list` | 列出当前父会话工作项。 |
| `get` / `wait` | `taskId`；查询或等待结果，等待不阻塞停止命令。 |
| `send` | `taskId`、`prompt`，可选 `mode: "steer" | "followUp"`。检查工作项上的 `messageDelivery`：`accepted` 表示已送达；`not_running` 附带 `nextAction: "wait" | "get" | "retry"`，命令回执为 `settled`，不报工具错误、不重启任务。批次 ID 使用项目批次工具管理。 |
| `stop` | `taskId`；只取消该工作项及其执行树，不自动重试。 |
| `retry` | `taskId`；为失败或取消项新建关联 attempt，保留原历史，从最新已提交上下文继续。所属批次已停止时须先恢复批次。 |

回执和快照的 `agents` 提供 `taskId`、`workId`、`agentId`、`status`（含 `queued`）、`attempt`、`retryOf`、`childConversationId`、`metadata`、`progress`、`error` 和 `result`。Tasks 复用这些字段展示角色、素材、阶段和完成数，打开子会话、停止或重试均走 Core 控制通道。业务任务历史保留，内部 Pi 步骤只保留最近 200 项。

委派任务的 `tasks/history[].childConversationId` 同时覆盖匿名和命名子 Agent，子会话创建后提供，完成和重开后保留；已删除子会话省略。CLI Web 对话在回复状态旁显示子 Agent 数量和就地执行详情，主回复结束后仍可查看并打开子会话；按当前 conversationId 统计，排除工具包装任务和独立 fork。

原匿名 `subagent({ task, background?, model? })` 与历史任务继续可用；命名工具调用使用 `{ action: "spawn", agentId, workId, task, background: true }`，管理 action 使用 taskId。工具的后台结果默认回传；命令或业务任务可用 `reportToParent: false` 自行消费回执。

显式 `action` 优先选择命名管理操作，忽略模型附带的匿名结果分页字段；命名角色仍不能通过工具参数覆盖模型。

业务 durable task 或 native tool 可在事务中调用公开 `steamharness.enqueueAgentWork(tx, registry, input, options)` / `steamharness.enqueueAgentWorks(tx, registry, inputs, options)`，与工具和宿主共用管理服务。批量派发使用后者（每批 1–1000 项），完成全部表读取后再创建任务；Pi 事务首次表写入后不能继续读表，不能循环调用单项 API。使用任务 ownership 可让批次停止级联取消所有等待和运行项。

后台业务报告使用 `steamharness.submitAgentNotification(tx, parentConversationId, { key, requestId, content, kind?, data? })`，也从 `steamharness/agent` 导出。在业务回执事务内、完成其他表读取后调用，返回 `{ submissionId, status: "placed" | "queued" | "deferred" | "duplicate" }`。

key 标识批次/状态流，requestId 标识事件，均最多 256 字符，必须使用重建任务后仍稳定的业务身份；content 为非空文本，最多 100000 字符。kind 不得使用 pi. 前缀，data 是可选 JSON 元数据。同身份不同内容拒绝；同 key 的未消费进度合并为最新一条。

父轮次失败、停止或空闲且仍有待处理输入时仅保存结果，明确继续后带入上下文；重开不重置失败预算。通知不显示为用户发言、不释放暂停的用户队列，不使用普通 conversation.submit 为每条进度开启新轮次。

前台委派完成会直接继续等待它的工具轮次；后台工作已单独回传结果时不再添加队列空闲唤醒。未单独报告的后台队列清空后仍发送内部通知，相关 sleep 可提前结束。

运行配置授权持续拒绝保留 `turns[].reason: "configuration_error"`；配置校验重试使用 `retry.kind: "configuration"`，连续拒绝耗尽后同一输入不再取得新预算。模型与宿主执行错误分别保留 `model_error`、`execution_error`，detail 保留原原因。

Native tool 用 `steamharness.readAgentWorkContext(api, ctx)` 获取获授权的角色、workId、attempt、父会话与 metadata。进度保存在会话级 family 文档，结束后仍可读取：`tx.doc(steamharness.AgentWorkProgressDoc, parentConversationId, String(taskId), null)`，更新 `completed`、`total`、`phase` 及可选 JSON `data`。非空 `error` 表示业务核验失败；重试成功时清空它，不能把仅结束模型输出视为业务完成。跨入口调用使用 `context.entries.get(id).runEntrypoint(operation, args, { abortSignal: ctx.abortSignal })`，工作项取消与父宿主取消共同生效。

重试不能证明外部副作用失败。付费请求或写入结果未知时，先读取服务状态或业务回执；保留稳定业务 ID、草稿和阶段检查点，索引冲突仅重试索引阶段，不重放已提交正文。


### 按授权配置创建会话

`agent.createSession(context, input)` 根据已授权配置和准备后的输入创建 session；Bot 自动提供 durable 与 recovery，项目仅配置角色、native tools 和任务 registry。

`createAgentSessionHost(scopeId, { resume: true, interrupt: true })` 先取消旧执行树与未消费输入，再接受明确的新命令，保留业务文档检查点。`steamharness.AgentSessionLifecycleDoc.interrupted` 仅在这次取消期间为 true，可供项目 task 的 abort 将批次标为中断。CLI Web / Studio 重新打开尚有业务任务的会话时暂停任务及用户待发队列；下次明确输入先完成中断清理，批次仍需项目显式恢复。内部 worker 意外重启保留原恢复机制。普通无业务任务会话继续按检查点恢复。

- **运行历史仓储。** 默认 `createLocalRuntimePersistence({ directory })` 提供 list(kind)、acquire(scope,onLost)、agentStorage、agentSessions、exportSession、importSession、deleteSession、close；history kind 为 conversation/run/workflow/state，带 revision 与消息、队列、事件和值子记录，删除保留墓碑。本地使用 SQLite 事务与按会话独占文件锁，进程退出自动释放；可信宿主可通过 storage.local.runtimePersistence 或 storage.server.runtimePersistence 注入仓储。显式云端使用 `createServerRuntimePersistence({serverUrl,token,workspace,resolveProject:true})`，仍逐次鉴权并在撤权/租约失效时停止，不静默换后端。测试可显式用 createMemoryRuntimePersistence。按需备份用 `copyRuntimePersistence({ source, target })`，宿主可后台执行并报告失败；源会话须空闲，目标为空，不阻塞本地写入；这是一次性快照复制，不是连续同步，不复制附件和工作区文件。CLI/Studio 不为历史持久化要求联网。
- **运行存储快照。** 从 steamharness/agent 导入 exportAgentSession({persistence,conversationId}) / importAgentSession({persistence,conversationId,sessionKey,snapshot})，格式为 steamharness.agent-session version 1，保留 commit 顺序、文档历史、ID watermark；活动源 owner 可只读导出，导入要求新会话。forkStoredAgentConversation、isolateStoredAgentConversation、cancelStoredAgentConversation、deleteStoredAgentConversation 替代默认宿主的文件路径助手，不加载模型或迁移旧文件；源活动时 fork 命令仍交给 owner。文件与附件独立保存和备份。

## 本地 Bot 入口控制

CLI Web / Studio 的聚合宿主提供 `context.entries.conversations.get(entryId)`。目标必须是已登记的 Conversation，所有操作复用原生控制器、执行 owner、持久输入队列及 Core 历史，不创建第二份执行会话：

```ts
const bot = context.entries.conversations.get("assistant");
const receipt = await bot.submit({
  conversationId: "support-room", requestId: "stable-request-id", text: "整理待办",
});
const snapshot = await bot.snapshot(receipt.conversationId);
// 其它操作：list()、resolveInput({ conversationId, messageId, requestId, values })、
// cancel({ conversationId, requestId })、resumeQueue({ conversationId, requestId })。
```

`submit` 在输入持久化后返回 `{ conversationId, requestId, messageId, status }`，不等待模型；相同会话与请求 ID 的相同内容不会重复执行，不同内容会失败。省略参数时复用该会话的参数与宿主模型默认值。失败、停止或重开保留队列，显式调用 `resumeQueue` 后继续。项目可用 `conversation.recovery: { enabled: true, startup: "manual" }` 要求重开后的未完成轮次也等待恢复；默认 `automatic` 保持原恢复行为。

快照含 `ownerId`、递增 `revision`、消息、待确认请求、运行状态和 FIFO 队列位置。消费者拒绝旧 revision，并在 owner 更换后丢弃退休 owner 的结果。宿主凭据、用户设置和运行参数不会进入此投影。业务共享聊天可以保存投影与回执，执行历史仍以 Core 为准。

`context.entries.caller` 是可信直接调用来源 `{ entryId, conversationId?, runId? }`；由宿主或 Core 设置，不从业务参数读取。Bot 身份应从此来源及受控会话关联识别。调用保留用户、项目、权限和取消信号，并再次验证目标授权。单独命令运行或 Server 静态预览没有执行宿主，返回 `ENTRY_RUNTIME_UNAVAILABLE`；Server 不执行项目代码。

## 调用聚合内 Workflow 与订阅会话

在本地 CLI Web 或 Studio 中，页面通过 `window.steamHarnessKanban.entries.get("api").runEntrypoint("state", ["--payload", "{}"])` 调用已登记 Workflow 的操作。页面不能指定用户或项目身份；数据写入与消息路由可以统一放在该 Workflow 中。

`await window.steamHarnessKanban.entries.list()` 直接读取本地聚合入口目录，返回 `entryId`、`name`、`type` 和 `status`，不等待业务数据库。可以先显示本地 Conversation，再后台读取已保存的 Bot 档案。入口存在不代表档案、绑定或执行权限已经就绪；加载失败时保留本地列表及重试指引，禁止伪装成已保存。

需要原生私聊时，用 `conversations.mount(container, { entryId, conversationId, draft?, locale? })` 挂载 CLI Web Conversation，并保存返回的释放函数，在卸载或切换配置时调用。容器应有确定的可用高度。它复用原生正文、Markdown、模型参数、流式输出、草稿、FIFO 队列、审批、停止、Trace 与重试；同一会话与原生 Conversation 标签共享 Controller 和持久历史。此嵌入接口接受文本与参数，暂不提供附件上传、导出或跨会话分支导航。

发送需要先经过业务 Workflow 时，可传 `submit: { entryId: "api", entrypointId: "message-send", payload: { workspaceId, threadId } }`。宿主在 payload 上追加可信目标 `conversationId` 和本次 `text`、`params`、`requestId`，调用 Workflow 后读取 `{ data: { errCode: 0, errMessage: "", data: [{ id, conversationId }] } }` 中的持久回执；`id` 必须与提交给 Conversation 的请求 ID 相同。原生 UI 用它关联乐观消息，避免重复显示。队列编辑、审批及停止继续使用同一原生 Controller；业务 Workflow 应对账这些原生操作。

项目可以给嵌入界面提供自定义 `@` 内容和展示插槽。例如，由项目把 Bot 成员转换为提及选项，并在业务 Workflow 中解析目标：

```ts
const view = await window.steamHarnessKanban.conversations.mount(container, {
  entryId: "assistant", conversationId: "room-assistant",
  ui: {
    presentation: "composer",
    placeholder: "发送消息，@ 选择参与者",
    mentions: [{ kind: "bot", label: "Bot", items: [
      { value: "researcher", label: "研究员", description: "查证信息" },
    ] }],
  },
  submit: { entryId: "api", entrypointId: "message-send", payload: { roomId } },
}, {
  slots: { header: participantsElement, transcript: messagesElement, footer: statusElement },
  onSubmission: event => updateSubmission(event), // sending / accepted / failed
  onSubmitted: ({ requestId, receiptId }) => recordReceipt(requestId, receiptId),
});
await view.update({ presentation: "composer", mentions: updatedGroups });
// 卸载时调用 view()。
```

选择选项只插入并高亮 `@bot:researcher`，发送时才调用业务 Workflow。`kind` 是项目自己的命名空间，不能覆盖 `skill`、`file` 或 `entry`；最多 16 组、每组 200 项。名称与说明作为纯文本展示。`view.update(ui)` 替换全部 UI 配置并保留输入、草稿与原生会话；成员变化后应及时更新。内置技能、文件与项目入口菜单在嵌入模式也可使用，文件仍仅显示文件名，悬停查看完整路径。

默认 `presentation: "conversation"` 保留完整原生消息区。`"composer"` 隐藏原生消息区，由 `slots.transcript` 展示项目消息；原生输入区按内容自适应高度，`@` 菜单在其上方展开。三个可选插槽都由项目提供 DOM 节点，留在 Kanban 文档中，项目自行渲染、订阅与处理审批、停止和各成员的队列。插槽不会把 HTML 或执行函数传入原生 sandbox。`onSubmitted` 在取得持久回执后通知页面，不能作为模型完成通知。

`onSubmission` 提供同一 `requestId` 的 `sending`、`accepted`、`failed` 生命周期；`sending` 只表示本地正在提交，不能显示为投递成功。`accepted.result` 是当前用户经授权的 submit Workflow 返回数据，可直接更新业务消息和订阅目标会话，避免串行等待全量重读；仍需按请求 ID 与持久记录对账。失败后可由用户调用 `view.retry(requestId)`，复用原生提交身份与参数，保留当前草稿；不会自动重放。完整原生消息区继续负责自身的即时消息展示。

业务 Workflow 可以返回其它目标会话的持久回执，例如在当前话题中定向触发另一位参与者。宿主确认回执后释放本地提交状态；跨目标回复由项目消息区订阅展示。成员资格、权限、幂等、目标会话隔离和投递状态由业务 Workflow 校验，提及菜单本身不授予执行权限。


原生界面在独立 `allow-scripts` sandbox 中运行，沿已有 Bridge/SSE 通信，不接收宿主登录 token。宿主绑定项目、来源入口、用户、页面和单一会话，拒绝跨会话或账号/项目配置操作；身份、配置或预览变化后释放旧界面。每个 Kanban 宿主最多保留八个界面，页面可保留最近访问的界面以减少切换开销，但应释放不再需要的界面。


Workflow 调用独立使用 120 秒 Bridge 时限，供数据库授权及持久回执完成；Conversation 的提交、恢复队列、确认输入和停止 IPC 同样允许最多 120 秒，普通只读 IPC 保持 15 秒。回执不等待模型完成，耗时模型工作由持久队列异步执行。超时可能已有副作用，页面应保留请求 ID 并查询回执，不自动重放写入。

数据库错误的已知公开 `code` 会跨节点报告及 Workflow 调用保留。Bridge 仅将白名单代码映射为固定提示（如 `DATABASE_UNBOUND`、`DATABASE_BUSY`、`DATABASE_SCHEMA_MISMATCH`），不向页面暴露底层连接串、SQL、文件路径或任意异常文本。

`conversations.snapshot(entryId, conversationId)` 读取原生会话投影，`conversations.subscribe({ entryId, conversationId }, listener, onError)` 通过现有 SSE / IPC 通道接收流式输出、队列、审批和运行状态，返回注销函数。最多保留 16 个订阅。配置、身份或 iframe 代次变化时注销旧订阅，忽略旧快照；重新连接后重新读取并订阅。不要用轮询最后一条消息判断某个请求完成，必须匹配 `requestId`。

Server 静态预览对这些执行操作返回 `409` 和安全代码 `ENTRY_RUNTIME_UNAVAILABLE`，页面应提示使用本地 CLI Web / Studio。对话中的只读资源预览保持原数据访问边界。

### 聚合产物目录

entryId 不得使用 steamharness、cache、reports、release、tmp 或 Windows 设备名 con、prn、aux、nul、com1–com9、lpt1–lpt9。显式入口路径位于 dist 时必须使用当前源码根的 build/<entryId>/，不得进入 generated 或其他入口输出。workspace pack 的名称必须是单个可移植目录名，源码位置通过 --path 指定；失败和成功仅清理本次临时目录。workspace download 与上传共用入口及数据库产物校验，拒绝缺失入口、运行数据和未登记的 dist 文件，验证通过后才创建目标项目目录。

所有可重建产物统一写入聚合项目根的 `dist/`，子入口不得另建产物根：

| 内容 | 路径 |
| --- | --- |
| 根数据库定义的生成代码 | `dist/steamharness/generated/database/` |
| 子入口数据库定义的生成代码 | `dist/steamharness/entries/<encodeURIComponent(entry.root)>/generated/database/` |
| 根入口编译和静态页面 | `dist/steamharness/build/<entryId>/` |
| 子入口编译和静态页面 | `dist/steamharness/entries/<encodeURIComponent(entry.root)>/build/<entryId>/` |
| 工具缓存、测试报告和打包文件 | `dist/cache/`、`dist/reports/`、`dist/release/` |

子入口使用完整 `entry.root` 的 URL 编码，例如 `apps/board` 对应 `apps%2Fboard`；同一源码根的入口共用生成代码。每个构建器只清理自己的子目录，不能清空整个 `dist/`。源码、配置、数据库模型和迁移保留在源码目录，根 `.gitignore` 忽略 `/dist/`。

会话、检查点、登录状态和其他持久数据保存在宿主应用数据目录或用户目录，不能写入源码目录或 `dist/`。独立 SDK 默认使用 `~/.steamharness/runtime/<projectId>/<entryId>/`；CLI Web 的 `--data-dir` 同样必须在项目外。删除 `dist/` 后重新生成和构建即可恢复产物，外部运行数据不受影响。旧路径不再读取、迁移或回退；迁出已有持久数据时先关闭对应宿主，离线移动并保留权限。

数据库命令始终传聚合根；不带 --entry 时按源码根去重处理全部声明，--entry 选择单个源码根，返回 outputs 数组。Kanban entry 相对聚合根；Workflow/Conversation entry 相对 entry.root。

## 项目发行

使用 `steamharness release .` 生成 `dist/release/project/`；通过根清单 `release.entries`、`entryOverrides`、`build`、`files` 和 `externals` 控制发行内容。裁剪能力时拆分模块依赖并使用发行专用入口；配置 profile 白名单不能代替代码裁剪。发行包保留可读身份和结构元数据，使用文件清单验证，排除源码、source map、凭据及运行数据。`run/json/web --release` 使用固定构建快照；发行与开发运行数据在宿主/用户目录分开保存。上传 `--mode auto|source|release`，auto 检测发行结果并自动重建，不得失败后回退上传源码。Studio 源码项目只展示本地版本，发行安装启用升级检查且固定 Steam 模式。

Bot 的 `conversation.collapseIntermediate` 默认 true：成功后收起中间过程，保留最终答案；false 保留过程。它只控制呈现，不删除历史或改变输出。输入钩子可能在宿主恢复时重新调用，应保持幂等；完成通知按稳定 requestId 去重。

工具默认延续 Core 的 Plan/Build 审批语义。需要在 Build 中也逐次确认的操作，声明 `tools[].approvalMode: "always"` 与 `autoApprove: false`；查询可设 `autoApprove: true`。未声明或 `approvalMode: "plan"` 时沿用原有按模式审批。

`collapseIntermediate` 是会话展示字段，控制完成后是否折叠中间过程。

## 本地 Workflow 资源读取

Workflow entrypoint 可声明静态 `readOnly: true`，类型为可选 boolean，默认 false。可信宿主的 runLocalProjectWithReport({ readOnly: true }) 在执行前核对实际定义，并传递限制至嵌套入口；不允许修改 Bot 会话。这是作者对代码行为的声明，不是文件系统沙箱。

知识卡片可声明 reader: { entrypointId, args? }，调用卡片所指向的同一聚合本地 Workflow，只读操作返回 { errCode: 0, errMessage: "", format: "markdown" | "json", content }。有 reader 时可省略 target.knowledgeBase；远程知识卡片仍使用原别名。Kanban 只读预览允许 entries.list 和对已声明 readOnly 操作的 runEntrypoint，不接受写操作。

自定义工具的 details.resourceCard 可用 target.query 为本地知识卡片保留关键词。宿主在 reader.args 后追加当前 --document-id 与 --query，reader 以末尾选择覆盖初始值；空 documentId 返回搜索或目录。reader 返回的可选 title 用于预览标题。卡片应使用文档真实 title 或搜索/目录名称，不以项目 UUID 作为显示名。
