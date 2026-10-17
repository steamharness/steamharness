# Docker 与部署规则

- 任务完成后，必须将本次任务产生的全部更改提交并推送到远程。若当前位于附加 Git worktree，必须新建任务分支，并在该 worktree 后续任务中持续提交并推送到该分支；若当前分支是 `dev`，直接提交并推送到 `dev`；若仓库仅维护 `main`，直接提交并推送到 `main`。用户另有目标分支、提交或推送要求时，以用户要求为准。
- 修改 `docker/**`、部署脚本、生产环境变量、构建或发布流程前，先读取根 [AGENTS.md](../AGENTS.md) 和本文件。
- 部署、连接、环境变量、端口、日志或回滚行为变化需要同步 `../../docs/guides/server/**`；影响 CLI 发布、上传或运行时同步 `../../docs/cli/workspace/**`。
- Docker 与部署配置不是独立版本单元。面向用户的部署变化归入根目录 Server 的双语 next 日志；同时影响管理端或公开 Embed 时也更新 `web/CHANGELOG.next*.md`。
- 镜像、Compose 与部署脚本只能读取已准备的 Server/Server Web 版本和构建产物，不维护手写版本常量，也不在构建阶段修改 package.json。
- 发布脚本必须允许相同 tag 安全重试；部署健康验证成功前不能更新稳定发布身份。
- Docker 的真实 `.env` 只能保留在部署主机并由 Git 忽略；GitLab 正式 job 使用 `production` 环境的受保护 CI/CD Variables，Compose 直接读取 job 进程环境，不生成或提交生产 env 文件。
- Workflow PostgreSQL 只允许绑定回环地址，恢复流程不得停止 Docker Desktop，也不得修改其他服务的数据目录。
