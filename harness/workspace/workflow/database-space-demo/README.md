# 聚合入口与共享空间

一个 projectId 注册 `writer` 和 `reader` 两个 Workflow 入口，二者使用根 `config.json` 中同一 `data` 映射。入口身份与内部操作 `main` 分开传递。

使用 `steamharness web .` 启动后，在数据库管理中为 writer 申请新 local 空间并由本机宿主显式批准、绑定。reader 再申请访问同一空间，批准、绑定后两者共享 KV 和知识库。选择 Server 宿主即可走 Server 审批：新空间由系统管理员批准，共享由空间负责人或系统管理员批准。

`--action write --value Hello` 使用事务写入 KV 和知识文档；`--action read` 读取；writer 的 `--action call` 通过 `context.entries.get("reader").runEntrypoint("main", ...)` 调用 reader。未批准、未绑定或撤销后，数据访问失败，不会隐式创建空间。

空间独立于项目生命周期。另一个 projectId 可以申请访问同一空间；会话命名空间继续按 projectId 和 entryId 隔离。发布或上传保留 config.json 中的 alias/databaseId 映射；权限由宿主维护，引用本身不授予访问权。
