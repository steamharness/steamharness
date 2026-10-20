# SteamHarness 工作站

Studio 通过项目自身的 CLI 在编辑器标签页中打开 Workflow、Conversation 和 Kanban。Electron 与浏览器工作站共用扩展；运行项目需要能够启动 Node 进程的扩展宿主。

## 打开项目

1. 在项目目录安装 `steamharness` 和支持 Web 宿主协议的 `@steamharness/cli`。
2. 在 Studio 中选择 **File > Open Folder**，打开项目文件夹。
3. 点击窗口顶部的 **运行项目** 按钮。
4. 在编辑器标签页中选择入口并运行，或向 Conversation 发送消息。

Studio 的 `examples/conversation` 提供不调用模型的本地演示。聚合 checkout 中的小助手位于 `../build-in/build-in-developer-assistant`。

打开聚合根目录时，活动栏中的 **Workflow 项目** 可用于选择项目。扫描覆盖当前文件夹、直接子目录及 `workspace`、`workflow`、`projects`、`examples` 容器，跳过依赖和生成目录。启动入口默认信任打开和后来加入的工作区文件夹。

文件变化和编辑器切换触发的自动刷新会防抖并合并重复请求。Explorer 的 **关联项目** 在窗口重新获得焦点时后台更新，同一项目刷新保留已有列表；项目树、资源和轨迹面板跳过未变化的内容，文档预览也不会因重复切换焦点而重新加载。手动刷新和实际变化仍会更新，过期结果不会覆盖当前项目。

## 显示语言

项目树、标签页、窗口标题、状态栏和资源面板中的项目名称按 VS Code 实际显示语言选择 `steamHarness.projectInfo.localizedNames.en` 或 `zh-CN`；缺少对应名称时使用 `package.json` 的 `name`。Information 仍完整列出项目声明的各语言名称。用户输入、会话标题、回答和日志保留原文。

Studio 将同一显示语言传入项目检查、CLI 启动和嵌入页面。开发源码模式可能在中文系统上回退到英文工作台，此时项目也使用英文。项目依赖需要包含 CLI Web 国际化支持，示例使用 `@steamharness/cli` 的当前稳定版。升级依赖后，已经运行的 CLI 进程需要关闭标签页后重开，或执行 **Developer: Reload Window**；切换 VS Code 显示语言也需要重载窗口。

## 项目界面

| 类型 | 当前行为 |
| --- | --- |
| `conversation` | 会话与历史、参数、附件、流式回答、输入队列、工具确认与续跑 |
| `workflow` | 入口与参数、一次运行一个任务、运行记录、结果与诊断 |
| `kanban` | 通过 CLI Web 打开静态产物、参数配置和页面数据 Bridge |

项目界面由 CLI 提供，Studio 负责标签页、主题、登录状态和进程生命周期。Conversation 的 assistant 主回答直接展示在正文中；工具调用、reasoning、诊断和显式折叠输出单独展示，响应元数据不会折叠主回答。

参数读取项目声明的 `params`、`paramLayout` 和 `paramResolver`，动态选项由项目的 `resolveParams` 返回。使用系统 AI 的项目需要有效的 SteamHarness Server 登录，或项目自身所需的服务配置。

底部 **KV**、**知识库** 面板读取项目 CLI 使用的存储。对话中的资源卡片可定位到这些面板，也支持对话内和独立窗口预览有权限的跨项目资源，见 [项目资源面板](resource-panel.md)。Workflow 和 Conversation 的 **轨迹** 面板提供运行记录、时间线、节点参数、结果和日志，见 [执行轨迹](trace-panel.md)。

Studio 小助手使用独立应用及其 Core/CLI 依赖，工具工作目录采用 VS Code 当前打开的文件夹。多文件夹工作区跟随活动文件所属的根目录，其余已打开的文件夹作为关联根；聚焦小助手或工作区外的文件时保留当前目录。切换文件夹前停止并保存旧会话，历史按文件夹分别保存；未打开文件夹时显示打开文件夹入口。Permission 默认 Auto approve，可访问进程有权限的所有本地目录；Studio 和 CLI Web 保留内置项目声明的默认值，已有会话沿用保存的权限选择。Workspace / Read only 保留登记工作区的目录限制，提示词与控制工具均跟随本轮选择。

VS Code 宿主提供源码工具、项目技能、全局记忆和资源卡能力，并通过 Studio Control MCP 提供编辑器状态、诊断、文件定位、主题、终端及视图控制。`get_related_projects` 查询指定项目的关联别名、UUID、名称、Studio 导入状态及核验后的目录；每次查询重新检查导入项目身份。旧 Desktop Control 已移除，Kanban 宿主配置和页面方法工具未接入。

