# steamharness API 参考

## 源码约定

workflow 源码是自包含业务代码。本地宿主和 CLI 把 runtime API 作为名为 `steamharness` 的全局命名空间注入；Server 只保存源码与数据。

不要在 workflow 源码中从 `"steamharness"` 导入 runtime API。Workflow、Conversation 和 Kanban 的 `package.json` 都必须在 `devDependencies` 中精确记录 `steamharness` 与 `@steamharness/cli` 版本；Core 用于宿主兼容判断，CLI 独立发版并提供外层 `steamharness` 命令。

## 版本兼容与宿主门禁

精确依赖与运行兼容是两个不同约束：

- 项目必须写完整的 `devDependencies.steamharness`，例如 `"0.2.7"` 或 `"0.2.7-20260826001"`。`^0.2.7`、`0.2.x`、`workspace:*`、`file:` 和其它 range 都是无效项目声明。`@steamharness/cli` 也必须精确，但独立版本化。
- Core 运行门禁只比较宿主与项目的 `major.minor`。`0.2.0`、`0.2.99`、`0.2.4-20260826001` 和 `0.2.4-beta.1` 都属于 `0.2.x`；宿主 patch 无论较新或较旧都可直接运行，不比较 patch、日期或预发布顺序。`0.1.x`、`0.2.x` 和 `1.2.x` 不兼容。
- patch 版本因此不得引入需要新兼容线的破坏性 Core API；此类 API 变化必须提升 minor。遇到 major/minor 不匹配时，保留项目精确声明并升级本地宿主或 CLI，不要把项目依赖改成 range 绕过门禁。
- Desktop `0.1.22` 是首个支持 Core `0.2.x` 与 `projectInfo.dataStorage.mode` 的版本。采用 Core `0.2.x` 的内置项目发布索引必须设置 `minDesktopVersion: "0.1.22"` 或更高；旧 Desktop 应在安装或执行前阻断。
- Desktop 精确绑定 Core/CLI，并在本地运行、恢复、参数解析和结构检查前校验项目 Core。CLI 同时校验实际 Core、CLI 自身的精确 Core 绑定和项目 Core，peer 只覆盖绑定 Core 的同一 minor。Server 只校验静态元数据，不加载或执行项目。
- 内置项目发布索引还必须声明精确 `components.core` 与 `components.cli`。Desktop 只选择最低 Desktop 版本已满足且两个组件分别处于宿主同 `major.minor` 兼容线的发布；下载包的精确 Core/CLI 依赖必须与索引逐字一致。

## 项目名称与展示声明

项目源码只在 `package.json` 声明展示信息。根 `name` 是必填默认名称，也是旧宿主的回退；中英文名称、手工声明和展示平台放在 `steamHarness.projectInfo`：

```json
{
  "name": "Default Name",
  "steamHarness": {
    "projectInfo": {
      "localizedNames": {
        "zh-CN": "中文名称",
        "en": "English Name"
      },
      "declarations": ["multilingual", "multiplatform"],
      "platformSupport": {
        "mode": "specific",
        "platforms": ["macos", "windows", "web"]
      }
    }
  }
}
```

名称显示优先使用当前界面 locale 的名称，再回退根 `name`；搜索覆盖默认名称及所有本地化名称。`declarations` 是不验证真实功能的手工展示标签，当前注册 `multilingual` 与 `multiplatform`。`platformSupport` 只描述展示平台：平台无关使用 `{ "mode": "agnostic" }`；`specific` 至少包含一个平台，当前注册 `macos`、`windows` 与 `web`。符合小写 ID 格式的未来语言、声明和平台值必须原样保留。

新 scaffold 必须创建 `projectInfo.dataStorage.mode` 并默认写 `both`，同时显式创建空的 `projectInfo.relatedProjects`；除此之外只写根 `name`，不根据文案语言、项目类型、依赖或产物推断 `localizedNames`、`declarations` 或 `platformSupport`。只有用户明确要求对应展示信息时才写入；`multilingual` 声明不能代替真实国际化实现。`platformSupport` 只是展示声明，不限制源码上传、下载或本地运行；下一节的 `steamHarness.release` 只声明关联项目的交付策略。

## 发行配置（steamHarness.release）

项目组交付读取项目里的关联项目配置，因此**每个可发布项目都必须在 `package.json` 写入 `steamHarness.release`**：

```json
{
  "steamHarness": {
    "release": {
      "dependencies": { "pricing": "included" }
    }
  }
}
```

- Server 只保存完整源码，不安装依赖、不构建或执行上传代码。所有平台均可下载源码；本地执行与显式服务器数据访问继续保留。
- `dependencies` 的键集合必须与 `projectInfo.relatedProjects` 的 alias 集合**双向完全一致**：每个已声明关系都要给出字符串值 `"included"` 或 `"external"`，多写一个未声明的 alias 同样报 `dependency-config`。例如 `"database": "external"` 有效，`"database": { "included": false, "external": true }` 无效。`dependency-config` 先检查值类型与 alias 声明，`dependency-state` 才检查关联项目的服务器状态。`included` 表示该关系随项目组联动交付并固化目标精确版本与 source hash，`external` 表示由用户自行安装。
- 这里是项目源码里必须显式声明的**发行意图**。发布阶段生成的版本级 dependency lock（`delivery`、`version`、`sourceHash`）仍然不得写入源码，两者不要混淆。
- 所有项目默认写 `{ "dependencies": {} }`。同时必须静态声明 `steamHarness.projectType`，其值与 Workflow/Conversation executor 的类型一致。

## 项目卡片（steamHarness.projectCard）

可选的项目卡片展示元数据，Desktop 首页、发布对话框和分享卡片读取：

```json
{
  "steamHarness": {
    "projectCard": {
      "icon": "bot",
      "iconColor": "#0f766e",
      "iconBackgroundColor": "#0f766e"
    }
  }
}
```

- `icon` 必须是注册的图标名：`workflow`、`message-circle`、`bot`、`sparkles`、`code`、`git-branch`、`boxes`、`zap`、`database`、`file-text`、`cpu`、`brain`。
- `iconUrl` 作为自定义图标，只接受 `http://` 或 `https://`；`iconColor` 与 `iconBackgroundColor` 必须是 `#RRGGBB`。缺失时宿主按项目类型取默认值。
- 旧键 `appCard` 仍会被兼容读取，但 `appCard.kind` / `projectCard.kind` 已移除并会校验失败——项目类型由 executor 的 `projectType` 或 `steamHarness.projectType: "kanban"` 决定，不要写 `kind`。
- 只有用户明确要求品牌化展示信息时才写入；不写时宿主使用项目类型默认图标。

## Workflow 定时建议

Workflow 可以在 package 中声明建议计划；Conversation 和 Kanban 声明该字段会被 Structure 拒绝：

```json
{
  "steamHarness": {
    "schedulePresets": [
      {
        "id": "business-hours",
        "title": "工作时段同步",
        "entrypointId": "sync",
        "timezone": "Asia/Shanghai",
        "trigger": {
          "kind": "window-interval",
          "weekdays": [1, 2, 3, 4, 5],
          "windows": [{ "start": "09:30", "end": "17:30" }],
          "intervalMinutes": 5
        },
        "paramValues": { "scope": "active" }
      }
    ]
  }
}
```

`id` 唯一且匹配 `[a-z][a-z0-9_-]{0,63}`，`entrypointId` 必须命中 executor 的静态入口。时区使用 IANA 名称；触发可使用不重叠且包含端点的 `window-interval`，或 `{ "kind": "cron", "expression": "五字段 Cron" }`。`paramValues` 必须是 JSON 对象并符合入口静态参数。

字段上限与格式：

- `schedulePresets` 最多 20 项；每项可带可选 `description`（≤500 字符）；`title` ≤100 字符。
- `window-interval` 每天最多 12 个窗口；`intervalMinutes` ≤1440；窗口必须互不重叠且包含端点。
- `weekdays` 取值 1–7，`1` 表示周一、`7` 表示周日，会自动去重排序。
- 每项只允许 `id`、`title`、`description`、`entrypointId`、`timezone`、`trigger`、`paramValues`；未知字段会直接报错，不要塞入自定义键。

Structure 将预设返回给宿主，但导入、打开或发布项目都不会自动创建计划；用户必须确认。计划不处理日期占位模板，动态日期由 Workflow 自行读取业务时区时间。

## Kanban 静态项目

Kanban 不使用 runtime API 或 executor，但上传和发布仍读取精确的 Core 版本声明。

Kanban 页面必须适配全屏工作区、手机、平板和 Conversation 对话卡片内的预览。Desktop 标题栏的尺寸切换默认填满预览区，其余模式默认使用手机 `390×844`、平板 `768×1024`、小卡片 `360×200`（CSS px），可拖动或输入宽高并恢复当前模式默认值；改变的是 iframe 的真实视口，不重载页面或修改业务配置。小卡片代表对话资源卡片中的 Kanban 内容，实际容器尺寸可变，也要适配约 `340–500px` 宽和 `180–200px` 高。声明 viewport meta，以页面自身容器宽高响应式重排，避免固定桌面最小尺寸和整页缩放。resize 不清空草稿或中断图片/文件请求，地图和 canvas 按容器重新测量。

`window.steamHarnessKanban.getPresentation()` 返回 `{ mode: "fullscreen" | "phone" | "tablet" | "card" }`，模式变化通过 `steamharness:kanban-presentation-change` 的 `CustomEvent.detail` 通知。Conversation 内实际预览固定使用 `card`，卡片调大后仍保持该语义；展示模式不进入命名配置或 KV。地图、图片类或明确要求只读的小卡片应只呈现主要内容，隐藏所有编辑界面并阻止修改快捷键、绘制和实体拖动；切回其它模式恢复原编辑状态。通过 Bridge 读取模式，用页面实际宽高测量布局，不要依赖父窗口 DOM 或自建消息协议。

