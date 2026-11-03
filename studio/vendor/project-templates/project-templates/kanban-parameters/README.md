# __PROJECT_TITLE__

Tasks are stored as relational `Task` rows, separated by configuration ID. The page requires an authenticated SteamHarness Server connection; failed reads block edits and concurrent writes use row versions. Multi-row edits are separate operations.

1. Install dependencies, then run `pnpm exec steamharness database generate`.
2. Explicitly create a database with `steamharness database create`, bind alias `data` using `database bind --help`, and run `database migrate dev --help` to apply the schema.
3. Run `pnpm build`, then `pnpm dev`.

任务存储为关系型 `Task` 表，按配置 ID 区分。先申请数据库、在 Server 绑定 `data`、执行迁移，再构建运行。页面要求 Server 和 PostgreSQL 可达；连接失败时禁止编辑，更新使用行版本检查。不会自动申请数据库或回退本地存储。
