# Studio

基于 VS Code OSS 的独立工作站，提供 Electron 桌面应用和浏览器 Web 工作站。当前版本是可继续开发的源码框架。

## 项目结构

```text
studio/
  upstream/vscode/                 VS Code OSS 源码，Git 子模块
  config/upstream.json             上游版本与提交锁
  config/patches.json              已合入内核的历史补丁指纹与提交
  config/product.json              Studio 品牌、数据目录、扩展市场配置
  config/downloads.json            Electron 与 CI 依赖下载镜像
  config/default-extensions.json   首次启动安装的默认扩展
  extensions/studio-workstation/   桌面 / Web 共用的工作站扩展
  patches/                        按文件名顺序应用的上游补丁
  scripts/                        初始化、构建、启动、环境检查
  tests/                          框架与项目记录测试
  docs/architecture.md            开发边界与扩展方式
  .studio/                        本地运行数据，不提交
```

底座基于 [VS Code 1.141.0](https://github.com/microsoft/vscode/releases/tag/1.141.0)，原始上游提交为 `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`。Studio 内核维护在 fork 的 `steamharness-dev`、`steamharness-alpha`、`steamharness-main` 分支，分别对应开源仓库的 `dev`、`alpha`、`main` 通道。实际使用的提交固定在子模块引用和 `config/upstream.json` 中。可以从 `upstream/vscode/src` 开始定制内核；初次使用浅克隆。

## 本地初始化

需要 Git、curl、Node **24.18.0 或更新的 24.x**、npm **11 或 12**，以及本机 C/C++ 工具链。macOS 需要 Xcode Command Line Tools，Windows/Linux 要求见[上游贡献指南](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)。首次安装会下载并编译原生依赖。

```sh
nvm install
nvm use
npm ci
npm run setup
npm run build
```

`setup` 初始化子模块、应用品牌及补丁、构建 Studio 扩展、安装上游依赖和固定版本的调试扩展，并跳过开发构建不需要的 Playwright 浏览器下载。`build` 使用上游 `build-fast` 生成工作台和内置扩展；这是开发转译构建，不代表上游全部 TypeScript 检查通过。

Foundry Local / ONNX 原生运行库用于上游聊天的本地语音听写，Studio 的编辑器和 Workflow 功能不依赖它。`setup` 默认使用 SDK 的 `FOUNDRY_LOCAL_SKIP_INSTALL=1` 跳过这项 NuGet 下载，其它依赖的安装脚本正常执行。需要上游本地语音听写时，将 `FOUNDRY_LOCAL_SKIP_INSTALL` 设为 `0` 后重新运行 `npm run setup`；下载源可通过 SDK 的 `FOUNDRY_LOCAL_NUGET_FEEDS` 指定。

## 桌面应用

```sh
npm run dev
```

首次启动会下载上游所需的 Electron。也可以传入目录或 VS Code 启动参数：

```sh
npm run dev -- .
```

## Web 工作站

```sh
npm run dev:web
```

默认监听 `127.0.0.1`，在 `3030` 到 `3040` 中选择可用端口。使用上游 Web Server 和连接令牌，终端会打印完整访问地址。Web 版支持服务器文件、终端和工作区扩展；工作区文件位于运行服务器的机器上。

```sh
npm run dev:web -- --port 3050 --default-folder /absolute/path/to/project
```

两端使用不同的 `.studio/` 数据目录，不影响已有 VS Code 设置和扩展。Web 入口目前用于本地开发；桌面工作站已接入 SteamHarness Server 账号，公网部署和安装包发布尚未配置。

默认打开当前源码仓库。首次运行时，需要信任该目录，才能加载位于仓库内的内置扩展并使用终端；Web 如显示 Restricted Mode，可点击横幅中的 Manage，再选择 Trust。打开其他项目时仍保留上游工作区信任检查。

## 已有工作站入口

编辑器没有文件时显示原生开始工作台。**Studio: 打开开始页** 打开可恢复的独立标签页，`studio.startPage.enabled` 控制无文件背景入口。Untitled 保持原生空白文本编辑行为，输入、粘贴、撤销和清空均在原文件中完成。双击编辑器背景或标签栏空白处不再自动新建 Untitled；仍可通过新建文件命令或快捷键打开。

开始页可新建 Workflow / Conversation / Kanban 项目，或创建 Hello 工作流、轮次对话、基础看板、参数化看板四个无需登录和模型的本地示例。选择名称、父目录及新窗口或当前窗口后生成独立 UUID，使用固定 Core/CLI 版本，先打开目标 Studio 项目窗口，再由该窗口自动安装依赖，优先 pnpm、缺失时使用 npm。进度、取消、日志和重试均在项目窗口中处理，失败和取消保留源码；取消窗口选择不会生成项目。

当前项目提供运行和源码入口；最近项目、系统状态、小助手、账户、设置和内置 Analysis 入口集中展示。可见时每 5 秒读取真实运行概况，读取失败保留旧数据并提示异常。中英文、主题和窄分栏沿用 Studio 设置。

活动栏中的 Studio 提供当前工作区、最近项目和工具视图。支持打开文件夹及 `.code-workspace`、保存最近项目、创建文件、打开终端、运行任务，以及访问源代码管理、扩展和设置。最近项目、文件夹/工作区、关联项目及下载后的打开操作均先选择新窗口或当前窗口，取消选择保留当前工作区。失效项目可以从最近记录中移除。

新增功能优先放入 `extensions/studio-workstation/src`。扩展同时输出 `dist/extension.js` 和 `dist/extension-web.js`，用标准 VS Code API 兼容两端。

## Workflow 项目

桌面版已接入 Workflow 的最小工作站流程：通过 **File > Open Folder** 打开项目文件夹，识别完成后，窗口顶部会显示带播放图标的 **运行项目** 按钮。点击按钮才在编辑器标签页中打开对应界面，不会执行 `package.json` 中的脚本。

运行按钮右侧的 **上传项目** 使用 Studio 当前账号，将源码上传并发布为 `package.json.version` 对应的服务器版本。左侧 **版本** 页展示历史版本、发布说明与关联版本，并提供下载；开始页也提供下载入口。下载保存到宿主用户主目录下的 `Documents/steamharness-projects/<项目名>-<版本>`，重名自动加序号，保留已有文件。项目标签、最近项目和资源面板展示本地版本；上传与下载均不会在服务器安装依赖、构建或执行源码。下载后可选择在新窗口或当前窗口打开，再在项目终端安装依赖。

打开 `examples/conversation` 可以试用不需要模型凭据的本地对话演示。聚合仓库中的小助手位于 `../build-in/build-in-developer-assistant`；真实模型对话需要项目的 SteamHarness Server 和 AI 凭据配置。

标题栏左侧可切换 **IDE / Steam** 模式，并为 macOS 原生窗口按钮预留随缩放调整的空间。IDE 保留编辑器布局；Steam 隐藏活动栏、文件侧栏和底部面板，左侧显示项目运行页面，右侧通过“打开工具”使用 KV、知识库、项目信息、小助手、版本管理和运行追踪。返回 IDE 会恢复原有布局和编辑器，运行页面及未保存文件会保留。模式按工作区记忆，工具位置只在当前窗口临时调整；普通文件夹不能进入 Steam 模式。过渡动画遵循系统的“减少动态效果”设置。

Steam 工具区首次打开占窗口宽度的三分之一；拖动分隔线后的宽度按工作区保存，隐藏重开、模式往返及重载窗口都会恢复。窗口缩窄时临时限制宽度，保留用户选择的大小。

小助手还通过 `build-in/build-in-studio-control` 源码连接 VS Code：读取工作区和诊断、查询项目的关联声明与导入状态、打开文件并定位行列、切换已安装主题、打开终端及常用视图。`get_related_projects` 返回别名、UUID、名称、Studio 导入状态及核验后的目录；每次查询重新校验 UUID，不自动导入或代替数据授权。Permission 默认选择 Auto approve，提示词与控制工具均允许访问进程有权限的任意本地目录；Workspace / Read only 保留工作区目录限制。每个小助手会话拥有独立的认证回环接口，关闭会话、移除工作区或撤销信任后失效。工具沿用现有权限与 Build/Plan 审批，终端工具不执行命令。纯浏览器扩展不提供本地控制服务，需使用 Node 扩展宿主。

Studio Control 也可以作为普通 Workflow 项目打开：安装依赖后，在 Studio 中打开 `../build-in/build-in-studio-control`，点击 **运行项目** 并选择入口即可运行全部控制功能，无需小助手或模型配置。Studio 自动创建控制连接，默认目录为项目目录，文件访问限定在当前工作区；关闭运行页面后连接撤销，工作区子目录同样支持。

执行 **Workflow: 打开 Studio 分析** 或点击 Workflow 项目列表标题栏的图表入口，可打开 `build-in/build-in-analysis` 源码提供的内置 Kanban。它汇总当前工作区和已导入本地项目的真实运行历史与活动状态，展示图表、项目表、运行明细、筛选及 CSV 导出，不读取服务器数据。聚合仓库中的 `../build-in/build-in-analysis` 也可以作为普通 Kanban 项目运行；修改页面源码后先执行 `pnpm build`。

在完成扩展、同级 Core 和 CLI 构建后，`npm run test:analysis-live` 可使用隔离存储检验内置模板、真实项目 CLI、只读数据连接和项目范围更新；不会启动桌面窗口。

Studio 活动栏中的 **Workflow 项目** 列出当前文件夹及常见项目容器下的项目。Conversation 支持自定义参数、附件、工具确认与续跑、计划、输入队列、独立并发会话、历史与标签页恢复、输出和运行诊断；Workflow 支持入口选择和本地运行；Kanban 通过项目 CLI 打开静态产物、参数配置和数据 Bridge。能力范围见 [SteamHarness 工作站](docs/workflow-workstation.md)。

底部面板默认保留 Terminal。识别到 Workflow、Conversation 或 Kanban 项目后，显示 **KV** 和 **知识库** 标签，提供项目切换、搜索、分页和数据管理，样式跟随 VS Code 主题。数据与项目 CLI 共用存储，详见 [项目资源面板](docs/resource-panel.md)。

Workflow 和 Conversation 还提供底部 **轨迹** 面板。对话回复下方的执行图与日志入口合并为一个轨迹入口，点击定位对应执行记录；面板支持时间线、轮次、调用、搜索及参数/结果/日志详情，详见 [执行轨迹](docs/trace-panel.md)。

工作站使用每个项目自己安装的 Core 和 CLI；项目需安装支持 Web 宿主协议的 `@steamharness/cli`。聚合 checkout 的开发入口优先识别同级 Core/CLI，独立 checkout 保留 `../workflow` 布局；也可用 `STUDIO_STEAMHARNESS_SOURCE` 指定源码根目录。详细范围见 [SteamHarness 工作站](docs/workflow-workstation.md)。

## 语言与账号入口

简体中文使用官方扩展 `MS-CEINTL.vscode-language-pack-zh-hans`，在扩展市场中搜索并安装即可。桌面和 Web 的扩展目录相互独立，需要分别安装。显示语言沿用上游机制；源码开发模式的核心界面仍使用英文，正式构建按上游语言包流程加载翻译。Studio 自有扩展支持中英文；首版 Workflow 项目界面使用中文文案。

左下角设置按钮上方显示账号入口，提供 SteamHarness 登录、资料管理和退出操作。账号页在编辑器标签页打开，展示头像、昵称、邮箱、用户 ID、服务器连接方式及会话有效期，可复制账号字段、刷新信息，并打开控制台编辑资料或管理登录会话。默认连接本机 dev 服务 `http://localhost:7126`，可通过 `studio.project.serverUrl` 更改。登录凭据保存在 VS Code SecretStorage 中，已打开的 Conversation 会随登录和退出自动刷新参数；Core 和内置 CLI 使用同一份工作站凭据。详见 [SteamHarness 工作站](docs/workflow-workstation.md)。

Studio 启动时排除上游内置的 GitHub Copilot，并通过 `chat.disableAIFeatures` 默认隐藏 AI 入口。桌面和 Web 首次启动自动安装 [File & Folder Icons](https://marketplace.visualstudio.com/items?itemName=nextbook.file-and-folder-icons)，默认图标主题为 `file-icons`；已安装的扩展和用户自行选择的主题会保留。该扩展未发布到 Open VSX，安装包从原 Marketplace 下载，版本与 SHA-256 固定在 `config/default-extensions.json`，缓存位于 `.studio/`。

## 开发与检查

```sh
npm run watch:extension  # 修改 Studio 扩展时使用
npm run watch            # 使用上游源码监听和 Studio 扩展监听，另开终端
npm run check            # Studio 扩展类型检查、框架测试
npm run test:mode-ui     # 隔离无头浏览器验证 IDE / Steam 模式
STEAMHARNESS_UI_FOCUS=tools-width npm run test:mode-ui # 定向验证工具区默认比例、拖动与恢复
npm run doctor           # 查看源码版本、依赖和构建状态
npm run test:desktop     # 在真实 Electron 中验证扩展激活、文件及终端入口
npm run test:resources-ui # 项目识别、底部资源面板、数据编辑及主题布局回归
npm run test:conversation-ui # Conversation 界面与交互回归
npm run test:conversation-clipboard-ui # 系统剪贴板粘贴、图片上传、预览及历史恢复回归
npm run test:conversation-server-ui # 需要真实 dev 服务及模型的登录与对话回归
```

`watch:extension` 构建完成后，在运行的工作站中执行 `Developer: Reload Window`。F5 配置用于在当前编辑器中调试扩展。改品牌后执行 `npm run prepare:studio`；如修改桌面名称，在 Studio 根目录运行 `npm run electron` 重新生成对应 Electron 应用。

`test:desktop` 使用独立测试数据目录，运行后自动退出。

Studio 内置 PDF、DOCX、PPTX、XLSX、图片（含 HEIC / HEIF）及 LaTeX 公式的只读预览，源文件修改后自动更新。使用方式和验证入口见 [文件预览](docs/document-preview.md) / [File Previews](docs/document-preview.en.md)。

`watch` 使用上游 `watch-transpile` 和 Studio 扩展监听；需要检查上游内核类型时，单独执行 `npm --prefix upstream/vscode run typecheck-client`。修改内核后使用 `npm run build` 或 `watch`，再重启桌面应用或 Web 服务。

正常启动跳过上游的内部 API 测试扩展，测试命令再将它作为独立开发宿主加载。

上游完整开发编译可单独执行：

```sh
npm --prefix upstream/vscode run compile
```

GitLab CI 在推送后自动执行框架测试、Studio 类型检查和两端扩展构建。完整测试通过 `STUDIO_FULL_TESTS=1` 触发，在 `linux` runner 的 Xvfb 虚拟桌面中串行运行真实 Electron 和自包含 UI 回归，不占用本机桌面；真实服务、模型和外部预览样例用例需要另行配置。两种测试共用资源锁，完整测试按 runner 现有内存配额限制安装和构建并发，可以接受较长耗时。尚不生成桌面安装包。

## 品牌与上游维护

VS Code 源码使用 [GRCmade/vscode 的 steamharness-dev 分支](https://github.com/GRCmade/vscode/tree/steamharness-dev)进行日常开发；`steamharness-alpha` 和 `steamharness-main` 分别维护测试与正式通道，fork 原有的 `main` 保留其历史。`.gitmodules` 的远端更新默认跟随 `steamharness-dev`，普通子模块初始化仍按已提交的引用检出；`config/upstream.json` 固定同一内核提交。拉取源码需要 GitHub SSH 访问权限。当前内核定制和品牌配置已提交到 fork，`patches` 中保留对应补丁，准备脚本会跳过已合并的补丁。后续在 fork 中维护内核提交时，先推送源码提交，再同步更新 `config/upstream.json` 与子模块提交引用。

品牌的持久配置是 `config/product.json`。上游 `product.json`、开发期 `product.overrides.json` 和 Studio 扩展链接由脚本生成；检测到手动改动或冲突会停止，避免覆盖。Web 配置注入品牌、扩展市场和正确的上游 API 版本。源码补丁放入 `patches/*.patch`，按文件名排序。

准备脚本通过 `config/patches.json` 记录的内核提交和补丁 SHA-256 跳过已合入的历史补丁，即使后续重构改写了原补丁内容，也不会重复应用。记录仅对对应提交或可验证的后代提交有效；在固定提交的浅克隆中无需下载历史。新增补丁不写入这份记录，修改补丁后原指纹自动失效。补丁合入 fork 后，再核验内核提交并更新对应记录；固定到不含该记录提交的内核时，不得沿用旧记录。

未合入的新补丁先在临时 Git 索引中验证整个序列，普通应用失败时自动使用补丁中的 blob ID 尝试三方合并。全部成功后才一次性更新源码，保留本地修改与原暂存区；真实冲突会列出补丁和 Git 冲突信息，源码、未跟踪文件与暂存区均保留原状。`prepare`、`dev`、`dev:web` 和私有启动器共用这套机制，无需额外启动参数。

扩展市场默认使用 [Open VSX](https://open-vsx.org/)。上游内置调试扩展仍从其 GitHub Release 下载并校验官方 SHA-256。上游聊天服务配置暂保留以兼容其工作台代码，自有 AI 服务尚未实现。

Electron 下载地址固定在 `config/downloads.json`，默认使用 `https://npmmirror.com/mirrors/electron/`，本机 `setup`、桌面启动、`npm run electron` 和完整 CI 共用下载逻辑。网络失败最多重试 3 次，镜像不可用或校验失败时自动回退 GitHub 官方源；类型文件和二进制均按锁定的上游 SHA-256 校验。下载与校验流式进行，成功后才替换缓存，避免损坏文件被后续运行复用。

二进制缓存默认位于 `.studio/cache/electron/<版本>/`，CI 使用 runner 的持久缓存；可通过 `STUDIO_ELECTRON_CACHE_DIR` 指定缓存目录。设置 `electronMirror` 为空字符串可以使用官方源，也可以通过 `ELECTRON_MIRROR`（空字符串表示官方源）和 `ELECTRON_CUSTOM_DIR` 环境变量覆盖。无需为普通开发单独设置下载环境变量；直接调用上游目录的 `npm run electron` 会绕过 Studio 的下载策略，请使用 Studio 根目录入口。

完整 CI 的小助手测试依赖使用同一文件中的 `ciNpmMirror`，可通过 `STUDIO_TEST_REGISTRY` 覆盖。安装使用持久 pnpm store，安装及网络并发均为 1，并限制 Node 堆内存；镜像安装失败时回退官方 npm 源。`@steamharness` 新发布版本始终从官方源获取，避免镜像同步延迟影响验证。

升级时必须同步更新子模块提交、`config/upstream.json`、`.nvmrc` 与 CI Node 版本，并逐个检查补丁及两端运行结果。不要在有本地改动的上游目录直接强制切换版本。

VS Code OSS 遵循 [MIT License](upstream/vscode/LICENSE.txt)，版权和第三方声明保留在子模块中。Studio 自有代码尚未选择公开许可证。正式发布还需补齐应用图标、安装包、签名、更新渠道及发行说明。
