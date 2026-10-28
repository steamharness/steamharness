# Studio Control 入口规则

- 任务完成后提交并推送本次修改；用户指定目标分支时以用户要求为准。
- 本目录是小助手聚合项目的 `studio-control` Workflow 入口，不拥有独立项目身份、package.json 或发布单元；Studio 随小助手一起分发。
- 使用 Studio 注入的认证回环接口，只提供扩展宿主能实现的固定操作。禁止读取旧 Desktop 数据库、Electron 对象或任意执行 VS Code 命令。
- 宿主对每次操作校验工作区信任和会话登记状态，目录范围跟随小助手本轮 Permission：`auto` 可访问进程有权限的任意本地目录，`workspace` / `read-only` 校验登记目录及真实路径。权限由 MCP 子进程环境传递，不接受模型工具参数覆盖；会话结束必须关闭接口。令牌不得进入模型参数、编码工具 shell、日志或文件。
- 节点 payload 继承 `RunPayload`，成功使用 `errCode: 0, errMessage: ""`。
- 依赖、双语变更日志、测试和打包统一由上级小助手项目管理；未经授权不创建发布 tag、不发布资源、不部署。
- 行为变化同步中英文文档和 `CHANGELOG.next*.md`；代码变化补邻近测试。
- 在上级小助手目录执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage`、`pnpm build` 和 `git diff --check`。测试使用独立的宿主模拟和存储目录，不操作本机的窗口、焦点或剪贴板。
