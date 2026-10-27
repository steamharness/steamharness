# Unreleased

- 【改进】默认 Conversation 参数将模型与 effort 拆为两个独立 Quick 入口；用户模型快照支持完整宿主内置目录，同时保留 100 个自定义模型限制及全局唯一 ID 校验。

- 【修复】普通 Agent 的自动用户模型参数保留继承关系，直接调用正确加载显式项目模型；模型连接与继承权限使用同一宿主快照，缓存连接保留开发者模型属性与系统搜索限制，模型 ID `inherit` 可正常选择。

- 【新增】用户设置支持模型列表，Agent 节点与直接调用可免连接配置运行；支持显式选择用户或旧项目来源，模型参数默认跟随且允许覆盖，始终执行系统 AI 来源及授权限制。

- 【改进】参数支持 `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`：固定跟随时只显示系统当前权限并打开用户设置；可覆盖时保留三个权限选项，以系统值为默认，重置后继续跟随。继承状态与项目覆盖分别保存，现有任务保持原权限。

- 【新增】公开用户设置快照 API `getUserSettings`、`withUserSettings` 与宿主校验 `parseUserSettings`，隔离并发执行并复制冻结设置。Agent 显式 `permissionPolicy: "inherit"` 继承用户权限，无宿主时回退 `auto`；未配置仍默认 `workspace`，本轮输入优先，工具与路径范围使用同一有效值。
