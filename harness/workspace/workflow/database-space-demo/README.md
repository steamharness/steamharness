# 聚合入口与共享知识库

一个 projectId 注册 writer 和 reader 两个 Workflow 入口，两者声明 `knowledgeBases: ["data"]`，引用根 config.json 中 `knowledgeBases.data` 的同一已授权知识库 ID。此示例演示知识文档共享；业务关系数据库使用独立的 `steamharness.database.ts`、schema、描述符与 Server binding。

先启动本地 Docker PostgreSQL 和 Server，通过 CLI 登录并创建、授权知识库，再执行本地入口。Server 管理数据与权限，不执行项目代码。

writer 的 `--action write --value Hello` 创建或更新知识文档；`--action read` 读取；`--action call` 通过 `context.entries.get("reader").runEntrypoint("main", ...)` 调用 reader。未配置、未授权或撤权后，数据访问失败，不自动创建资源或回退。

资源独立于项目生命周期。授权按账号、项目与入口校验；发布的资源引用本身不授予访问权。
