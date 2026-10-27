# Unreleased

- 【新增】公开用户设置快照 API `getUserSettings`、`withUserSettings` 与宿主校验 `parseUserSettings`，隔离并发执行并复制冻结设置。Agent 显式 `permissionPolicy: "inherit"` 继承用户权限，无宿主时回退 `auto`；未配置仍默认 `workspace`，本轮输入优先，工具与路径范围使用同一有效值。
