# Unreleased

- 【破坏性变更】项目改用根 projectId 与 entries/defaultEntry 聚合入口，支持同类型多入口、逐入口配置和执行隔离。跨入口调用继承身份与取消信号并重新校验权限。

- 【改进】参数支持 `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`：固定跟随时只显示系统当前权限并打开用户设置；可覆盖时保留三个权限选项，以系统值为默认，重置后继续跟随。继承状态与项目覆盖分别保存，现有任务保持原权限。

- 【新增】公开用户设置快照 API `getUserSettings`、`withUserSettings` 与宿主校验 `parseUserSettings`，隔离并发执行并复制冻结设置。Agent 显式 `permissionPolicy: "inherit"` 继承用户权限，无宿主时回退 `auto`；未配置仍默认 `workspace`，本轮输入优先，工具与路径范围使用同一有效值。
