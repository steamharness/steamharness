# Changelog

本发布单元的所有重要公开变更均记录于此。

## 0.1.1 - 2026-07-29

### 新特性

- **健康检查暴露版本信息**：`/health` 返回 Server、内置 Core、当前更新摘要和对应 Docs 入口。
- **运行记录固化 Core 版本**：记录项目要求、构建和实际运行时的 Core 与 Server 版本。

### 新增

- 新增 `/health` 返回 Server 版本、内置 Core 版本、当前更新摘要和对应 Docs 入口。
- 新增 托管版本与运行记录记录项目要求、构建和实际运行时的 Core 与 Server 版本。

### 变更

- 变更 上传、编辑、复制、预览和运行 Workflow 时按项目的精确 Core 依赖计算兼容性。

### 修复

- 修复 无法识别 Core 版本的旧托管版本按猜测的兼容范围运行，现在标记为 unknown 并下线。
- 修复 `/health` 在发布元数据滞后或部署回滚时报告错误的 Server/Core 版本。
- 修复 暂时性对象存储故障导致旧 Workflow Core 元数据迁移永久下线版本。

## 0.1.2 - 2026-07-29

### 修复

- 修复 生产构建产物引用未编译的 runtime-compatibility TypeScript 源码导致 Server 无法启动。

## 0.1.3 - 2026-07-30

### 新特性

- **Kanban 托管与预览**：支持草稿、版本、静态资源托管和 Studio/Embed 预览，并提供用户隔离的命名配置。
- **本地部署发布**：Server 与 Docs 可在部署主机本地完成发布，不再要求通过 SSH 回连同一主机。

### 新增

- 新增 Kanban 草稿、版本、静态资源托管和 Studio/Embed 预览，含用户隔离的命名配置。
- 新增 受限 KV 与知识库 Bridge，授权范围由宿主按项目隔离。

### 变更

- 变更 Kanban 上传准备只校验已构建静态产物，不安装依赖或启动 Workflow runtime。
- 变更 发布版本保留 Kanban 的完整静态资源。
- 变更 上传、归档复制和运行前统一使用宿主 Core 版本校验项目兼容性。

## 0.1.4 - 2026-08-07

### 新特性

- **运行语言随请求注入**：第一方 API 读取 `X-SteamHarness-Locale`，为管理端、Embed、Webhook 和参数解析注入运行语言。
- **按版本授权的只读 KV 数据源**：Kanban Studio 与 Embed 经鉴权 revision SSE 自动刷新，权限撤销后立即失效。
- **Workflow 定时任务**：支持固定版本和入口的计划、常用时间规则、立即运行及 fire 历史。

### 新增

- 新增 第一方 API 返回对应语言的错误、健康检查摘要和独立 Server 发布日志地址。
- 新增 管理、Embed、External、streaming、参数解析和 Webhook API 选择 Workflow 入口并保存入口快照。
- 新增 上述 API 在入队或发送流式响应头前拒绝无效入口。
- 新增 Kanban Studio 与 Embed 按精确版本和 key 前缀授权的只读 Workflow KV 数据源。
- 新增 Kanban 项目组的精确依赖锁、断点续跑部署、部分源码下载、源码申请和前缀级数据授权。
- 新增 项目组拒绝传输 KV、计划、运行历史、环境变量及客户端凭据。

### 变更

- 变更 调度器通过唯一 fire、lease、权限复核和优雅停机避免多实例重复执行。
- 变更 存在活跃 fire 时禁止修改或删除计划。
- 变更 Kanban revision stream 合并突发更新、保持 PostgreSQL 重连顺序，来源不可用时统一关闭。
- 变更 Server 收到 revision stream 完成信号后可正常退出。

### 修复

- 修复 云端 Kanban 子资源被登录鉴权返回 401 或并发物化源码返回 500 导致白屏；短期 capability 限定项目和有效期。
- 修复 远程运行流式数据在分段边界处偶发损坏中文及其它多字节字符。
- 修复 `source` 模式 Kanban 在公开 Embed 中被误判为不存在。
- 修复 PostgreSQL 用户首次打开 Embed 时默认配置初始化失败。
- 修复 Workflow runtime 把开发工具和 pnpm 符号链接写入归档，导致已发布版本无法从对象存储加载。

## 0.1.8 - 2026-08-26

### 新特性

- **Alpha 独立部署链路**：与正式版共用 PostgreSQL 和 OSS bucket，隔离代码、进程、日志与缓存，运行在 `7140` 端口。参见 [部署](../docs/guides/server/deployment.mdx)。
- **按发行目标解析版本**：每个版本固化 Server、macOS 和 Windows 目标，运行与计划任务只解析具备兼容 runtime 的在线版本。
- **项目展示元数据**：项目可保存默认名称、本地化名称、手工声明和展示平台。参见 [项目管理](../docs/guides/server/project-management.mdx)。

### 破坏性变更

