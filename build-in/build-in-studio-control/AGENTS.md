# Studio Control 内置项目规则

- 任务完成后提交并推送本次修改；用户指定目标分支时以用户要求为准。
- 本仓只维护 Studio Control 内置 Workflow，位于 monorepo 的 `build-in/build-in-studio-control`；Studio 构建时直接从该目录读取源码。
- 使用 Studio 注入的认证回环接口，只提供扩展宿主能实现的固定操作。禁止读取旧 Desktop 数据库、Electron 对象或任意执行 VS Code 命令。
- 宿主对每次操作校验工作区信任和会话登记状态，目录范围跟随小助手本轮 Permission：`auto` 可访问进程有权限的任意本地目录，`workspace` / `read-only` 校验登记目录及真实路径。权限由 MCP 子进程环境传递，不接受模型工具参数覆盖；会话结束必须关闭接口。令牌不得进入模型参数、编码工具 shell、日志或文件。
- 节点 payload 继承 `WorkflowPayload`，成功使用 `errCode: 0, errMessage: ""`。
- 开发依赖使用 `link:../../harness` / `link:../../cli`；发布分支仍遵循共享发布门禁，未经授权不创建发布 tag、不发布资源、不部署。
- 行为变化同步中英文文档和 `CHANGELOG.next*.md`；代码变化补邻近测试。
- 提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage`、`pnpm build` 和 `git diff --check`。测试使用独立的宿主模拟和存储目录，不操作本机的窗口、焦点或剪贴板。
