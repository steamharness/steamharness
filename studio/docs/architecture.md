# 工作站架构

## 共用底座

Studio 使用 VS Code OSS 的工作台、Monaco 编辑器、语言服务、扩展宿主、终端、任务和调试体系。Electron 提供桌面宿主；上游 Web Server 提供浏览器入口及服务器端文件、终端和扩展宿主。

两端入口是 `npm run dev` 与 `npm run dev:web`。开发输出共用 `upstream/vscode/out`，用户数据分别保存在 `.studio/desktop-*` 与 `.studio/web-*`。

## 定制分层

| 需求 | 维护位置 |
| --- | --- |
| 名称、协议、系统标识、扩展市场、遥测 | `config/product.json` |
| 项目入口、命令、树视图及业务集成 | `extensions/studio-workstation` |
| 简体中文界面 | 官方扩展 `MS-CEINTL.vscode-language-pack-zh-hans` |
| 编辑器布局、原生服务、核心 API 修改 | `upstream/vscode/src`，日常提交到 fork 的 `steamharness-dev` 分支，测试与正式通道使用 `steamharness-alpha`、`steamharness-main`；对应补丁保留在 `patches` |
| 构建和启动流程 | `scripts` |
| 上游版本 | 子模块 Git 提交与 `config/upstream.json` |

工作站扩展通过链接挂载为 `upstream/vscode/extensions/studio-workstation`，让开发运行和后续内置扩展打包都能发现它。扩展依赖 `vscode` API，由宿主提供；浏览器包不能引入 Node 原生模块。

根项目将 VS Code 类型包安装为 `vscode-api` 别名，并在扩展 `tsconfig.json` 中显式映射。不要在根项目安装自动加载的 `@types/vscode`，它会沿父目录进入上游编译，与上游自身的 `vscode.d.ts` 冲突。

最近项目使用扩展自身的 `globalState` 保存，记录 URI、名称、类型和打开时间。允许本地及远程文件 URI；命令和网络 URL 不作为项目入口。记录采用串行更新，避免同一扩展宿主中的异步写入互相覆盖。

开始工作台通过原生 `StudioStartView` 共用空编辑器组、Untitled overlay 和可序列化的 Start EditorPane。版本化 `StudioStartState` 从工作站扩展提供模板、扫描结果、最近项目、账户、环境和 Analysis 摘要；可见实例统一管理 5 秒轮询，变化防抖并忽略过期读取。Untitled 只在可编辑、非 diff、空文档下覆盖显示，输入仍由 Monaco 处理。

模板唯一来源在 CLI 的 `src/project-templates.ts` 与 `src/project-templates/catalog.json`。Studio 的 `vendor/project-templates` 保存独立构建副本，修改后执行 `node scripts/sync-project-templates.mjs`；聚合检出的单元测试检查副本一致性。构建将模块、清单和资源复制到扩展 `dist`，精确 Core/CLI 版本复用已验证的 `examples/conversation/package.json`。创建目录前选择新窗口或当前窗口，取消不写入项目；目录独占创建后先保存安装交接请求，再使用对应的 `forceNewWindow` / `forceReuseWindow` 打开。目标窗口激活时匹配唯一工作区根目录并校验 UUID，在受信任工作区消费请求后安装；失败、取消或重载不会重新自动安装。`project-window.ts` 统一最近项目、文件夹/工作区、聚合入口、下载/导入和资源卡片的窗口选择；重试在目标项目窗口执行，从其他窗口重试时先选择并打开项目窗口，取消不更新安装交接请求。成功后刷新当前窗口的项目列表，不额外打开窗口。

内核补丁 `0034-studio-project-window-choice.patch` 覆盖原生 File 菜单、Ctrl+R、系统最近项目和 Web 工作站。普通项目打开先选择目标窗口；显式的 `forceNewWindow` / `forceReuseWindow` 继续直接执行，避免扩展已选择后重复询问。添加/移除工作区目录和普通文件编辑保留原行为。取消原生最近项目的窗口选择时保留最近记录，启动恢复仍使用原来的恢复路径。

`npm run test:start-ui` 在隔离数据目录启动 Web 工作台和 `headless: true` 浏览器，覆盖两个入口、输入/DOM 粘贴、撤销、分栏、恢复、语言、主题与真实项目入口。它不启动 Electron，不访问系统剪贴板。

测试默认使用上游 Playwright 配套的 Chromium headless shell，可先执行 `node upstream/vscode/node_modules/playwright/cli.js install chromium --only-shell` 安装。已有缓存可通过 `STUDIO_START_TEST_BROWSER_PATH` 指定可执行文件；`STUDIO_START_TEST_BROWSER` 可选择浏览器 channel。

语言支持沿用上游流程，简体中文通过官方语言包扩展提供。Studio 自有扩展支持中英文，并跟随宿主显示语言。

Accounts 活动入口通过 `IProductService.showAccounts` 控制，两端的活动栏、顶部栏及恢复菜单使用同一开关。此开关只控制工作台账号入口。

## 可重现与保护

准备脚本先核对上游 HEAD，从固定提交读取原始产品配置，再合并品牌配置。开发期 `product.overrides.json` 同时传入 Web 品牌、扩展市场和上游版本，避免浏览器使用上游占位产品信息。脚本记录生成内容的 SHA-256，拒绝覆盖手动修改的配置，并拒绝替换非本项目管理的扩展目录。补丁先检查正向或反向是否可应用，冲突时保留本地源码并停止。

内核定制和当前品牌配置已提交到 fork，子模块与版本锁固定到同一提交。品牌配置和工作站扩展源码继续维护在根项目；准备脚本生成的扩展链接被子模块忽略。后续修改品牌配置或新增补丁时，子模块可能出现已修改状态，提交内核后需同步更新根项目引用。

## 后续开发方向

AI 助手、创作资源、工作流编排等可以先以独立扩展加入，再按需要定义跨扩展协议或内核服务。当前没有预设业务后端、模型提供商、账号系统或数据库；这些选型可以围绕具体工作站场景决定。

桌面打包需要平台图标、签名和更新服务。Web 发布需要部署方式、鉴权、反向代理与文件权限设计。框架 CI 和开发转译构建不作为这些发布能力的验证。