- Server 仅允许 `dataStorage.mode` 为 `server` 或 `both` 的项目运行和访问服务器数据。
  迁移：`local` 或未声明存储的项目需改为 `server` 或 `both`，否则所有入口统一返回 `409`。
- Core 与 CLI 精确依赖升级到 `0.2.0`，PersistentValue API 强制携带 `projectId`。
  迁移：非 global 的 namespace、entry 和 source 必须把 `projectName` 设为项目 ID。
- Server 已完整移除 Supabase，账号、会话和邀请改用原生 PostgreSQL。
  迁移：账号数据需要一次性迁移到 Server 自有的 PostgreSQL 库。
- Desktop 登录与运行来源统一使用 `desktop`，旧 `app` 来源不再接受。
  迁移：把调用方的来源标识改为 `desktop`。

### 新增

- 新增 云端项目创建原子接收 UUID 和完整 `projectInfo`，Desktop 可按同 UUID 创建或恢复绑定。
- 新增 项目默认名称、本地化名称、手工声明和展示平台，经项目列表与 `PUT /api/projects/{id}/project-info` 提供。
- 新增 每个版本固化 Server、macOS 和 Windows 发行目标，仅本地版本跳过依赖安装与 runtime 构建。
- 新增 源码与项目组下载按 macOS/Windows 发行目标校验并独立解析平台 `latest`。
- 新增 Alpha 部署链路与正式版共用数据库和 bucket，隔离代码、进程、日志和本地缓存。

### 变更

- 变更 Desktop 安装包、更新 feed 与内置项目资源迁移到阿里云 OSS。
- 变更 Alpha Server 默认关闭计划任务自动轮询，计划管理与手动立即运行仍可用。
- 变更 项目兼容性要求精确声明 Core，只比较 `major.minor` 兼容线，major 或 minor 变化会阻断执行。
- 变更 生产凭据改由受保护的 GitLab CI/CD Variables 注入，开发 `.env` 仅保留在本机。

### 修复

- 修复 恢复任务未配置 Docker Socket 路径时改用 `/var/run/docker.sock`，确保 Alpha 能启动 PostgreSQL。
- 修复 内置项目的可变发布索引强制客户端重新验证，带版本的资源包改用长期不可变缓存。

### 移除

- 移除 Server 的本机下载服务启动、恢复与配置。

## 0.1.9 - 2026-09-01

### 新特性

- **Workflow 标准 MCP 入口**：Streamable HTTP 暴露 entrypoint 为 tools，复用运行队列、持久化与审计体系。参见 [MCP](../docs/guides/server/mcp.mdx)。
- **Conversation OpenAI 网关**：Bearer-only `/v1` 提供 Responses、Conversations 和 Models 子集，项目 Key 隔离资源。参见 [OpenAI Responses](../docs/guides/openai-responses.mdx)。
- **关联项目 KV 授权**：支持双方确认、单边待确认与读写全量或前缀授权，权限撤销立即生效。

### 破坏性变更

- 全局 KV、旧 `workflow` scope、`kv.workflow`、`persistentValue.workflow` 和独立数据授权已移除。
  迁移：KV 与 PersistentValue 只保留项目和会话作用域，并按存储类型强制隔离。

### 新增

- 新增 Workflow 项目标准 Streamable HTTP MCP 入口，用账户 API Key 或管理员 Key 鉴权。
- 新增 Conversation 的 Bearer-only OpenAI Responses 网关与项目 Key 管理，按用户和项目隔离资源。
- 新增 `wfpk_*` 完整 Key 仅在创建或轮换后显示一次，旧 Key 轮换或吊销后立即失效。
- 新增 OpenAI Responses 调用开始即写入项目运行记录，并在完成、失败、取消或重启后原位更新终态。
- 新增 当前项目与关联项目的 KV 读取、写入和 compare-and-set API，按双方最新声明逐次授权。
- 新增 项目存储、revision 和关联项目依赖表，旧表、函数和视图按原样保留不做修改。

### 变更

- 变更 Kanban Bridge、项目组依赖锁、下载与发布统一从已确认的关联项目生成。
- 变更 OpenAI Responses 网关把输出上限与内容过滤终态返回为 `incomplete` 并保留部分输出。
- 变更 删除 Conversation 不再连带删除 Items，图片引用通过事务锁避免误删仍在使用的文件。
- 变更 持久化的 `incomplete` Response 可通过 `previous_response_id` 继续。

### 修复

- 修复 生产构建内联 OpenAI Responses Shared 运行时，不再把 TypeScript-only 包留在部署依赖中。
- 修复 MCP 表单 elicitation 返回非法内容、传输或恢复失败时终止等待中的运行，不再遗留 `waiting_for_input`。
- 修复 OpenAI 调用信息只接受 `STEAMHARNESS_API_PUBLIC_BASE_URL` 或受信任代理的转发地址。
- 修复 图片批量保存失败返回明确校验错误并回收部分文件。
- 修复 网关可接收 `system` / `developer` 消息、`text.verbosity` 和兼容性 `include` 参数。