最小目录继续使用项目根目录的 `index.html`：

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "name": "@steamharness/roadmap-kanban",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@steamharness/cli": "0.2.0",
    "steamharness": "0.2.0"
  },
  "steamHarness": {
    "projectType": "kanban",
    "projectInfo": {
      "dataStorage": {
        "mode": "both"
      },
      "relatedProjects": []
    }
  }
}
```

示例版本只说明精确 SemVer 格式。新模板会写入当前 Core 与 CLI 版本；已有项目缺失声明时必须补齐并同步 lockfile，不能使用 `^`、`~`、`workspace:*` 或其它 range。

需要消费 Vue、React、Vite 或其它工具生成的静态浏览器产物时，配置产物目录与其中的 HTML 入口：

```json
{
  "steamHarness": {
    "projectType": "kanban",
    "kanban": {
      "artifactDir": "dist",
      "entry": "index.html"
    },
    "projectInfo": {
      "dataStorage": { "mode": "both" },
      "relatedProjects": [{
        "alias": "catalog",
        "projectId": "11111111-1111-4111-8111-111111111111",
        "grantToRelatedProject": {
          "read": { "mode": "all" },
          "write": { "mode": "none" }
        }
      }]
    }
  }
}
```

`artifactDir` 默认 `"."`，相对项目根；`entry` 默认 `"index.html"`，相对 `artifactDir`。两者禁止绝对路径、盘符、UNC、`..`、符号链接和版本控制/依赖目录，入口必须是 `.html` 或 `.htm`。跨项目访问统一声明在 `projectInfo.relatedProjects`，旧 `kanban.dataSources` 存在即校验失败。SteamHarness Desktop/Server 只消费构建产物，不自动安装依赖、不执行构建脚本，也不接入 dev server、端口或 HMR。

`relatedProjects[]` 只接受 `alias`、`projectId` 和 `grantToRelatedProject`。其中 grant 的方向是“允许目标项目访问当前项目”，不是当前项目向目标请求权限；项目 A 访问 B 时，真正生效的是 B 反向指向 A 的关系项。旧 `access: { read: "all", write: "none" }` 不受支持，也不能机械重命名；必须先从调用代码和项目文档确认访问意图，再按当前 grant 方向写到正确一侧，而且新规则必须写成 `read/write: { mode: "none" | "all" | "prefixes" }`。修复只获得 A 根目录时，可以先把 A 的声明迁移为合法最小授权，但必须把 B 的反向声明和跨项目 KV 验证保留为未完成。

项目开发工具修改 Vue、React、Vite 等框架源码后，需要更新预览产物。小助手应读取项目已有的非 watch `build` 脚本，按 `packageManager` 或现有 lockfile 选择包管理器并执行一次 `<manager> run build`，随后确认 `<artifactDir>/<entry>` 存在并运行 `steamharness structure`。依赖缺失时按 `SKILL.md` 的「依赖安装与环境」节处理：项目根可写、包管理器可用且安装确属本任务必需时直接装一次，优先与现有 lockfile 对齐的不可变模式，只补缺、不改依赖图、不编造构建脚本，lockfile 有变化要说明。不要启动 `dev`、`watch`、`serve` 或其它长期任务；构建无法执行或失败时必须说明入口仍是旧产物，不能把源码修改等同于预览已经更新。直接编辑产物目录内静态文件时不需要构建。

上传只读取项目根目录 `.steamharnessignore`，不读取任何 `.gitignore`。缺失或空规则会上传全部普通文件；规则支持目录、glob、`**` 和 `!`。`.steamharnessignore` 自身始终保留，`package.json`、项目入口和已有 `configuration.json` 不能被排除。Kanban 的规则不得忽略实际产物目录；是否把 `dist` 提交 Git 与是否上传是两件独立的事。

`.steamharnessignore` 必须是普通文件（符号链接会被拒绝）且内容为 UTF-8。必备上传路径必须真实存在：Workflow/Conversation 是 `package.json` 与 `index.ts`，Kanban 是 `package.json`、`artifactDir/entry` 和已存在的 `configuration.json`；上传清单里出现的路径也必须是普通文件或目录，符号链接同样会被拒绝。

仓库提供的标准 scaffold 会在最小入口之外生成 `.steamharnessignore`、`board-state.js`、`board-storage.js`、`README.md` 和 `tests/*.test.mjs`，用于页面内任务操作、KV 持久化和离线逻辑验证。所有 scaffold 均生成 `configuration.json`，无字段时 fields 为空。

需要宿主参数时增加 `configuration.json`：

```json
{
  "version": 1,
  "fields": [
    { "name": "title", "type": "string", "defaultValue": "产品路线图" },
    { "name": "accent", "type": "string", "control": "radio", "options": [
      { "value": "#2563eb", "label": "蓝色" }
    ] }
  ]
}
```

`fields` 使用独立的 ProjectConfigurationField，支持 string、number、boolean、枚举、多选、JSON 和 file。默认值使用原生类型，敏感字段用 secret 标记。宿主通过统一项目配置服务保存命名配置。文件配置声明 `type: "file"`，可用 `accept: ["image/png", ".json"]` 限制类型；面板直接选择文件并上传到当前 Server，保存值为服务器文件引用（单文件对象，`multiple: true` 为引用数组），不填写文件 JSON、base64 或本机路径，单文件最大 50 MiB。上传失败保留原值，清除配置不删除文件；导出包含完整引用，不包含文件内容。页面内文件 API 也可独立上传。页面读取和监听：

参数用于同一 HTML 页面在不同命名配置下切换标题、主题、过滤条件或显示模式。任务、卡片、记录等业务数据应由页面本身提供新建、编辑和删除操作，并通过 KV Bridge 持久化；不要把业务列表做成逗号分隔的 textarea 参数。

```js
function render(configuration) {
  const { title = "看板" } = configuration?.params ?? {};
  document.querySelector("h1").textContent = title;
}

render(window.steamHarnessKanban?.getConfiguration());
window.addEventListener("steamharness:kanban-configuration-change", (event) => {
  render(event.detail);
});
```

页面还可以访问固定到当前项目的异步数据 Bridge：

```ts
interface SteamHarnessKanbanApi {
  getConfiguration(): { id: string; name: string; params: Record<string, unknown> };
  getPresentation(): { mode: "fullscreen" | "phone" | "tablet" | "card" };
  getRuntimeLocale(): Promise<"zh-CN" | "en">;
  files: {
    createFile(input: { name: string; mimeType?: string; buffer: Blob | ArrayBuffer | Uint8Array }): Promise<FileReference>;
    readFile(fileId: string): Promise<{ file: FileReference; buffer: ArrayBuffer }>;
    deleteFile(fileId: string): Promise<boolean>;
  };
  kv: {
    getValue(key: string): Promise<unknown | undefined>;
    setValue(key: string, value: JsonValue): Promise<void>;
  };
  relatedProjects: {
    get(alias: string): {
      kv: {
        getValue(key: string): Promise<unknown | undefined>;
        setValue(key: string, value: JsonValue): Promise<void>;
        subscribe(listener: (event: { alias: string; revision: string }) => void): () => void;
      };
    };
  };
  knowledge: {
    listDocuments(options?: { pageSize?: number; cursor?: string }): Promise<KnowledgeDocumentPage>;
    getDocument(id: string): Promise<KnowledgeDocument | null>;
    createDocument(input: { id?: string; title: string; markdown: string }): Promise<KnowledgeDocument>;
    editDocument(id: string, input: { title?: string; markdown?: string }): Promise<KnowledgeDocument>;
    deleteDocument(id: string): Promise<{ id: string; deleted: boolean }>;
    searchDocuments(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>;
    readDocumentLines(id: string, options: { startLine: number; endLine: number }): Promise<KnowledgeDocumentLinesResult>;
  };
}
```

`getRuntimeLocale()` 返回宿主当前界面语言，已明确要求国际化的 Kanban 页面必须用它选择文案，不要自行猜测 `navigator.language`。

当前项目 KV 只有 project scope 的 get/set。value 必须是 JSON 原生值且不能为 `undefined`；页面不能传项目、scope、projectName、数据库路径或 target。建议以 `<feature>.v1:${configuration.id || "default"}` 保存版本化且按配置隔离的数据。配置切换时使用请求代次避免旧读取覆盖新配置；写入使用串行防抖队列，并按 storage key 保留失败值与重试入口，切换配置时不能清空其它 key 的失败记录。

跨项目通过 `relatedProjects.get(alias).kv` 读写。宿主只接受 package 中已声明的 alias，并按目标项目对当前项目的 `grantToRelatedProject` 检查 key；请求不能携带目标 UUID、scope、target 或数据库路径。本地 Desktop 要求目标项目已经导入；Server Web 看板预览 要求访问者可读当前 Kanban，双方关系已确认后无需访问者成为目标项目成员。每次调用读取双方当前声明，撤销立即生效；待确认、缺失或越权统一返回安全的关联项目不可用错误。

`steamHarness.projectInfo.relatedProjects` 是发布和下载时的唯一项目依赖目录，不要生成 `dependencies`、`steamHarness.dependencies` 或 Kanban 专用字段。发布阶段仅为双方确认且选择 included 的关系生成版本级 dependency lock；included 固化目标项目精确版本与 source hash，external 和单边待确认关系不联动下载。项目源码本身只声明关系，不写 `delivery`、`version` 或 `sourceHash`。

project-group v1 只交付项目源码。归档、上传、发布和下载不得包含 KV、知识库、定时计划、运行历史、`.env*`、SQLite 或宿主用户配置。Desktop 本地 KV 与 Server KV 永久隔离，联动上传不会把本地行情或其它业务数据带到 Server，联动下载也不会把 Server KV 带到本地。数据初始化与跨宿主同步由项目开发者通过 本地 Workflow entrypoint、显式服务器存储连接或业务接口显式实现；Kanban 页面只能执行关联项目明确授予的 KV 操作，不能自行创建同步 run。

`relatedProjects.get(alias).kv.subscribe(listener)` 在宿主取得当前 revision 后异步回调一次快照，并继续推送该 alias 的变化。revision 是不透明字符串，不包含项目、KV key 或数据库信息；页面应防抖重读当前数据并在刷新失败时保留最后一次成功内容。配置切换或卸载时调用返回的取消函数。自动联动只发生在同一 Desktop 本地后端或同一 Server 后端，不能把它当作 Desktop 与 Server 之间的数据同步。

Bridge 缺失时回退为明确的只读或内存状态；调用失败只依赖安全 error `code` / `message`，不要解析宿主内部错误。非 JSON 或不可克隆输入统一以 `KANBAN_BRIDGE_INVALID_REQUEST` 拒绝。

Bridge 同时最多保留 16 个请求，普通调用 15 秒超时，文件调用 120 秒超时。知识库列表 `pageSize` 上限 100，搜索 `pageSize` / `maxMatches` 上限 1000、前后上下文各 50 行，单次读取最多 1000 行。Server 看板预览的 Bridge 和配置 CRUD 固定页面首次加载的 `resolvedTarget`，版本变化后必须刷新页面。所有资源必须使用 `artifactDir` 内相对路径，并在 `sandbox="allow-scripts"`、离线 CSP、无 Node/preload 环境中工作；ES module、动态 import、WASM 和 `fetch()` 只能读取绑定项目、用户与固定版本且由宿主自动续期的短期 capability 下的同源产物，不能访问公网，也不要缓存或解析 capability URL。Kanban 支持 `steamharness structure`，不支持 `run`、`json`、Webhook 或 external run。

文件 Bridge 与 KV 存储位置独立，始终使用当前服务器的 managed file storage；Desktop 未登录或目标 UUID 未创建于当前服务器时失败，不回退本地。`FileReference` 沿用 `FileReference` 的安全字段（`id/name/mimeType/size/kind/storage/projectId/createdAt/url`），`storage` 为 `server`。`createFile` 接受不超过 50 MiB 的 Blob、ArrayBuffer 或 Uint8Array；`readFile(id)` 返回原始字节及文件元数据，只接受当前项目且没有 conversation 作用域的文件，不能传 URL 或本地路径。图片可用 `URL.createObjectURL(new Blob([buffer], { type: file.mimeType }))` 显示，切换配置或卸载时释放。KV 保存文件引用与标注；不要把二进制数据分块存入 KV。替换图片时先上传和核验新文件，保存新引用成功后才能 `deleteFile` 旧文件。

本地图片迁移使用 `steamharness workspace file-upload <项目 UUID> --file <路径> [--mime-type image/png]`，返回标准 `{ errCode: 0, errMessage: "", data: FileReference }`。通过 `steamharness workspace file-download <文件 ID> --output <新文件>` 读回比较字节或 SHA-256，已有文件不会覆盖；`file-delete <文件 ID>` 删除已明确不再使用的文件。三个命令使用 Desktop 注入的服务器身份或 CLI 登录态，不上传源码、不发布版本。CLI 过旧时要更新可用宿主或明确报告未验证，不改用图片 KV 分块兜底。

```ts
const outputNode = steamharness.createOutputNode<Input, OutputPayload>({
  name: "output",
  async *stream(input) {
    yield input.message;
  },
  format(stream) {
    return steamharness.createOutputPayload({
      items: stream.items,
    });
  },
});
```

标准折叠输出项使用 `steamharness.createDetailsOutputNode(...)`：

```ts
const detailsNode = steamharness.createDetailsOutputNode({
  name: "output",
  title: "点击展开",
  icon: "info",
  content: "这里是折叠内容。",
});
```

当 workflow 必须暂停等待人工回答并在稍后恢复同一个 run 时，使用 `steamharness.createUserInputNode(...)`：

```ts
interface ApprovalPayload extends RunPayload {
  requestId: string;
  values: Record<string, unknown>;
  submittedAt: string;
}

const approvalNode = steamharness.createUserInputNode<Plan, ApprovalPayload>({
  name: "approval",
  title: "Review plan",
  description: "Confirm the deployment target before continuing.",
  params: [
    { name: "approved", flag: "--approved", type: "boolean" },
    { name: "note", flag: "--note", type: "string", control: "textarea" },
    { name: "reviewDate", flag: "--review-date", type: "string", control: "date" },
  ],
  defaultValues: { approved: false, reviewDate: "2026-07-26" },
});
```

等待节点的 `params` 使用普通 `ParamDefinition` 字段，不使用 executor 的 Auxiliary/Quick/Mode 分组；字段的取值、控件和校验规则一致，不需要第二套表单 schema。当 runtime 没有该节点的已解析答案时，run report 会进入 `waiting_for_input` 并包含 `pendingUserInput`。当 本地宿主或 CLI Web 提交答案后，同一个 `runId` 会带着 `resolvedUserInputs` 恢复；除非自定义 `format` 映射到其它 `RunPayload`，节点会返回 `{ errCode: 0, errMessage: "", requestId, values, submittedAt }`。

外部 agent 或当前节点输入需要动态决定问题字段时，可以另外提供 `resolveRequest(input, context)`，返回本次请求的 `title`、`description`、`params` 和 `defaultValues`。仍应在节点 options 中保留静态 `params`（没有固定字段时可为空数组）供结构分析使用；resolver 必须无副作用且对相同输入保持确定性，恢复同一个 requestId 时字段名和 option value 不能变化。

当 workflow 有自定义工具调用需要启用/自动批准/人工审批时，在对应 entrypoint（Conversation 则为 executor）的 `tools` 静态数组中注册工具，并用 `steamharness.createToolApprovalGate()` 包装工具函数。不要为工具审批发明新的暂停协议；它会复用 user-input 等待/恢复机制。

```ts
const toolApproval = steamharness.createToolApprovalGate();

// wrap() 返回的是 (context, ...args) => Promise<Result>：
// 调用时必须把 NodeContext 显式作为第一个实参传入。
const wrappedSearch = toolApproval.wrap(
  "search",
  async (query: string) => callSearchApi(query),
  {
    label: "Search",
    description: "调用搜索服务。",
    arguments: (query) => ({ query }),
  },
);

const results = await wrappedSearch(context, "workflow project");

// 需要自己判断审批结果时用 approve()：
const decision = await toolApproval.approve(
  { name: "search", label: "Search", arguments: { query } },
  context,
);
if (!decision.approved) {
  // decision.requestId / decision.values 可用于展示本次审批记录。
}
```

未注册工具以 `input_validation` 失败，禁用工具以 `tool_permission_denied` 拒绝；需要审批时生成 `nodeName: "tool-approval"` 请求。requestId 包含 workflow、runId、toolName 及 callId、规范化参数和权限定义的 SHA256，防止旧决定批准不同调用；`approved` 布尔字段用于批准或拒绝。只有 plan 模式 Agent 对未自动批准工具提问，build 回合直接执行，普通 Workflow 仍按 autoApprove 询问。宿主传入的 enabled/autoApprove 策略须在恢复时继续传入，只对已注册工具生效。

运行时配置使用 `steamharness.getConfig(name)`：

```ts
const apiKey = steamharness.getConfig("EXAMPLE_API_KEY");
```

只有 workflow 行为必须按执行宿主分支时，才使用运行平台 helper：

```ts
const platform = steamharness.getRuntimePlatform();
const runsInDesktop = steamharness.isDesktop();
```

`steamharness.getRuntimePlatform()` 返回项目实际运行宿主。本地终端与 CLI Web 使用 `cli`，本地桌面宿主使用 `desktop`；非空未知标记直接抛 `TypeError`。Server 仅提供项目和数据存储，不是执行宿主。

当用户明确要求项目支持中文和英文时，使用运行时语言 helper，而不是自行猜测浏览器或机器语言：

```ts
const locale = steamharness.getRuntimeLocale(); // "zh-CN" | "en"
const title = locale === "en" ? "Market data" : "股票行情";
```

`steamharness.getRuntimeLocale()` 返回当前本地宿主选择的语言；宿主未注入语言时默认 `"zh-CN"`。国际化项目必须同时覆盖用户可见输出、错误以及日期和数字格式，并保留 `"zh-CN"` 回退。静态的 package、entrypoint 和参数清单不能在运行时读取该方法，继续使用项目默认语言。

所有类型使用 `configuration.json` 声明字段，用项目配置面板管理实际值。SDK 的 `getConfig(key)` 与 `context.config` 读取冻结的 ProjectConfigurationSnapshot；不加载项目 env 或回退到 process.env。Workflow 恢复沿用旧快照，Conversation 下一轮使用新值，持久 Agent 在任务边界重载，Kanban 保存立即更新。Studio 与独立 CLI 共用按真实路径隔离的本地存储；Server 按项目和账号隔离，导入导出搬运字段和全部值，包括敏感值。

执行接口的显式 `configuration` 也按 `runId` 持久冻结，恢复可省略快照。宿主在持久会话任务边界更新配置且保留 runId 时，使用新的 `configurationRunId`，恢复这一代时继续传入该身份；`createLocalProjectConfigurationStore(...).snapshot({runId,configuration})` 遵循相同的首次保存规则。读取只匹配自身键，不把对象原型成员当配置。切换声明或 Server 版本保留暂时不生效的值和被声明隐藏的自定义定义；运行和导出只包含当前有效字段，显式删除自定义字段仍清除值。

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

用户可见答案默认使用流式输出，尤其是 LLM、agent、API workflow，否则用户必须等待完整 run 结束。使用 `steamharness.createOutputNode({ async *stream, format })`，并用 `steamharness.runStreamNode(...)` 执行；非流式 `steamharness.runNode(...)` 只保留给小型内部转换或瞬时输出。可见文本流完后，finalizer 仍可写入 KV、conversation message 和 token usage。

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
- `steamharness.getRuntimeLocale()` 返回 `"zh-CN"` 或 `"en"`，用于已明确要求国际化的 Workflow 或 Conversation 项目按宿主语言生成用户可见输出；未注入时回退 `"zh-CN"`。
- `steamharness.createUserInputNode(...)` 创建可持久化的人工输入暂停。它的表单 `params` 应遵循所选 entrypoint（Conversation 则为 executor）的 params，且每个返回 payload 必须包含 `errCode` 和 `errMessage`。
- `steamharness.createToolApprovalGate()` 创建工具审批包装器。它依赖所选 entrypoint（Conversation 则为 executor）的 `tools` 注册工具元数据，并复用 user-input 机制暂停和恢复；未自动批准的工具只在 plan 模式的 agent 回合停下来问，build 回合直接执行。
- 静态结构 report 会在 `definitions.apiCalls` 中列出识别到的 `steamharness.*` 调用。执行序列只记录 `run()` 内由 `steamharness.runNode`、`steamharness.runStreamNode`、`steamharness.runIf`、`steamharness.runFor` 或 `steamharness.runWhile` node hooks 支撑的调用。
- `context.storage.local` 与 `context.storage.server` 分别表示本地和服务器位置；每个位置都包含 `kv`、`persistentValue` 与 `relatedProjects`。项目的 `steamHarness.projectInfo.dataStorage.mode` 必须声明为 `local`、`server` 或 `both`，禁止的位置会直接抛错，不回退、不复制也不删除另一端数据。
- `context.storage.*.kv` 直接读写当前 UUID 项目的 project KV，`.conversation` 读写当前会话 KV；不存在 global 或 `.workflow` 作用域。服务器位置要求登录并绑定与 `package.json.id` 相同 UUID 的云端项目；`both` 项目只有真正访问 `context.storage.server` 时才要求登录。
- `context.storage.*.kv.*.deleteValue(key)` 删除单条 KV 并返回布尔值：`true` 表示确实删除了已存在的条目，`false` 表示该键本来就不存在。删除是永久的、不可恢复，且未删到的键不是错误，因此可以用返回值区分“删掉了”和“本来就没有”。KV 值不允许是 `undefined`，所以 `setValue(key, undefined)` 永远不是删除，也不会把存储的 `null` 当成缺失。
- `context.storage.*.relatedProjects.get(alias).kv` 访问直接关联项目。调用方用自己的 alias 找目标，权限读取目标项目对调用方的 `grantToRelatedProject`；`getValue` 检查 read，`setValue` 与 `deleteValue` 检查 write，`updateValue` 同时检查两者。关系必须双方声明且每次调用重新解析，不能递归进入目标关系，也不能跨 local/server 回退。
- `context.storage.*.kv.*.updateValue(key, updater)` 在内置本地和 server KV 后端上原子更新 JSON 值；`context.storage.*.persistentValue.*.updateValue` 使用远程服务器时会通过服务端 compare-and-set 重试，所以 updater 必须保持纯函数并可能执行多次。自定义 store 未实现 `updateValue` 时才会回退到 read-modify-write。不要在 workflow 中依赖 store 内部的 namespace read lock；知识库 helper 会在本地大范围搜索时自行复用它。
- `KVStore` 可选实现 `withNamespaceLock(input, operation)` 来串行化同一 project 或 conversation namespace 的多 key 操作。远程 store 无法把回调锁跨 HTTP 持有时，可选实现 `executeNamespaceMutation(input, mutation)`；内置知识库仅使用它传递受限的 create、edit、delete 服务端 mutation，不要把任意回调或代码发送到 server。
- 每个位置的 `persistentValue` 是独立于同位置普通 `kv` 的持久值通道，顶层是当前 project，另有 `.conversation`，并提供 `getValue`、`setValue`、`deleteValue` 和 `updateValue`。本地 CLI/Desktop 需要显式配置本地 PersistentValue store；服务器位置使用登录态和同 UUID 项目绑定。
- `context.files.createFile({ name, mimeType, buffer, kind })` 把 workflow 生成的文件写入 server-backed runtime file storage。
- Server PostgreSQL 项目存储写入会自动记录最后写入来源（`projectId`、`runId`、`conversationId`），供 server/web 项目 KV 查看器使用。
- 项目知识库 helper 封装所选位置顶层的 `persistentValue`，第一个参数必须显式传 `context.storage.local` 或 `context.storage.server`：`steamharness.listKnowledgeDocuments`、`steamharness.getKnowledgeDocument`、`steamharness.createKnowledgeDocument`、`steamharness.editKnowledgeDocument`、`steamharness.deleteKnowledgeDocument`、`steamharness.searchKnowledgeDocuments` 和 `steamharness.readKnowledgeDocumentLines`。
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

## 运行时 KV 与 Conversation 状态

```ts
const count = Number(await context.storage.local.kv.getValue("run.count") ?? 0);
await context.storage.local.kv.setValue("run.count", count + 1);
```

KV 值必须可 JSON 序列化，不能是 `undefined`。项目必须在 `package.json` 声明存储位置：

```json
{
  "steamHarness": {
    "projectInfo": {
      "dataStorage": {
        "mode": "local"
      }
    }
  }
}
```

`local` 只允许本地存储并可离线运行；`server` 只允许服务器存储，要求登录且云端项目 UUID 与顶层 `id` 一致；`both` 允许代码逐次选择位置。禁止的位置访问直接失败，两端数据不会自动同步。显式服务器存储访问把 KV 持久化到 PostgreSQL，并可记录本地执行的 project、run 和 conversation 来源标识。

只应把需要独立于普通运行态 KV 保存的值写入所选位置的 `persistentValue`，例如本地项目知识库：

```ts
await context.storage.local.persistentValue.setValue("knowledge.doc", {
  markdown: "# Notes",
});
```

每个位置只保留 project 与 conversation 两种 scope：顶层 `persistentValue` 直接表示当前项目；声明 `executor.projectType: "conversation"` 时，`.conversation` 表示当前会话。KV 使用相同模型，且 KV 与 PersistentValue 始终位于不同存储域。

每个位置都提供 `kv`、`persistentValue` 和 `relatedProjects`，且都暴露 `getValue`、`setValue`、`updateValue`。namespace 级的串行化 helper 按后端能力区分：本地 namespace 提供 `withLock(name, operation)` 与 `withReadLock(name, operation)`，远程/server 后端只提供 `withLock`，`executeMutation` 仅在 store 显式实现时可用。`relatedProjects.get(alias).kv` 提供 `getValue`、`setValue`、`updateValue`、`deleteValue`（删除按写权限判定），没有 lock helper，也不能枚举 key——需要跨项目原子更新时，把整个读改写放进 `updateValue`。

**关联项目不止 KV。** 同一个 `get(alias)` 还提供：

- `knowledge`：目标项目的知识库，就是本文这套知识库 helper 绑在对方项目上——`listDocuments` / `getDocument` / `createDocument` / `editDocument` / `deleteDocument` / `searchDocuments` / `readDocumentLines`。
- `listEntrypoints()`：目标项目授权给本项目的入口（`{ id, title?, description? }[]`），只列出授权覆盖的那些。
- `runEntrypoint(entrypointId, args)`：执行其中一个，`args` 就是该入口自己的 `createInput` 解析的那套命令行参数；返回该入口的输出 payload。

三项都由**目标项目**在 `grantToRelatedProject` 里授权：`knowledge: { read, write }` 与 `entrypoints`（`none` / `all` / `prefixes`，按入口 id 匹配），不写就是不授权。知识库按 key 判定权限，所以前缀授权可以只开放指定文档；列名录与搜索要动所有文档共用的索引，会以该 key 被拒绝。目标项目的其它持久值与会话 KV 一律不开放，列表里没有的入口也调不到；关联关系只走一跳，被调起来的项目自己不能再访问关联项目。当前完整成员列表见 `references/runtime-api-index.md`（生成物）。

本地宿主打开目标项目的存储，并从目标目录执行获授权的关联入口；选择服务器位置时只远程读写数据，入口仍在本地执行。服务器数据请求仍校验调用方成员权限和双方项目授权。宿主给不了时抛 `RELATED_PROJECT_UNAVAILABLE`（`metadata.code`），授权不足时抛 `RELATED_PROJECT_KNOWLEDGE_ACCESS_DENIED` 或 `RELATED_PROJECT_ENTRYPOINT_ACCESS_DENIED`。

**本地存储根目录是调用方与版本共有的资源。** 本地运行从环境变量取目录：KV 用 `STEAMHARNESS_KV_STORE_DIR`（未配置时默认 `os.tmpdir()/steamharness-kv`），PersistentValue 用 `STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR`，文件用 `STEAMHARNESS_FILE_STORE_DIR`。这些变量随进程继承，宿主（Desktop、上层 agent、父 CLI）调度出的进程因此默认使用**宿主自己的**根目录——在别人配置的环境里跑另一个项目，会把该项目的运行态数据写进宿主的存储，或反过来读到别人写的数据。跑本地检查前，把这三个变量指向该项目的临时目录。

根目录的布局与条目字段随版本演进：早期版本的作用域是 `global` / `workflow` / `conversation`，条目里写工作流名 `projectName`；当前版本只有 project / conversation，条目里写 `projectId`，并在根目录写 `.workflow-storage-format.json` 标记（当前 `{ version: 2, storageKind }`）。两种后果都必须避免：

- 旧版本在同一个根目录里读到当前版本写下的条目会抛 `project_execution`：`Local workflow KV entry is invalid and cannot be read safely.`。旧版本每次写入都会枚举整个根目录，所以只要目录里存在一个它不认识的条目，写入就会失败——和当前项目自己的代码无关。
- 当前版本遇到没有标记或标记不符的根目录，会把它当作待重建的旧根目录：删除 `.inspection`、`.locks`、`.transactions`、`conversation`、`global`、`project` 后写入新标记；如果标记里的 `storageKind` 与本次用途不同（KV 目录被当 PersistentValue 目录使用，或反之），直接抛 `input_validation`。

不要把不同项目的运行指向同一个根目录，也不要靠删除目录排查这类错误：先确认失败进程真正拿到的路径（`env | grep -E 'STEAMHARNESS_.*STORE'`）和实际安装的 Core/CLI 版本，再判断是不是项目代码的问题。

不要把 `persistentValue` 用于短生命周期 cache 或草稿状态。CLI/Desktop 本地运行可通过 `STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR` 选择独立的本地目录；服务器位置使用 `STEAMHARNESS_SERVER_URL` / 登录态和项目 UUID。没有对应位置的 store 时，`getValue`、`setValue`、`updateValue`、`withLock` 都会抛错，绝不会转写到另一位置。Core 0.2 已移除 `context.kv` 与 `context.persistentValue` 类型和运行时属性，不提供迁移 getter。

跨项目 KV 的两个失败码会出现在错误的 `metadata.code` 里：关系未确认、目标不可用或未导入时抛 `input_validation` 并带 `RELATED_PROJECT_UNAVAILABLE`；双方关系存在但当前 key 超出授权范围时带 `RELATED_PROJECT_KV_ACCESS_DENIED`。调用方应按这两个 code 区分"该提示用户去 Desktop 重新识别/确认关系"和"该提示用户调整 `grantToRelatedProject` 的 read/write 规则"。

Server Web 的项目 KV 检查器只读取 `storage_kind = kv` 的 project/conversation 数据，不展示 PersistentValue，也不存在全局 KV 入口。

## 项目知识文档

当 workflow 需要通过 PersistentValue 管理项目级 Markdown 文档时，使用知识文档 helper：


```ts
const storage = context.storage.local;
const created = await steamharness.createKnowledgeDocument(storage, {
  title: "Runbook",
  markdown: "# Runbook\n\nUse this on-call note.",
});

const result = await steamharness.searchKnowledgeDocuments(storage, {
  query: "on-call",
  documentId: created.id,
  beforeLines: 1,
  afterLines: 1,
  pageSize: 200,
});

const excerpt = await steamharness.readKnowledgeDocumentLines(storage, {
  documentId: created.id,
  startLine: 10,
  endLine: 30,
});
```

这些 helper 只写入所传位置顶层的 `persistentValue`。选择 `context.storage.local` 使用本地知识库，选择 `context.storage.server` 使用同 UUID 云端知识库；项目声明必须允许该位置，两类数据不会自动同步。不要手动使用保留 key `knowledge.documents`、`knowledge.documents.page.<pageId>`、`knowledge.documents.locator.<id>` 或 `knowledge.document.<id>`，除非任务就是调试内置知识库实现；摘要分页的 cursor 是不透明 token，只能原样回传。

conversation knowledge 应用要保持映射稳定：一个 `context.conversation.conversationId` 派生一个合法知识文档 id；每次 run 通过 `context.conversation` 追加消息；workflow 通过 `steamharness.createKnowledgeDocument` 或 `steamharness.editKnowledgeDocument` 重写完整 transcript markdown。需要离线本地测试时，为 `STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR` 配置临时目录；只有未配置本地或远程 store 的示例才应暴露显式 `--dry-run`。

可用 helper：

- `steamharness.listKnowledgeDocuments(storage)` 返回按更新时间倒序排列的摘要。
- `steamharness.getKnowledgeDocument(storage, documentId)` 返回完整 Markdown 文档或 `undefined`。
- `steamharness.createKnowledgeDocument(storage, { id?, title, markdown })` 创建文档；`id` 可选，省略时从标题派生。
- `steamharness.editKnowledgeDocument(storage, { id, title?, markdown? })` 更新标题和或 Markdown。
- `steamharness.deleteKnowledgeDocument(storage, documentId)` 从索引移除文档并写 tombstone，因为 PersistentValue 目前没有 delete primitive；文档不存在时返回 `{ id, deleted: false }` 而不是抛错，调用方应按 `deleted` 判断结果。
- `steamharness.searchKnowledgeDocuments(storage, { query, documentId?, beforeLines?, afterLines?, pageSize?, cursor?, maxMatches? })` 按行搜索 Markdown，并返回 `lineNumber`、匹配行和请求的上下文行。`pageSize` 与 `maxMatches` 上限为 1000，`beforeLines` 与 `afterLines` 取值 0–50；`cursor` 是不透明 offset，只能原样回传。
- `steamharness.readKnowledgeDocumentLines(storage, { documentId, startLine, endLine })` 返回单个文档的 1-based 闭区间行范围，每次最多 1000 行，超过上限抛 `input_validation`。
- `createKnowledgeDocument` 的 `id` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，重复 id 抛 `input_validation`；`editKnowledgeDocument` 对不存在的 id 抛 `input_validation`。
- create、edit、delete 需要原子写入：目标 `persistentValue` namespace 必须提供 `withLock`，或 store 实现了受限的 `executeMutation`；两者都没有时 helper 直接抛 `project_execution`（提示 "Knowledge document mutations require an atomic PersistentValue namespace lock or mutation executor"）。自建 store 时不要省略这两个能力之一，否则知识库 workflow 会在运行期失败。

Token usage collection 存在 KV 中：

- project `tokenUsage.total` 表示当前项目总用量。
- conversation `tokenUsage.total` 表示 conversation 聚合用量。
- conversation `tokenUsage.entry.<runId>.<sequence>` 表示单个 report 明细。
- 系统总用量由宿主聚合各项目的 `tokenUsage.total`，不写入全局 KV。

`tokenUsage.enabled` 为 false 或省略时，`context.tokenUsage.report(...)` 是安全 no-op，生成的 workflow 不应添加自己的 fallback storage。启用后，runtime report 包含 `tokenUsage.run`；只有 `display` 为 true 时，本地宿主或 CLI Web 才显示 compact badge。手动上报字段包括 `inputTokens`、`outputTokens`、`totalTokens`、`reasoningTokens`、`cachedInputTokens` 和 `cacheCreationTokens`；本地宿主 badge 可见文本只显示总量，hover/focus 明细分别展示 Input、Output、Reasoning、Cache read、Cache write 和 Calls。

需要在自己的逻辑里读取本次 run 的用量时用 `context.tokenUsage.getRunUsage()`，它返回本 run 的聚合值（含调用次数），未启用或没有调用时返回空聚合；不要在 workflow 内自行累计 KV。

Conversation workflow 在 executor 上启用 conversation state：

```ts
export const executor = steamharness.defineExecutor<Input, OutputPayload>({
  projectType: "conversation",
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

Conversation 项目可选接入本地宿主提供的 OpenAI Responses 网关（本地宿主和 CLI Web 在用户选择 OpenAI 兼容模型时注入）：

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

`context.conversation.getValue()` 替代旧的 `getState()` API。Conversation state 由本次执行宿主允许的位置 KV 支撑：本地运行根据显式存储位置持久化到本地 KV 或服务器数据库。

`context.conversation.setTitle(title)` 是可选 UI hint。它会规范化空白、存储 `state.title`，并为 本地宿主或 CLI Web 发出 `conversation_title_updated` runtime event。传入空白标题会清空存储标题。conversation mode 禁用时，`setTitle` 是安全 no-op，不应中断 workflow。

本地 CLI 检查可传入稳定 conversation id：

```bash
STEAMHARNESS_KV_STORE_DIR=/tmp/steamharness-kv \
  steamharness json . --conversation-id demo -- --message hello
```

## 参数

Workflow 的 `params` 必须是 `steamharness.defineEntrypoint({ ... })` 内的静态数组字面量；Conversation 的 `params` 继续位于 `steamharness.defineExecutor({ ... })`。静态结构分析不执行代码。

Workflow 的数组条目是 `ParamDeclaration`，普通主字段可直接声明。Conversation 的数组条目是 `ConversationParamDeclaration`，只允许 Auxiliary、Quick、Mode 和 Slash；标准主输入框始终展示，不声明普通主字段或保留的 `--message`、`--images`、`--videos`、`--files`。Auxiliary 和 Quick 声明 `{ kind, id, label, fields }`，Quick 还要有 `summary`；Conversation 的单击轮换模式直接声明 `{ kind: "mode", name, flag, options }`，Slash 声明 `{ kind: "slash", name, flag, type, options? }` 并出现在 `/` 菜单中。可重复声明多个入口，工具栏按数组顺序从左到右展示。组内字段是普通参数，不能再设置 `panel` 或嵌套分组。所有字段的 `name`、flag 和 Auxiliary/Quick 的 `id` 必须各自唯一。结构报告把字段展平到 `params`，用 `paramLayout.actions` 记录入口归属和顺序；`createInput({ paramValues })` 仍按字段名读取值。

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

- `ConversationDefinition` 的 `recovery` 使用内联 `{ enabled: true }` 声明可跨进程恢复。只为持久 Agent 等可恢复项目启用；CLI Web / Studio 保存原 runId、args 和已解析答案，worker 意外退出最多自动恢复 3 次，再用现有 Retry 继续原运行。关闭宿主保留检查点，显式停止先保存取消意图、停 worker，再调用 `steamharness/agent` 的 `cancelAgentConversation({ agentStoreDir, conversationId })`，重开不能复活。
- `ConversationDefinition` 的 `durable` 字段使用内联 `{ enabled: true }`，并在 Agent 选项设置 `session: { ... }`，启用持久输入队列、steer、后台任务及 Studio Trace 任务视图。Harness 是队列与历史的唯一权威，不能另建宿主队列调度同一 Agent。CLI Web / Studio 通过稳定 requestId 的双向命令和快照确认提交；多客户端各自选择会话，共享同一个执行 owner。常驻 owner 调度由本地 CLI / Studio 宿主负责。
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
- 需要互斥或联动时，在对应 entrypoint（Conversation 则为 executor）中定义无写入副作用、幂等的 `resolveParams({ draftText, paramValues, trigger, abortSignal })`，返回参数的 `value`、`visible`、`disabled`、`resolvedOptions` 和 option 状态补丁。初始化以及 main、Advanced、Quick 的 Form 参数变化都会触发。互斥字段隐藏时同时返回 `{ visible: false, value: null }`；单独返回 `visible: false` 会保留旧值并继续生成 args。Raw 模式初始化补丁只更新对应已声明参数，其它 Raw 参数保持不变。`resolvedOptions` 数组替换静态选项，`null` 恢复静态选项；替换时旧 option 状态会清除。只有联动依赖主输入文本时，才为相关参数设置 `resolveOnInput: true`。可以调用支持 `AbortSignal` 的只读目录 API，不得写 KV、文件或其它外部状态。
- File params 可以声明 `multiple`、`accept` 和 `format: "json"`，让 本地宿主和 CLI Web 在 run 前保存附件，并把 opaque references 传给 workflow。
- `defaultValue` 是字符串，必要时在 `createInput` 中转换。
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

节点接收来自 file param 的 file references，并通过 `context.files.resolveFile(ref)` 解析单个引用。已解析文件暴露 `readBuffer()`、`readBase64()`、`readDataUrl()`、`toLLMImagePart()` 和 `toJSON()`；对非图片调用 `toLLMImagePart()` 会抛 `input_validation`。KV 或 conversation history 中只存 `toJSON()` 元数据，不要持久化 base64 文件内容。引用本身既可以是托管 file reference JSON、引用数组，也可以是本地绝对路径字符串（本地运行时按扩展名推断 mime）；URL 型存储位置不能在本地读取，路径在未配置 rootDir 时会抛 `input_validation`。

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
- `steamharness.runStreamNode` 运行流式节点并返回 `{ chunks, output }`。
- 流式 `createOutputNode` formatter 接收 `{ text, items, chunks }`。
- 字符串 chunk 会自动追加到默认 inline Markdown `Output` item，适合 LLM/AI/agent 正文和普通文本。结构化 chunk 使用 `steamharness.createOutputItemChunk(...)`，支持 `output_item_start`、`output_item_delta` 和 `output_item_end`，适合工具调用和辅助 detail。
- `steamharness.runIf` 运行显式分支节点。第一个命中的 `condition` 生效；没有任何分支命中且未声明 `else` 时抛 `node_execution`，所以要么覆盖全部情况，要么显式声明 `else`。
- `steamharness.runFor` 和 `steamharness.runWhile` 运行显式循环节点。迭代次数达到 `maxIterations` 时抛 `node_execution`；`maxIterations` 为 `undefined`、非有限数或 ≤ 0 时会静默回落到默认值（`runFor` 1000、`runWhile` 100），不会报错，所以不要用非法值表达"不限制"。
- `steamharness.runProject` 在当前 `RunContext` 内调用另一个 imported workflow，嵌套深度最多 16 层，超过后抛 `project_execution`；可传 `{ name?, metadata?, conversationMode?, kvMode?, outputVisibility?, emitNode?, maxDepth?, onOutputChunk?, onOutput? }`，`maxDepth` 用于收紧而不是放开默认上限。
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
    kvMode: "isolated",
    outputVisibility: "hidden",
  },
);
```

Executor entrypoint 只提供一层扁平的独立启动目录，不表示父子执行关系。用户直接运行任一 entrypoint 时只创建该入口的 run，不会先运行默认入口；多级业务编排继续通过 `steamharness.runProject(...)` 显式表达，不要把层级编码到 entrypoint ID。

`conversationMode` 始终默认 `shared`，即使提供了 options object。除非父 workflow 显式使用 `shared-readonly`，否则子 workflow 可以写父 conversation；`shared-readonly` 会让该次调用中的 `appendMessage`、`setValue` 和 `setTitle` 成为 no-op。除非父 workflow 显式传入 `outputVisibility: "hidden"`，否则子输出仍可见。父 workflow 想避免重复 transcript 时，应由父 workflow 追加 user 或 assistant message、设置标题，并发出或转发最终 output item。使用 `kvMode: "isolated"` 避免子 workflow 特有 history KV 污染。

桥接型 workflow 优先保留子 workflow 输出，不要在父 workflow 中重建子文本或 tool items。可在父 output node 中使用以下模式：

```ts
async *stream(input, context) {
  // createAsyncQueue is a local helper, not a built-in workflow API. Implement
  // it in the workflow or replace it with an existing async iterable queue.
  const queue = createAsyncQueue<RunOutputStreamChunk>();
  const childRun = steamharness.runProject(childProject, input.childInput, context, {
    conversationMode: "shared-readonly",
    kvMode: "isolated",
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

Core 内置一层基于 pi agent SDK 的 agent 能力，覆盖输入、输出、思考强度、上下文压缩和 plan 审批，等价于内置 OpenCode 项目的能力。**生成 agent 类项目时优先直接使用这三个成员，不要自己实现工具循环、审批、压缩或 output item 拼装。**

四种用法，按需要选择：

- `steamharness.createAgentConversationProject({ ... })` 配合项目内联 `steamharness.defineExecutor({ ... })`：生成完整的 Agent Conversation 工作流，让 Core 负责输入/输出节点与 agent 执行，项目只保留静态声明。**新建需要通过 structure 的 Agent 项目首选此组合**；可直接读取 `assets/examples/agent-conversation/index.ts`。
- `steamharness.defineAgentConversationExecutor({ ... })`：一步构造完整 executor，适合不经过项目结构检查的宿主嵌入或测试。
- `steamharness.createAgentNode({ ... })`：只取一个 agent 节点，放进自己的 workflow 用 `runNode` / `runStreamNode` 执行。需要自定义前后节点时使用。
- `steamharness.createAgent({ ... })`：直接拿到一个可编程驱动的 agent 运行时（`async function* run(input, host?)`），不经过 workflow 节点体系；适合脚本化调用。

**项目形态与嵌入形态不同。** 结构报告（Desktop 的参数面板、工具权限、conversation 选项、token usage）由 Core 对 `index.ts` 做**静态 AST 分析**得出：`params` 必须是内联数组、元素是内联对象字面量，`tools`、`conversation`、`tokenUsage` 也必须是内联字面量。一个「工厂返回整个 executor」的写法会让这四项全部读不到，Desktop 里既没有参数也没有工具（工具为空还会让工具审批直接失败，因为审批门要读 `executor.tools`）。

因此：

- **要过结构校验的项目**（例如内置项目）用下面这组，把声明写在项目里、逻辑留在 Core：

完整、经过类型与结构检查的项目 `index.ts` 见 `assets/examples/agent-conversation/index.ts`。先创建 Conversation scaffold，再以这个示例替换其入口，并按项目需求调整声明。`steamharness` 变量名要保持不变，运行时由宿主注入；只允许从 `steamharness` 导入类型。

  `steamharness.createAgentConversationProject(...)` 返回整个 workflow（输入节点、agent 节点、输出节点与 conversation 落库），`steamharness.createAgentProjectInput(args)` 从 executor 的 `createInput({ args })` 调用。`steamharness.createAgentProjectParams(...)` 返回 Core 的完整默认参数表；项目按需选择字段并保持内联字面量，沿用默认表的字段时可在测试中比对，防止漂移。

  `resolveParams: steamharness.createAgentProjectParamResolver()` 从项目配置的 `STEAMHARNESS_AGENT_MODELS` JSON 列表生成模型选项，并隐藏兼容的 provider 参数。保留 provider/model 的 `control: "select"`、`options: []` 声明；model 的值是列表条目 ID，缺省使用第一项。项目配置第一项提供系统 AI／第三方 AI 切换及统一模型列表的增删改查：系统条目含 `id/name/model/source: "system"/credentialId`，第三方条目含 `id/name/model/source: "third-party"/apiKind/baseUrl/apiKey`。Core 静态识别 Agent 工厂调用并补入 `control: "ai-models"` 字段；间接封装可显式声明。系统运行严格校验当前账号的订阅和模型，每轮建立并关闭回环代理；第三方直接使用配置连接，不请求系统 AI。不要把 Key 写入源码、参数或日志。模型值按运行快照冻结，分享默认只发布结构，完整备份包含值。调用方显式提供端点或注入 `models`/`resolvedModel` 时保留独立调用语义。

- **完成后的过程展示。** `conversation.collapseIntermediate: true | false` 是静态可读取的显示默认值；`defineAgentConversationExecutor({ collapseIntermediate })` 默认 `true`。Core Agent 标准输出在未声明默认值时也默认收起成功回合的中间文字、思考和工具过程，保留最终回复、计划和资源卡片；普通 Conversation 默认关闭。CLI Web / Studio 提供项目级开关和每轮“已运行 …”展开入口，运行中、失败、停止或待输入时不自动隐藏。不要通过删减输出或历史实现折叠。

- **不需要过结构校验的调用方**（宿主嵌入、测试）可以直接用 `steamharness.defineAgentConversationExecutor(...)` 一次拿到完整 executor；它内部复用同一个 workflow 实现。

```ts
// 宿主嵌入或测试：一次构造 executor，不作为项目的静态声明
const executor = steamharness.defineAgentConversationExecutor({
  executorName: "Pi",
  projectName: "pi",
  outputItemId: "pi-answer",
});

// 已有 workflow 需要自定义前后处理时只取 Agent 节点
const agentNode = steamharness.createAgentNode({ name: "agent", provider: "anthropic" });
const result = await steamharness.runStreamNode(agentNode, input, context);
```

输入字段（`AgentInput`）：`prompt`、`images`、`workdir`、`allowedDirectories`、`systemPrompt`、`provider`、`model`、`baseUrl`、`apiKind`、`modelAttributes`、`webSearch`、`effort`、`agent`、`permissionPolicy`、`contextWindow`、`compact`、`hostInput`、`requestId`、`planResume`、`askResume`。

**回答 item 的 id 就是 `outputItemId`。** `createAgentConversationProject({ outputItemId })` 产出的正文 item 使用这个 id 原样（不做前缀、不改写），因此它必须与 `conversation.openai.outputItemId` 是同一个值：OpenAI / Responses 适配器是在 `report.outputs[].output.items` 里**按 id 查找**这段正文的，两个值不一致时运行会在适配器一侧以「did not produce output item」失败（本地网关与 CLI 的 `__openai-responses-runner` 都走这条查找）。不传时才会退化成按会话派生的 id，那种 id 适配器无法预先知道。

- `workdir` 与 `allowedDirectories` 合起来决定本轮内置工具能碰哪些路径（相对 `allowedDirectories` 按本轮的 `workdir` 解析，省略时就是 `[workdir]`）。**两者都是逐轮生效的**，所以宿主把外部文件夹挂进工作区时，按这一轮实际的工作区传进来，而不是在建运行时写死。
- `systemPrompt` 是本轮的系统提示词，逐轮生效并覆盖 `AgentProjectOptions.systemPrompt`。plan 模式下 plan 提示词仍在前，这段内容追加在后，所以 plan 的只读约束不能靠它改掉。
- `images` 取 `{ data, mimeType }`（`data` 为 base64），会随 prompt 一起真正发给模型。
- `effort` 取 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（也接受 `ultra`，等同 `max`）；超出模型支持范围时自动收敛到该模型支持的档位。**空字符串表示「交给模型决定」**，pi 用「不指定任何档位」来表达它——也就是 `off`：OpenAI 类端点因此收不到 `reasoningEffort`，与内置 OpenCode 项目的「Model default」一致；对 Anthropic 这一类则会把 `thinking` 显式关掉，想保留推理就挑一个具体档位。完全不传（`undefined`）才表示「没有选择」，本轮沿用运行时/项目自己的档位，无法识别的档位名同样回落到它。
- `agent` 取 `"build"`（默认，直接执行）或 `"plan"`（只调研并给出计划）。plan 模式结束后运行会暂停，通过 `user_input_required` 请求批准；批准后按同一 `requestId` 恢复执行。
  plan 模式下这一轮的正文**就是计划**，因此它只渲染成一条 `Plan` 行，不会再出现在主回答正文里（两处都渲染会让同一段文字显示两遍）；plan 轮的 conversation 消息取这条 Plan 行的内容。
  plan 轮的批准请求与内置 OpenCode 项目一致：一个 `decision` 单选（按计划执行 / 先不执行，各自带说明）加一个 `instructions` 文本框（补充要求，可选）。批准后会暂停并在**同一会话**里以 build 模式带着计划原文继续执行——计划会随恢复提示一起重发，中途发生压缩也不会丢。**拒绝不会结束会话**：它保持 plan 模式，把补充要求与这份计划一起交回计划 agent 修订一版（因此不会改动任何文件，但会再产生一轮模型调用）。待批准的计划存在 conversation value `agent.pendingPlanApproval` 里，恢复时按它取回。
- `permissionPolicy` 取 `"read-only"`、`"workspace"`（默认）或 `"auto"`，与内置 OpenCode 项目一致：`read-only` 隐藏写入与命令工具；`workspace` 在工作区内自动批准编辑和命令，读写与检索类工具（`read` / `write` / `edit` / `ls` / `grep` / `find`）只能落在工作区与 `allowedDirectories` 内；`auto` 批准一切未被显式拒绝的权限，包括工作区之外的路径。**三者都不会为内置工具弹出审批**——内置工具声明为 `autoApprove: true`，策略只决定「暴露哪些工具」和「工具能走多远」，宿主审批门只对宿主自己声明的工具生效。
  > **`bash` 不受路径限制。** 命令以宿主进程的身份在 `workdir` 里执行，`cwd` 只是工作目录而不是沙箱，命令本身可以读写工作区之外的任何位置；`read-only` 之所以更严，是因为它根本不暴露 `bash`。要限制命令的影响范围，只能靠宿主侧的沙箱，不要指望 `permissionPolicy`。参数面板上那句「工作区之外的路径一律拒绝」指的是文件类工具，**不要**据此认为命令也被关在工作区里。
- `hostInput` 用于「宿主自己保管这一轮的消息历史」的场景（OpenAI / Responses 网关就是这样）：带上它的一轮**不写 conversation 消息，也不读写下面这份 agent 记录**，与内置 Conversation 项目在 `input.openai !== undefined` 时的处理一致。项目从 `steamharness.readOpenAIConversationHostInput(context)` 拿到宿主输入时，把它一并放进 `AgentInput` 即可。
- **Pi Durable Harness 是唯一执行历史来源。** 固定 Pi SDK / Durable 1.2.0，Node >=22.19.0。Conversation 节点按 `storage.agentStoreDir`、conversationId、workflow 和 sessionKey 选择 SQLite 文件，实时提交消息、工具意图与结果、审批等待及用量记录。普通模式每轮关闭运行时；session 模式由宿主 lease 保持工具与 AI bridge 存活，前台回答结束后仍能继续输入和执行后台任务。多个 Agent 节点用不同 sessionKey。没有旧 KV transcript 迁移或 fallback。编程式 `steamharness.createAgent({ databasePath })` 显式选择 SQLite，不传则使用 MemoryStorage，同一运行时内审批暂停仍保留原任务。`readTranscript()` 只读模型上下文投影，`restoreTranscript()` 只用于空存储的首轮 seed，不覆盖已有 SQLite 历史，不能恢复活动任务。流式回答强杀后把已提交正文和推理纳入持久续写上下文，丢弃未完成工具调用；续写沿用断流预算。运行结束必须 `await runtime.close()`。
- **会话控制。** `session` 支持 `subagents: { tools, maxAgents?, models?: [{ provider, modelId }] }`、`nativeTools`、`compaction: { enabled?, reserveTokens?, keepRecentTokens?, backgroundTokens? }`、`planFork: "initial" | "current" | "asOf"`（默认 asOf）。显式工具权限列表须包含 `{ name: "update_plan", enabled: true, autoApprove: true }`，启用委派时再声明 `subagent`；`defineAgentConversationExecutor` 默认补这两项，自定义工具仍须显式声明。子 Agent 只获得父工具与项目白名单的交集，默认继承模型，也可选模型白名单中的精确 provider/modelId；禁止递归，最多 maxAgents（默认 4）个活动委派，嵌套 `nativeTools` 的 `api.executeTool` 仍经过 caller 限制、审批与取消。后台结果用持久 reporter 和 requestId 自动回传一次。
- **宿主协议。** `steamharness/agent` 导出 `createAgentSessionHost(scopeId)`（启动节点前创建，退出时 close）、`controlAgentSession(scopeId, command)` 和 `AgentSessionSnapshot`。scopeId 是原 workflow conversationId；`targetId` 是快照内数字 conversationId。`AgentRuntime.control` 可在 session 运行期间使用，等待就绪和排队前复制命令，调用方后续修改原对象不会改变操作。命令均带稳定 requestId：submit（steer / followUp / reject）、withdraw（inputId）、promote（inputId，原子将排队项转为 steer 并保存回执，保留原身份和图片）、compact、reset（可选 handoff）、fork（已提交 entryId）、delete（子会话）、configure（expectedVersion、已注册 model / effort）、plan（expectedVersion、items）、cancel（foreground / all / task）和 snapshot。相同身份不同载荷拒绝；撤回或提升已消费输入返回 already_placed / settled，不能撤销已完成副作用或重发消息。默认输入框忙碌时使用 followUp，空闲时直接执行；队列项的立即发送使用 promote。创建 fork 前由宿主显示确认弹窗。
- **重连与占用。** 重连已有 session 时使用 `createAgentSessionHost(scopeId, { resume: true })`，只重建工具、控制通道并恢复任务，不重发 workflow 初始消息；新输入使用 submit 命令。忙碌拒绝不持久化为原任务失败。Plan 审批和 hostInput 不使用此重连模式。CLI Web / Studio 对重复打开的同一会话显示只读提示，不同会话可并行；同一 SQLite 的分叉由同一进程调度。 宿主失去控制连接时调用返回对象的 `suspend()`，等待 workflow 退出并释放资源，保留未完成输入与检查点；`close()` 等待当前工作结束，主动停止使用 `cancel`，不得把断开控制连接当作取消。
- **快照与界面。** `session` 事件或 `metadata.kind: "agent-session"` 辅助输出提供 version、ownerId/revision、tasks/history、turns、contexts、plan、records、receipts、usage 和配置/提示摘要。宿主按 ownerId/revision 接受完整快照，以 receipt 补回丢失确认，不把快照当正文。Studio Trace 提供轨迹、任务、计划、记录、用量五个视图；CLI Web 保留正文、队列与分叉入口，正文 markdown 始终平铺。工具任务 arguments 保存提交参数（非修复或 hooks 后的审计），活动和完成历史均可逐层查看。历史工具按 assistant entry 关联，跨轮复用 call ID 不串任务；流式工具事件 toolCallId 是稳定的不透明展示身份。审批绑定持久 conversation/task/call ID，暂停恢复沿用原决定，后续同 ID、同参数的独立调用重新校验权限。reset 在输入边界进入新世代，保留旧正文；fork 在同一 SQLite 内新建独立 Harness conversation、provider 身份和队列，不复制活动任务或审批，计划依 planFork 继承。取消 foreground 不跨后台边界，all 包含 owned 子会话但不跨独立 fork，task 校验所属会话。删除子视图会取消并隐藏该子会话，根会话删除才回收底层存储。 未完成轮次的 `reason` 为原因码，`detail` 保留具体模型错误或重试耗尽原因；`model_error` 等显示失败，只有持久取消 `aborted` 显示已停止。未取消请求收到 provider aborted 按断流预算恢复，真实 Stop 不重试。
- **session 的配置与压缩。** 普通 Agent 与 session 都通过 Durable 阈值/溢出压缩事务在每次模型请求前检查，默认达到窗口的 90% 时先压缩；compact 可在活动任务期间提交并与其协调。运行中不允许通过 CLI 参数切换模型、权限或工作目录，空闲后提交会重建工具和 bridge；fork/子视图在主会话修改这些工作流参数。Core configure 使用版本 CAS，仅切换已注册模型/effort，在下一请求生效，不序列化凭据；提示只记录摘要和版本。Plan 模式及 hostInput 不持有 session lease，审批仍按原流程暂停。
- **持久扩展与任务。** 用 `steamharness.createAgentRegistry()`、`steamharness.defineAgentTask<Input, Checkpoint, Result>()`、`steamharness.defineAgentExtension()` 创建项目 registry，通过 `session.registry` 安装；`steamharness.defineAgentDoc()` 声明同事务业务文档，`steamharness.agentHook(steamharness.AgentToolTask / steamharness.AgentGenerationTask, hooks)` 安装工具或模型 hooks。任务定义必须提供稳定 name/version、initial、各 phase 和 abort；每个 phase 通过 `runtime.commit()` 保存进度或终态，依赖用 waiting/on/policy，定时用 `runtime.sleep(绝对毫秒时间, context)`，将同一时间存入 checkpoint.wakeAt 供侧栏展示。宿主 `task` 命令带 name、严格 JSON input（最多 256 KiB）及可选 background；Date、Map、函数、非有限数等在记录 requestId 前拒绝，receipt 与创建任务原子保存，同 requestId 不重复创建。不要覆盖 `pi.*`、`steamharness.*` 名称或已有工具。registry 热更新采用不可变快照，在途工具/hook 固定实现；定义缺失或不兼容在重新调度/重开时 blocked，重新安装兼容定义后唤醒。
- **授权目录与延迟 MCP。** 显式启用 `session.toolSearch`，目录经 `catalogs: [{ id, tools?, allowedTools?, open }]` 声明；tools 是不含 execute 的工具描述，allowedTools 使用最终 Agent 工具 id。未预声明 schema 时首次搜索才连接并持久化目录；有 schema 时打开会话先保存定义，首次实际调用才连接。open 返回 `{ tools, close? }`，按名称、描述、schema 和 replay 核对当前描述及会话首次持久化的定义，同时更换宿主和服务描述也不能绕过；漂移拒绝执行并关闭连接，使用新定义须创建新会话，暂时连接失败可再次调用重试。`steamharness.createMcpToolCatalog({ definition, allowedTools, descriptors?, connect?, approve? })` 使用原始 MCP 名称白名单；不扫描任意服务或读取外部配置。`createTools` 也可返回 `{ tools, catalogs, close? }`，需要 session.toolSearch；显式工具权限列表仍须声明 tool_search 和目录中的最终工具名称。
- **Code Mode。** `session.codeMode: { memoryLimitBytes?, timeoutMs? }` 显式启用官方 QuickJS，默认关闭；默认 64 MiB/300 秒，上限 256 MiB/300 秒。脚本仅能访问本会话授权工具，不能直接访问 Node、凭据或独立模型；所有嵌套调用仍走 caller、权限、审批、replay 和取消。显式工具权限须包含 codemode。任务树提供脚本及嵌套调用，不改变主回答正文；小助手不提供 Code Mode 项目配置项；需要此能力时由项目宿主通过 `session.codeMode` 显式启用。
- **执行目标。** `session.environment: { id, label, open(target, context) }` 返回公开 `AgentExecutionEnv`，id/cwd 必须与目标一致，同一持久会话不能更换环境身份。read/write/edit/bash 使用该环境，grep/find/ls 不提供本机回退；文件范围与命令权限由远端环境负责执行。宿主关闭会在 Harness 停止后 cleanup，不提供云沙箱创建服务，凭据只由工厂重建。快照 resources 记录环境、registry、目录、存储及 Code Mode 状态，只供辅助诊断。
- **自定义存储与备份。** `storage: { label, open() }` 与 databasePath 互斥，open 返回 `{ storage: AgentStorage, release?() }`，工厂负责独占 owner；Harness 先 close，再 release。宿主从 `steamharness/agent` 导入 `exportAgentDatabase({ databasePath, destination })` 与 `importAgentDatabase({ source, databasePath })`，只用于离线 SQLite；先停止并等待 worker，两个函数均获取源与目标的独占 owner 锁，校验 Durable 表结构并用 backup 包含 WAL，目标必须不存在且未被其他 owner 预留，不覆盖会话。它们不是注入的 workflow 全局成员。数据库备份不包含项目工作区文件或凭据。
- **自定义任务的离线取消。** 优先向活动 owner 提交 cancel，执行已注册的 abort。宿主先停止并等待 worker 后，也可调用 `steamharness/agent` 的 `cancelAgentConversation({ agentStoreDir, conversationId, registry })`，传入相同项目定义执行清理；缺少定义的任务仅能终结为 orphaned，不能执行项目清理代码。
- **联网搜索。** `AgentModelAttributes.webSearch` 声明端点能力；为 true 时默认添加 OpenAI Responses `web_search` 或 Anthropic Messages `web_search_20250305`（每次请求最多 5 次）。`AgentRuntimeOptions.webSearch` 与本轮 `AgentInput.webSearch` 为 boolean 开关，本轮优先；false 关闭，未声明能力的自建端点可显式 true，能力 false 或其他协议开启时报 input_validation。OpenAI 须用 `apiKind: "openai-responses"`，Chat Completions 不支持。保留本地工具，搜索由提供方执行，模型自主决定是否调用；摘要请求不启用。不要把 `web_search` 注册为本地 AgentTool。运行时产出 `web_search: { search: { id, status, query?, sources, error? } }` 和 `sources: { sources: { url, title?, citedText? }[] }`；节点显示搜索详情和可点击来源，持久会话在各自 turns[].items 保存投影，提供方原始内容只用于同提供方/模型续聊，不进入输出。关闭下一轮搜索仍保留有效搜索历史。Anthropic pause_turn 最多自动续接 3 次。便捷参数提供 --web-search 的空字符串（自动）、true、false 三态；静态内联 params 的项目可在模型设置 auxiliary 中声明 `{ name: "webSearch", flag: "--web-search", type: "string", control: "select", defaultValue: "", options: [{ value: "", label: "自动" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }] }`，交由 createAgentProjectInput 解析。
- **自动压缩。** 普通 Agent 与持久会话在每次模型请求前检查上下文，包括同一轮工具执行后的继续请求；默认占用达到模型窗口的 90% 时先压缩较早的历史，再继续运行，`contextWindow` 覆盖值参与判断。事件为 `auto: true`，开始发送 start，成功后发送 end；失败或取消保留原记录，压缩失败会终止本次运行。提供方返回明确超限错误时尝试一次压缩后重试，再次超限直接报错。超限历史分块总结并合并摘要，每次摘要请求预留输出空间，所有调用计入用量。保留最近消息及完整工具调用与结果；剩余单条输入或工具结果仍超限时须缩短该内容。`session.compaction.enabled: false` 关闭自动压缩和溢出恢复，手动压缩仍可用。
- **恢复使用稳定请求身份。** Agent 节点从原 `runId` 派生 requestId，重试与恢复必须沿用原参数、已解析答案和 runId。已提交工具结果不重做；默认 `replay: "never"` 的未知结果工具返回中断错误，只有明确 safe 的工具自动重放。写、编辑和 bash 都为 never；这不提供外部副作用 exactly-once 保证。存储或投影失败终止运行，不能静默丢历史继续。审批等待期间也不能压缩或替换上下文。
- Agent 在运行开始、流式消息、工具结果和压缩后发送 `context_usage`，由节点转换为 `display: { type: "ring", placement: "composer-right" }` 的标准输出项；首次对话不等待模型响应即可出现圆环。宿主只消费通用输出协议，不能另读 Agent 字段实现专用显示。输出 payload 的 `contextUsage: { used, total }` 供程序读取，`--context-window` 可覆盖分母。`used` 优先取最近一次有效模型 usage（含缓存 token）加后续消息估算；没有有效 usage 时估算实际系统提示、命名提示段、工具定义与消息，西文按 4 字符约 1 token、CJK 按字符计、图片近似估算。实际压缩后保留的旧响应 usage 不再参与校准，恢复记录后同样生效。
- Durable 快照的 `turns[].usage` 为该回答轮次已返回的模型用量（标准 `TokenUsageAggregate`），包含工具循环、失败重试与轮内压缩；不得用 owner 工作流跨会话的累计 `token_usage_updated` 或最终报告覆盖回答。继承历史及其他 fork 不重复计入该轮。`contexts[].contextUsage` 提供各会话当前占用，Agent 节点将其转换为同 ID 的标准圆环 `contexts[].outputs`；宿主选择当前打开会话的通用输出覆盖历史值，保证后续轮次、fork、压缩与 reset 后同步。空闲后台压缩的消耗只保留在会话总用量，不回写已完成回答。
- 编程式 `AgentRuntime.getContextUsage()` 随时返回当前上下文占用，包含正在流式生成的消息；模型窗口不可用时返回 `undefined`。`updateContextUsage({ used, total })` 提交当前占用的绝对测量值，`used` 必须为非负有限数，`total` 必须为正有限数；运行中的 `context_usage` 立即发送该更新。后续估算在测量值上增长，直到有效模型 usage 或实际压缩重新校准；`total` 不修改模型配置，模型校准使用本轮 `contextWindow` 或模型窗口。`reset()` 同时清除测量值和恢复记录。独立 transcript 可通过 `steamharness/agent` 的 `estimateAgentContextTokens(messages)` 估算。
- AI 配置、模型和 Effort 放在一个 `kind: "quick"` 的 `fields` 中；Permission 用另一个 Quick。Agent 模式使用 `kind: "mode"` 独立开关，Context window 和工作目录可分别放在有明确标签的 Auxiliary 中。动作入口在 Desktop 上按声明顺序显示，具体形态见 `references/param-panels.md`。
- 直接把 prompt 写成 `/compact` 或 `/summarize`（或传 `compact: true`）会立即总结全部已有上下文，不调用模型生成普通回答；空上下文直接完成。先发送 `compaction` start，成功后发送 end 并持久化摘要，后续回合使用摘要，原对话正文保留。只有非空且正常结束（`stopReason: "stop"`）的摘要才替换 transcript；模型失败、截断或未完成时抛错并保留原始记录，取消以 `execution_aborted` 结束，取消后返回的摘要也不能写入。公开 `compactAgentMessages({ ..., force: true })` 同样总结全部已有消息。自动压缩才保留最近的一段对话：最近的窗口里没有用户轮次时退到最近的 assistant 轮次，最新一条消息永远保留。
- 总结响应的计费用量同样通过 `host.reportUsage` 上报，包括失败或取消响应中的已消耗 token；不能把它当作总结后的上下文大小。直接调用 `compactAgentMessages` 可传 `onUsage(usage)`，在摘要校验前接收模型返回的 pi `Usage`。
- **取消运行会中止本轮**：`context.abortSignal` 一触发就调用 pi 侧的 `agent.abort()`，模型流与正在执行的工具一起停下，本轮以 `execution_aborted` 结束（工作流据此把运行标成 aborted，而不是失败），已经花掉的 token 仍会照常上报。

配置对象（`AgentProjectOptions`，三个成员共用）：`workdir`、`systemPrompt`、`provider`、`model`、`baseUrl`、`apiKind`、`modelAttributes`、`webSearch`、`effort`、`permissionPolicy`、`mode`、`tools`、`toolDefinitions`、`allowedDirectories`、`extraTools`、`createTools`、`session`、`sessionId`、`sessionKey`、`databasePath`、`storage`、`name`、`historyLimit`，以及项目级 `executorName`、`projectName`、`outputItemId`、`params`。

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
const readKey: AgentTool = {
  name: "db_get",
  label: "Read a database key",
  description: "按 key 读取目标项目 KV 的当前值。",
  parameters: {
    type: "object",
    properties: { key: { type: "string", description: "要读取的 key" } },
    required: ["key"],
  },
  async execute(_toolCallId, { key }) {
    const value = await context.storage.server.relatedProjects.get("database").kv.getValue(key);
    return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], details: { key } };
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

**技能按需读取，不注入提示词。** `await steamharness.createSkillTools({ directories, approve? })` 返回一个 `skill` 工具：

- `action: "list"`：列出每个技能的名字、一句话描述和文件清单。
- `action: "read"`：读技能里的一个文件；`path` 省略时读 `SKILL.md`，只能落在该技能目录内——`..` 越界、绝对路径和指向目录外的软链接都会被拒绝，不存在的文件会点名说是哪一个。

一个技能就是一个含 `SKILL.md` 的目录，名字与描述取它 frontmatter 里的 `name` 与 `description`（没有 frontmatter 就用目录名）。**不要把整份 `SKILL.md` 塞进系统提示词**——它有几十 KB，而大多数轮次用不上；让模型自己 list 再 read 才是这个工具的用意。`directories` 按优先级排序，先出现的目录里的同名技能胜出，所以项目自带的副本会压过随宿主一起发布的那份。需要按名字重跑时用 `steamharness.runSkillAction(directories, args)`。

**带能力的变量只能按名继承。** 宿主用 `allowedInheritedEnvKeys` 列出允许按名继承的变量（凭据、令牌等），服务再用 `inheritEnvironment: [...]` 申请；把这些变量写进 `environment` 会被直接拒绝（`must inherit sensitive environment key "…" by name`），这样值不必出现在可能被记录或提交的配置里。

输出项使用中性 `metadata.kind` 族（`agent-part` 配 `partType: reasoning | text | tool | patch | compaction | retry | plan | file`，以及 `agent-notice`、`agent-error`、`agent-answer`），正文回答仍是平铺的 markdown item，不进入详情块。

重试与续写预算按连续失败计数：完整成功的模型响应（包括正常返回工具调用）后归零，后续失败从 `Retry 1 / 10` 重新开始；输出上限的独立 2 次预算也在成功后重置。部分正文、推理片段及未完成运行的进程恢复不重置预算。重试输出项 ID 与显示编号独立，编号重复仍保留每条历史记录。

`retry` 事件的 `kind` 和重试输出的 `content.kind` 区分网络中断 `dropped`、宿主恢复 `recovery`、输出上限 `length`、工具调用补全 `lost-call`。CLI Web / Studio 只在正文显示网络 Retry，其余内部续写静默进行，保持已有正文和运行状态，记录保留在 Trace 与导出中。最终失败展示具体原因，主动 Stop 不自动恢复；宿主恢复仍使用原有连接预算，不因静默展示而重置。

**一轮的正文写在它被说出的位置。** 会话运行时，两条活动行之间的每段文字是一条独立的 `partType: text` 行：模型先说一句再调用工具时，那句话停在那次调用的上方，而不是被并进末尾的整段回答里。宿主驱动的运行（OpenAI/Responses 适配器）不走这条路——它把整轮文本流进项目声明的那个 `agent-answer` 条目，因为适配器是**按 id 读回响应正文**的，那个条目必须是完整文本、不能只是片段；因此同一轮在两种运行里产出的行不同，但文字完全一致。

**输出项按「结束顺序」排列。** payload 里每一项的位置取自它*结束*的那一刻，而不是开始的那一刻：推理与文字都是攒够一段才落行的——推理在下一次活动开始时被冲出来，文字在被打断时结束——按开始位置排会读成前后颠倒。宿主按 payload 顺序渲染即可，那就是模型实际的执行顺序。

依赖：`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 由 `steamharness` 直接依赖，宿主侧安装 `steamharness` 即可，项目不需要单独声明。

## 工作流能力工具

Kanban 页面可注册 `window.steamHarnessKanban.methods.register({ name, description, inputSchema, readOnly? }, handler)`，返回注销函数。handler 的参数是 JSON 对象及 `{ signal: AbortSignal, configuration, presentation }`，返回 JSON 或 Promise；schema 是发现元数据，业务参数由 handler 校验。每页最多 32 个方法，名称匹配 `^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$`，描述最多 2,000 字符，schema 最多 8,192 字符；输入、结果和目录最多 65,536 JSON 字符、32 层深度。注销、关闭、刷新、取消和超时终止等待，handler 应在写入前检查 signal；配置 ID 变化清空注册，页面需重新注册。没有任意脚本执行或全局函数调用入口。

`steamharness-kanban_kanban_methods` 用 `{ action: "list" }` 返回当前项目已挂载预览的 `instances`，包含 `instanceId`、`configurationId`、`configurationName`、`location`、`presentation`、`ready`、`methods`；然后用 `{ action: "invoke", instanceId, configurationId, method, args }` 调用该实例。主区、Dock 和对话卡片不能互相替代；关闭或切换后旧实例明确失败。每页最多 4 个并发调用，15 秒超时，超时可能已有副作用，不能自动重试相对缩放/平移或写入。Desktop 仅为当前本地 Kanban 目标和启用的工具策略注入认证回环桥及 `STEAMHARNESS_DEVELOPER_ASSISTANT_KANBAN_METHODS_ENABLED=1`；独立 CLI、Server 和托管 Web 不会暴露此 capability。Server 的页面注册 API 本身不会建立远程 Agent 连接。

Core 提供「工作流能力」工具，把项目跟它周围的东西接起来：知识库文档、KV、跨会话记忆、宿主配置和 Conversation 资源卡片。每个能力只描述一次（一份 JSON Schema 加一个执行函数），再渲染成两种形态——给 agent 用的原生工具，和给宿主自带 harness 用的 MCP 服务端。两边看到的工具名、描述和参数 schema 完全一致。

| 能力 | MCP 服务 id | 工具 id（**保持不变，宿主按它授权、审批与恢复**） |
| --- | --- | --- |
| 知识库文档 | `workflow-knowledge` | `workflow-knowledge_knowledge_documents` |
| KV | `workflow-kv` | `workflow-kv_kv_store` |
| 跨会话记忆 | `workflow-memory` | `workflow-memory_global_memory` |
| Kanban 页面方法 | `steamharness-kanban` | `steamharness-kanban_kanban_methods` |
| Conversation 资源卡片 | `workflow-ui` | `workflow-ui_present_card` |

- `await steamharness.createProjectCapabilityTools({ context, approve?, globalMemory? })`：返回可以交给 agent 的原生工具（放在 `extraTools` 或 `createTools` 里）。`globalMemory` 为 `true` 时才包含跨会话记忆——宿主没有记忆存储时，不要给模型一个每次调用都会失败的工具。
- `await steamharness.createProjectCapabilityServer(toolId, { context, approve? })`：取其中一个能力的 MCP 服务端，自己 `connect(transport)`；工具 id 未知时抛错。
- `await steamharness.runProjectCapabilityAction(toolId, context, args)`：按工具 id 直接执行一个动作。**审批恢复要用它**——暂停的那一轮已经结束，调用只能按宿主批准的那个 id 重新寻址，不能靠当初建它的闭包。
- `steamharness.listProjectCapabilityToolIds({ globalMemory? })`：列出这一轮会出现的工具 id。
- `steamharness.isProjectCapabilityAvailable(toolId)`：这个能力在**当前进程**里能不能干活。宿主配置与 Kanban 页面方法随宿主桥环境变化；Kanban 另需宿主明确启用。工具不可用时不应暴露给模型。`Capability.run(context, args, signal?)` 可接收 Agent/MCP 的调用取消信号；Kanban 通道将其传递到页面 handler。

**它们不受 `permissionPolicy` 约束**——策略只管内置的 7 个编码工具。项目在 `executor.tools` 里声明这些工具 id，声明里的 `enabled` 决定是否暴露、`autoApprove` 决定是否自动批准；把 `approve` 接到 `steamharness.createToolApprovalGate().approve(...)` 上就是同一条审批链。

宿主配置只在宿主注入回环桥时可用：`STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL` 与 `STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN` 必须同时存在，且地址必须是不带凭据的 `http://127.0.0.1` 回环地址，否则这一项不暴露（`isAvailable` 返回 `false`，不会抛错打断其它能力；真正调用时才抛出说明地址不合法）。跨会话记忆复用知识库存储，文档 id 统一带 `assistant-memory-` 前缀，`remember` 会拒绝看起来像凭据或密钥的内容。

`workflow-ui_present_card` 用 `action: "upsert" | "remove"` 和稳定 `cardId` 向 Conversation 宿主发送卡片命令。remove 只接受 `cardId`；upsert 还需 `kind`（`kv`、`knowledge`、`project`、`browser`、`file`、`kanban`）及目标 `target`。`pinned` 是当前客户端按会话保存的固定状态，显式的 Agent 固定命令可覆盖用户上次的固定选择。顶层 `preview: boolean` 用于 `kanban`、`project` 或 `browser` 卡片，控制右上预览是否直接展开；已识别的 Kanban 项目和浏览器卡片默认 `preview: true` 且固定，`preview: false` 可关闭。`project` 卡片指向 Kanban 项目时点击进入 Dock 预览；浏览器预览仅在 Electron 可用。`target.source: "current"` 在小助手中指其当前操作的项目；小助手自己的 KV/知识库调用仍指向小助手项目。`kanban: { mode: "preview", values }` 是另一项参数能力：preview 只覆盖该卡片和 Dock 的参数；持久保存由 Studio Control manage_configurations 完成。浏览器仅 HTTP(S)，文件路径必须是项目内相对路径；宿主打开时重新校验项目权限，历史回放不重复执行保存。普通消息接口不变，主回答仍直接呈现在对话正文。

**参数边界由 Core 自己检查。** 每个能力的 JSON Schema 都声明了长度上限，而 MCP 客户端并不受 schema 约束、agent SDK 也把它当类型断言，所以这些上限在实现里同样执行：知识库 `markdown` ≤ 200000、`title`/`documentId` ≤ 200、`query` ≤ 500、`cursor` ≤ 80，跨会话记忆 `markdown` ≤ 100000、`title` ≤ 200，KV `key` ≤ 500。超出会以 `input_validation` 失败，而不是一路写到存储里。

**KV 保留键。** `kv_store` 与运行时的记账共用同一个命名空间，所以它拒绝写入属于运行时自己的键：`tokenUsage.total` 与 `tokenUsage.entry.*`（项目与 conversation 两个作用域），以及 conversation 作用域下的 `conversation.state` 与 `agent.*`（待批准的计划就存在 `agent.pendingPlanApproval`）。被拒绝时返回 `input_validation`。

**跨会话记忆的游标带动作前缀。** `list` 的 `cursor` 是「记忆条数」的偏移，`search` 的 `cursor` 是知识库自己的分页游标，同一个字段两种含义；因此返回的游标会带上 `list:` / `search:` 前缀，把属于另一个动作的游标传回来会被明确拒绝，而不是当成另一种偏移量解读。

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

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "@steamharness/hello-workflow",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@steamharness/cli": "0.2.0",
    "steamharness": "0.2.0"
  },
  "steamHarness": {
    "projectInfo": {
      "dataStorage": {
        "mode": "both"
      },
      "relatedProjects": []
    }
  }
}
```

workflow package 的顶层 `id` 必须是 UUID。它既是远程项目主键，也是 server 权限校验边界；不要再使用目录名、包名或 `steamHarness.id` 代替。`steamHarness.projectInfo.dataStorage.mode` 是必填权威声明，新项目默认 `both`。通用关系写在 `projectInfo.relatedProjects`：alias 匹配 `[a-z][a-z0-9_-]{0,63}`，最多 32 项，alias 与 projectId 均不得重复或指向自身；每项只允许 `alias`、`projectId`、`grantToRelatedProject`，权限规则为 `none | all | prefixes`，`prefixes` 必须非空且去重。双方默认显式互写 `read: all`、`write: none`，单边声明可保存但只表示待确认。旧 `access`、`kanban.dataSources`、`.workflow` 存储作用域和全局 KV 不会自动转换。Core/CLI 使用独立的精确版本，除此之外只声明真实第三方依赖。CLI binary 由外层 Desktop、workspace、server tooling 提供。上传只按项目根目录 `.steamharnessignore` 选择文件，`.gitignore` 不参与；下载恢复服务端已保存的完整文件清单，不再次应用上传忽略规则。

## Server 数据服务

Server 提供项目创建、上传、不可变源码发布、历史版本下载、知识库、KV、PersistentValue 和文件存储。它不执行上传代码。数据写入采用 owner / manager / writer / viewer 成员权限，源码下载另行授权；关联数据访问仍需双方确认。

## CLI 面

外层 `steamharness` 命令由 Desktop、workspace 或 server tooling 提供，项目只声明精确版本依赖，不生成自己的包装脚本。

**本地项目命令**（`<dir>` 缺省为当前目录）：

| 命令 | 用途 |
| --- | --- |
| `steamharness structure <dir>` | 静态结构与违规检查；Workflow/Conversation/Kanban 都支持。 |
| `steamharness json <dir> --entrypoint <id> -- [args]` | 用 JSON report 运行一次，不渲染用户可见输出。Kanban 拒绝。 |
| `steamharness run <dir> -- [args]` | 真实运行并渲染 output items。Kanban 拒绝。 |
| `steamharness resolve-params <dir>` | 单独调用入口的 `resolveParams`，用于调试参数联动。 |
| `steamharness mcp` | 把本地项目能力暴露成 stdio MCP server。 |

常用 flag：`--conversation-id <id>` 指定或续接会话；`--entrypoint <id>` 选择入口；`--related-project <alias>=<绝对目录>` 为 `relatedProjects` 提供本地目标（本地验证跨项目 KV 的唯一方式，双方声明必须已存在且目标项目 `.id` 合法）；`--run-id <id>`、`--resolved-user-inputs-json <json>`、`--tool-permissions-json <json>` 用于恢复等待中的 user-input 与工具策略；`--file-store-dir <dir>` 指定本地文件存储目录。旧的 `--version` 已移除，发布版本由宿主管理。

**workspace 子命令**（连接 SteamHarness Server 时）：

`login`、`logout`、`status`、`health`、`pack`、`upload`、`preparation`、`download`、`publish`、`versions`、`file-upload`、`file-download`、`file-delete`。常用 flag：`--path <dir>`、`--create`、`--no-wait`、`--project-group`、`--publish-group`、`--deployment <id>`、`--dependency <alias>=<路径>`。项目端点：`/api/projects/<id>/package|publish|versions|source-files|source-archive`。

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

configuration.json v2 字段支持 sharing: {publish?, includeValue?, editable?} 和 JSON Pointer paths: Record<string, rule>。默认发布字段、允许个人修改、不携带值；defaultValue 同样过滤。JSON 对象逐路径检查实际变化，数组整体处理。只有实际项目所有者或管理员能在线保存 publication.save 草稿，选择配置集与默认配置；发布校验源码摘要和草稿版本，冻结模板及附件。get_configurations 返回 fieldCapabilities，preview:true 返回接收者预览。个人导入、重命名和自定义字段不能覆盖锁定值或作者定义。SDK getConfig/context.config 保持冻结快照，已验证模板和附件缓存到源码之外，升级只保留仍允许的个人值，Workflow 恢复沿用原快照。
