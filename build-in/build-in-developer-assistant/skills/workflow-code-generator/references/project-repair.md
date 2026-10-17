# 项目降级与关联修复

在 Desktop 把疑似 Workflow Code 项目显示为普通文件夹、旧版项目升级失败，或修复需要修改关联项目时使用本流程。

## 必需知识门禁

- 本文件是项目降级修复的必需引用。必须完整读取后才能修改文件或运行修复命令。
- 如果本文件缺失、读取被拒绝或内容不完整，立即停止修复并报告具体读取失败；不得继续编辑、转向其它优化，或把任何检查结果描述为项目已修复。
- 项目目录内的旧版 CLI 可能尚未校验当前 `projectInfo` 合同。其 `structure` 命令返回成功只能作为结构分析结果，不能替代下方字段白名单、Desktop 重新识别或关联授权验证。

## 先判断当前授权状态

1. 读取系统提示词中的可信 `workspace_context`，以 `primaryTarget.kind` 和 `roots[]` 为准，不以磁盘目录结构推断权限。
2. `primaryTarget.kind: "folder"` 表示 Desktop 当前只授予普通文件夹能力。检查根目录的 `package.json`、Kanban HTML 入口或 executor 源码，判断它是普通目录还是校验失败后降级的项目。
3. 只修改 `roots[]` 中列出的目录。未列出的关联项目即使路径已知、位于相邻目录或被 README 提及，也不得读取、搜索或修改。

## 阶段一：修复当前根

1. 读取本地 `AGENTS.md`、Git 状态和现有 package/lockfile；非 Git 目录不要伪造提交要求。
2. 用结构化 JSON 解析 `package.json`，确认顶层 UUID、版本、项目类型、入口、精确 Core/CLI 依赖和 `projectInfo`。
3. 迁移当前根内的旧字段、源码和文档。不要为了等待关联项目而跳过当前根本可完成的修复。
4. 先按本文件直接校验当前 package 合同，再运行适用于当前根的测试、一次性 Kanban build、入口检查和 `workflow-code structure`。宿主仍显示普通文件夹时，不得把 structure 成功当作 Desktop 已重新识别的证明；项目内旧版 CLI 返回 `0` 也不能覆盖直接发现的合同错误。
5. 报告两个独立状态：当前根是否已通过源码级检查；项目是否已由 Desktop 重新识别。后者未经宿主重新打开或刷新验证时必须标记为待处理。

### 关联项目清单迁移

当前 `projectInfo.relatedProjects[]` 每项只允许：

```json
{
  "alias": "stocks",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "grantToRelatedProject": {
    "read": { "mode": "none" },
    "write": { "mode": "none" }
  }
}
```

- 旧 `access: { "read": "all", "write": "none" }` 不受支持。不要把字段机械改名：先从调用代码和项目文档确认原本是谁要访问谁，再按当前 `grantToRelatedProject` 的“允许目标项目访问当前项目”方向写到正确一侧；新规则也必须使用 `{ "mode": ... }` 对象。
- 项目 A 需要读取项目 B 时，A 用自己的 alias 指向 B；B 必须用 A 的 UUID 反向声明，并在 B 的 `grantToRelatedProject.read` 中授权 A。A 自己关系项上的 grant 只控制 B 能否访问 A。
- 旧 `workflowCode.kanban.dataSources` 不会自动迁移，存在即校验失败；将关系统一迁入 `workflowCode.projectInfo.relatedProjects`，页面改用 `relatedProjects.get(alias).kv`。
- 只获得 A 根目录时，可以把 A 的声明迁移为合法、最小授权状态，但不能代替 B 作出授权或声称 KV 已可用。

### 当前 package 字段白名单

修复时只允许出现下列字段；此外的 `workflowCode` 键会在 Desktop 重新识别或发布校验时失败：

- 顶层：`id`（必填 UUID，远程项目主键与权限边界）、`name`（必填非空，同时是内置项目 `localizedNames.en` 的来源）、`version`（合法 SemVer；上传与发布要求稳定的 `x.y.z`）、`type`、`private`、`devDependencies.workflow-code` 与 `devDependencies["@workflow-code/cli"]`（都必须是精确版本，不能是 range 或 `workspace:*`）。
- `workflowCode.projectType`：只有 Kanban 项目写 `"kanban"`；Workflow/Conversation 的类型由源码 executor 的 `projectType` 决定，不要在这里重复声明。
- `workflowCode.projectInfo`：`dataStorage.mode`（必填 `local` / `server` / `both`）、`localizedNames`、`declarations`（当前注册 `multilingual`、`multiplatform`）、`platformSupport`（`{ "mode": "agnostic" }` 或 `{ "mode": "specific", "platforms": [...] }`）、`relatedProjects`（每项只允许 `alias`、`projectId`、`grantToRelatedProject`；alias 匹配 `[a-z][a-z0-9_-]{0,63}`，最多 32 项，不得重复或指向自身）。
- `workflowCode.projectCard`：可选，`icon`（注册图标名）、`iconUrl`（`http(s)`）、`iconColor` / `iconBackgroundColor`（`#RRGGBB`）；禁止 `kind`。
- `workflowCode.release`：可发布项目必填，`dependencies`（键集合必须与 `relatedProjects` 的 alias 集合双向一致）。
- `workflowCode.kanban`：Kanban 的 `artifactDir` 与 `entry`；已删除的 `dataSources` 不再是合法键。
- `workflowCode.schedulePresets`：仅 Workflow 可声明。
- `workflowCode.builtinRelease`：只有内置项目使用，普通项目不要写。
- 不要写入发布期生成的 `delivery`、`version`、`sourceHash` 依赖锁，也不要写旧键 `appCard.kind`、`workflowCode.id`、`.workflow` 存储作用域或全局 KV 声明。

## 阶段二：让宿主建立关联范围

当前主目标是普通文件夹时：

1. 完成阶段一后，明确告诉用户需要让 Desktop 重新打开或重新识别该目录为 Workflow、Conversation 或 Kanban；移除普通文件夹卡片只撤销注册，不删除磁盘文件。
2. 项目身份恢复后，指导用户进入“信息 -> 管理关联资源”，选择或拖入所需项目，并分别设置“允许对方访问本项目”和“本项目访问对方”。不要只说“把另一个目录作为工作区提供”。
3. 保存后，从重新识别出的项目工作区启动新的小助手任务，让 Desktop 为该 run 重新生成授权根目录清单。

当前主目标已经是项目时：

1. 若所需项目未出现在 `roots[]`，指导用户先用“管理关联资源”保存关系，再发起新的 run；不要尝试越过当前清单。
2. 待确认的单边关系可以让已导入且可编辑的目标进入后续代码工作区，但不授予 KV 权限。只有双方 UUID 互指且目标 grant 允许时，才能验证跨项目 KV。

## 完成口径

- 只有当前根迁移、Desktop 项目识别、所需代码工作区授权、双方 KV 合同和相关测试全部满足时，才能说“项目修复完成”。
- 只能完成当前根时，使用“当前根迁移完成；Desktop 重新识别/关联授权/跨项目验证尚未完成”这类准确状态。
- 权限不足时保留已经完成的工作，给出唯一必要的宿主操作和恢复入口；不要反复让用户输入“继续”，也不要建议扩大到父目录或整个项目集合。
