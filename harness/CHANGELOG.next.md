# Unreleased

- 【新增】Core Agent 内置小助手参数，defineExecutor 自动继承参数与模型解析；支持字段定制、隐藏、禁用、固定值和分组，以及业务 workflow 的 coreAgent 引用。输入 helper 支持 ExecutorContext，静态结构报告共用同一参数契约。

- 【修复】受限项目配置的在线角色查询允许最多 30 秒，避免远程数据库较慢时把有效开发者或所有者误判为访客；查询失败仍撤销提升权限。

- 【破坏性变更】入口数据库清单只列别名字符串，根 config.json 集中记录别名与 databaseId，支持多库和跨项目、入口共享；Core 按别名解析，权限完全由宿主管理，发行保留 ID 引用，拒绝旧声明字段。

- 【改进】默认 Conversation 参数将模型与 effort 拆为两个独立 Quick 入口；用户模型快照支持完整宿主内置目录，同时保留 100 个自定义模型限制及全局唯一 ID 校验。

- 【修复】普通 Agent 的自动用户模型参数保留继承关系，直接调用正确加载显式项目模型；模型连接与继承权限使用同一宿主快照，缓存连接保留开发者模型属性与系统搜索限制，模型 ID `inherit` 可正常选择。

- 【新增】用户设置支持模型列表，Agent 节点与直接调用可免连接配置运行；支持显式选择用户或旧项目来源，模型参数默认跟随且允许覆盖，始终执行系统 AI 来源及授权限制。
- 【修复】多个入口同时绑定数据库时串行更新项目声明，保留全部绑定和其他字段；申请忽略伪造的审批记录与绑定引用，防止暴露其他空间的授权信息。

- 【破坏性变更】项目改用根 projectId 与 entries/defaultEntry 聚合入口，支持同类型多入口、逐入口配置和执行隔离。跨入口调用继承身份与取消信号并重新校验权限。

- 【改进】参数支持 `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`：固定跟随时只显示系统当前权限并打开用户设置；可覆盖时保留三个权限选项，以系统值为默认，重置后继续跟随。继承状态与项目覆盖分别保存，现有任务保持原权限。

- 【新增】公开用户设置快照 API `getUserSettings`、`withUserSettings` 与宿主校验 `parseUserSettings`，隔离并发执行并复制冻结设置。Agent 显式 `permissionPolicy: "inherit"` 继承用户权限，无宿主时回退 `auto`；未配置仍默认 `workspace`，本轮输入优先，工具与路径范围使用同一有效值。

- 项目部署配置统一放在根 config.json，集中维护数据库别名和 ID，各入口在 package.json 中仅声明使用的数据库别名；STEAMHARNESS_PROJECT_CONFIG 可覆盖部署值。迁移只改一处 ID，权限继续由宿主维护，发行不写入环境覆盖值。