## 0.1.10 - 2026-09-05

### 新特性

- **本地执行模式**：`pnpm dev` / `pnpm start:local` 默认在本机跑云端 Workflow，无需 Runner 或容器构建。参见 [部署](../docs/guides/server/deployment.mdx)。
- **关联项目跨服务调用**：运行容器可读目标项目知识库并调用其入口，调用方以发起者身份执行。参见 [项目管理](../docs/guides/server/project-management.mdx)。
- **项目 KV 条目删除**：新增 `DELETE /api/projects/:name/kv/entry`，按 scope 与 key 删除单条项目 KV。

### 破坏性变更

- 移除公开 Embed 的 HTTP 接口与 `server-live` 中继发布单元，`embed.manage` 权限从目录删除。
  迁移：浏览器中的运行改由 Desktop 首页的 Web 构建承担，管理端只负责管理云端项目。
- Server 执行面已移除本机依赖安装、构建、Node 子进程和本机回退。
  迁移：项目版本必须由远程 Runner 按固定 Core、Runtime Protocol、架构和 OCI digest 构建与运行。
- `listProjects` 不再接受 `origin` 参数，项目摘要不再返回 `embedEnabled` 与 `embedPublicUrl`。
  迁移：调用方改用项目列表默认字段，不再依赖 Embed 开关。
- 匿名访问 `/web` 先跳登录页并在登录后回跳，`?next=` 只接受路由名而非任意路径。
  迁移：不要把绝对路径放进 `next`，否则会被拒绝以避免开放重定向。

### 新增

- 新增 持久化 Runner 池、节点、租约、任务顺序事件、制品和 Runtime capability 控制面。
- 新增 节点通过出站 HTTPS 注册、续租和领取任务，项目容器不获得数据库或管理凭据。
- 新增 Runtime 的 KV、PersistentValue、关联项目和文件 API，令牌按项目、用户、任务与截止时间绑定。
- 新增 运行记录支持重命名与删除，仅项目管理员或运行发起者可操作。
- 新增 运行记录提供展示名与稳定 `cardId`，嵌入卡片不再随滚动反复创建 DOM。
- 新增 本机对象存储驱动，`STEAMHARNESS_STORAGE_DRIVER=local` 后制品与头像写入本机磁盘。
- 新增 未配置任何 OSS 凭据也能启动，头像改由只读的 `/storage/avatars` 提供。
- 新增 ECS 部署的 wflive 中继，Stable 与 Alpha 各自监听 7150 与 7151。
- 新增 `POST /api/project-storage` 的 `delete` 操作，条目不存在时返回 `{ removed: false }`。
- 新增 权限目录 `kv.manage`，Developer 内置角色默认拥有，Operator 与 Viewer 保持只读。
- 新增 Workflow 入口结构透传可选分组元数据，供公开 Embed 按分区展示。

### 变更

- 变更 `server:start` 保留源码模式和开发端口但关闭后端监听与 Web 热刷新，`server:dev` 继续热刷新。
- 变更 关联项目的知识库与入口调用要求目标项目显式授权，访问逐 key 判定。
- 变更 调用目标入口以发起者身份真实执行一次运行，被调项目自身不再获得关联访问。
- 变更 `STEAMHARNESS_OSS_ENDPOINT` 可指向同地域内网端点，但签名 URL 始终按公网端点签发。

### 修复

- 修复 Runner 制品上传不再被 OSS 客户端 60 秒默认超时截断，请求预算提升到 5 分钟。
- 修复 本地执行以发起运行的用户身份访问 Server，签发 6 小时有效的运行专用 key。
- 修复 本地执行的子进程环境改为白名单构造，数据库、OSS 凭据与密钥不交给项目代码。
- 修复 关联项目的嵌套运行无法向外继续访问，无法核验发起记录时按 `503` 拒绝。
- 修复 服务端按文档 key 校验关联项目的知识库写入，不再整次修改绕过逐 key 检查。
- 修复 `/related/run` 把嵌套运行的失败连同状态和错误码交回调用方，不再变成请求级错误。
- 修复 关联项目的入口列表按 `latest` 采样，与 `runEntrypoint` 实际运行的版本一致。

### 移除

- 移除 `GET/PUT /api/projects/{projectId}/embed` 与全部 `/embed/**` 路由。
- 移除 `wfembed` 域名与 `STEAMHARNESS_EMBED_PUBLIC_BASE_URL`；`project_embed_configs` 表按 expand-only 保留。
- 移除 Server Web 的 `/web` 入口页及其可运行版本列表与 `next=web` 回跳。
- 移除 `server-live` 发布单元、`/api/desktop/v1/*` 与 `/api/web-runs/*` 路由和 `web` 发行目标。
