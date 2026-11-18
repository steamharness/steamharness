# Developer Assistant 内置项目规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- monorepo 内用 `link:../../harness` / `link:../../cli` 引用源码。增强版 Studio 打包时从固定的源码提交生成 Core、CLI 归档，内置 Assistant 从同一对归档安装；这条路径不检查 npm，也不要求先独立发布 Assistant。独立构建和分发内置项目制品仍用 `scripts/builtin-release.mjs`：该脚本在发布模式下要求清单声明精确的运行时版本，其规则不适用于随 Studio 捆绑的 Assistant。
- Issue 编号仅作为可选上下文；没有 issue 也可以直接分析、修改、测试、提交和说明，不得把创建或关联 issue 作为强制前置条件。
- 本仓库只维护 `developer-assistant` 内置项目，项目根注册 `main` Bot 与 `studio-control` Workflow 两个入口；Studio Control 源码和专项规则位于 `studio-control/`；不得再引用旧 monorepo 内置项目目录或其它仓库内部路径。
- `skills/steamharness-generator/AGENTS.md` 是 generator 专项规则入口；修改该目录前必须同时读取它。
- 节点 payload 必须继承 `RunPayload`，成功时使用 `errCode: 0, errMessage: ""`。
- Studio 开发态从同级 `build-in/build-in-developer-assistant` 获取本项目依赖；VS Code 宿主通过 `STEAMHARNESS_DEVELOPER_ASSISTANT_HOST=vscode` 使用已有适配。宿主注入 `STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER` 时通过本项目的 `mcp --entry studio-control` 连接内置控制入口，使用现有工具权限和审批；不读取旧 Desktop Control 配置。原始控制凭据只传给 MCP 子进程，不进入编码工具 shell。
- 用户可见变化写入 `../../docs/guides/releases/builtin-developer-assistant/unreleased.mdx` 和对应英文镜像；发版前按产品版本定版。
- 代码变更必须补邻近 `__tests__/` 或 `scripts/__tests__/` 测试。提交前执行 `pnpm typecheck`、`pnpm test`、`pnpm coverage`、`pnpm build` 和 `git diff --check`。
- 独立制品保留两条通道：正式通道的 tag 是 `builtin-developer-assistant/vX.Y.Z`、索引与资源在 `builtin-projects/developer-assistant/…`；Alpha 通道的 tag 是 `builtin-developer-assistant/alpha/vX.Y.Z`、索引与资源在 `builtin-projects/developer-assistant/alpha/…`。构建时显式指定通道，不按分支推断。转正时要重新构建正式通道制品，因为 `builtinRelease` 写入产物；版本号与双语定版页不需要再次定版。
- 项目版本唯一来源是 `steamharness.json`；`release:prepare` 校验对应双语定版页并更新项目版本。`release:build` 和 `release:assemble` 生成 schema v2 索引和 `all/all` 通用资源。现有 monorepo GitHub 工作流不会因为创建内置项目 tag 自动发布独立制品。
