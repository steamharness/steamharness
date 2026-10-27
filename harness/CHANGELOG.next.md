# Unreleased

- 【新增】用户设置支持模型列表，Agent 节点与直接调用可免连接配置运行；支持显式选择用户或旧项目来源，模型参数默认跟随且允许覆盖，始终执行系统 AI 来源及授权限制。

- 【改进】参数支持 `userSetting: { key: "agent.permissionPolicy", mode: "fixed" | "default" }`：固定跟随时只显示系统当前权限并打开用户设置；可覆盖时保留三个权限选项，以系统值为默认，重置后继续跟随。继承状态与项目覆盖分别保存，现有任务保持原权限。

- 【新增】公开用户设置快照 API `getUserSettings`、`withUserSettings` 与宿主校验 `parseUserSettings`，隔离并发执行并复制冻结设置。Agent 显式 `permissionPolicy: "inherit"` 继承用户权限，无宿主时回退 `auto`；未配置仍默认 `workspace`，本轮输入优先，工具与路径范围使用同一有效值。