## 运行与数据

Studio 从项目目录解析 `@steamharness/cli` 的 `steamharness` bin。项目识别使用 `web --inspect`；打开标签页时启动 `web --host-stdio`，通过受控 stdio 传入主题、账号和宿主配置。启动失败会显示项目依赖、CLI 构建或协议不兼容的错误。

更新项目依赖后，关闭并重新打开项目标签页即可加载当前安装的 CLI，包括 pnpm 更新后的包链接；已经运行的进程不会自动更换版本。卡片功能依赖项目自身的 CLI，跨项目预览与整行资源卡片需要 `@steamharness/cli` 0.1.0 或更高版本。

项目运行组件由项目依赖提供，扩展构建不再内置 Core/CLI。修改同级 Core 或 CLI 后，先构建相应仓库，再安装项目依赖；聚合仓库中 `build-in/` 下的开发分支内置项目通过 `link:../../harness` 和 `link:../../cli` 使用开源源码根中的构建。

数据保存在 Studio 的扩展数据目录，项目源码不承载工作站会话数据。关闭项目标签页会停止对应进程；重开读取保存的记录。未完成运行、等待输入和续跑遵循 CLI 的持久化规则。

内嵌页面中的正文与代码复制使用 VS Code 原生剪贴板，并等待宿主确认成功，避免 iframe 的浏览器剪贴板权限限制。独立浏览器运行页仍使用浏览器剪贴板。

机器级设置 `studio.project.nodePath` 可指定 Node；默认使用扩展宿主可用的 Node。**Workflow: 打开内置 CLI** 在原生终端中使用当前项目的 CLI。

## 服务器与登录

应用级设置 `studio.project.serverUrl` 选择 SteamHarness Server，项目配置不能覆盖该地址；变更服务器后需要重新登录。开发默认地址是 `http://localhost:7126`。

左下角头像打开 SteamHarness 账号弹层，展示头像、昵称、邮箱与服务器连接状态，提供个人信息、刷新账号资料和退出入口；未登录时提供登录入口。扩展账号授权仍可通过命令面板管理。工作站向 `/api/auth/login` 提交邮箱、密码及现有协议字段 `source: desktop`，然后通过 `/api/auth/me` 验证身份。这一认证来源字段不代表项目执行平台；CLI Web 的实际 runtime platform 是 `cli`。

对话回答的时长左侧显示项目头像，点击查看项目资料；用户消息右侧的账号头像打开账号入口。开始页项目头像可直接打开项目，信息面板头像可点击放大预览。最近项目和项目树中的头像沿用原有项目打开操作。

密码只用于当前请求。API Key 和登录会话 Cookie 使用 VS Code SecretStorage 保存，Webview 只接收公开账号资料；项目进程和 CLI 使用当前连接的 API Key。退出时停止相关运行并撤销本次凭据；临时连接失败时可在账号页重试验证。

Studio 打开的 Workflow、Conversation、Kanban 和小助手统一使用工作站账号。Studio 未登录或退出登录后，项目忽略独立 CLI 保存的账号和环境变量凭据；项目内的账号入口打开 Studio 账号页。独立运行 `steamharness web` 仍使用 CLI 的登录配置。项目 CLI 必须支持 `accountProtocolVersion: 1`；旧版本需要更新后再打开。

## 聚合与独立 checkout

聚合目录中的开发入口优先识别 Studio 同级的 Core 和 CLI。独立 checkout 保留同级 `../workflow` 布局。设置 `STUDIO_STEAMHARNESS_SOURCE` 可显式指定 Workflow 源码根目录。

首次准备工作站执行 `npm ci`、`npm run setup`、`npm run build`，然后使用 `npm run dev` 或 `npm run dev:web`。聚合根提供 `pnpm studio:dev` 和 `pnpm studio:web`。

## 验证入口

`npm run check` 执行扩展类型检查和离线单元测试；`npm run build:extension` 构建 Node 与浏览器扩展产物。这两项不启动工作站或真实模型服务。

`npm run test:project-language-ui` 在隔离的 Electron 窗口中验证中文系统下的英文工作台回退、中文宿主语言、各处项目名称与 Conversation 控件，并检查中文用户内容保持原文。截图和检查记录位于 `.studio/project-language/`。

`npm run test:desktop`、`test:conversation-ui`、`test:workflow-desktop-ui`、`test:kanban-desktop-ui`、`test:resources-ui` 和 `test:trace-ui` 启动 Electron 或浏览器进行交互检查。`test:conversation-server-ui` 还依赖可用的 Server 和模型服务，运行前应确认对应环境与授权。
