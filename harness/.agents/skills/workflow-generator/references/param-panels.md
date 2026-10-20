# Executor 参数入口与控件

`steamharness.defineExecutor`（Conversation）或 `steamharness.defineEntrypoint`（Workflow）的 `params` 是有序声明数组。Workflow 的普通字段直接写在数组中；Conversation 固定使用标准主输入框，其 `params` 只允许 `kind: "auxiliary"`、`kind: "quick"`、`kind: "mode"`、`kind: "slash"` 独立动作入口，不允许普通主字段。源码字段不写 `panel`。`control` 只决定字段控件形态，不决定它所在的入口。

```ts
params: [
  { kind: "auxiliary", id: "workspace", label: "工作区", fields: [
    { name: "workdir", flag: "--workdir", type: "string" },
    { name: "trace", flag: "--trace", type: "boolean" },
  ] },
  { kind: "quick", id: "ai", label: "AI", icon: "sparkle", summary: ["model", "effort"], fields: [
    { name: "model", flag: "--model", type: "string", control: "select", options: [{ value: "sol", label: "Sol" }] },
    { name: "effort", flag: "--effort", type: "string", control: "select", options: [{ value: "high", label: "High" }] },
  ] },
  { kind: "mode", name: "agentMode", flag: "--agent-mode", label: "模式", options: [
    { value: "ask", label: "Ask" }, { value: "build", label: "Build" },
  ] },
  { kind: "quick", id: "permission", label: "权限", icon: "shield", summary: ["permission"], fields: [
    { name: "permission", flag: "--permission", type: "string", control: "select", options: [{ value: "workspace", label: "Workspace" }] },
  ] },
],
```

## 展示与限制

| 声明 | Desktop Run / Conversation | 字段限制 |
| --- | --- | --- |
| 普通字段 | 仅 Workflow 主表单，按数组顺序排列 | Conversation 不接受；不写 `kind` 或 `panel` |
| `auxiliary` | 每个声明形成一个独立的可收缩面板，`fields` 在面板内排列 | `id`、`label`、非空 `fields` 必填；可包含多个普通字段 |
| `quick` | 每个声明形成一个摘要 chip 和弹层菜单 | `id`、`label`、非空 `fields`、`summary` 必填；字段必须是 `type: "string"` 且 `control: "select" | "radio" | "checkboxes"` |
| `mode` | 独立 chip，单击切到下一个选项；只用于 Conversation | `name`、`flag` 和至少两个值互不重复的非空 `options` 必填；省略 `defaultValue` 时使用第一个选项，显式默认值必须属于选项；名字不限于 `agent` |
| `slash` | CLI Web 输入 `/` 时出现在输入框上方菜单，不占工具栏；只用于 Conversation | `name`、`flag`、`type: "string" | "boolean"` 必填；不写 `control`、`panel`、`multiple`；单选必须有 `options`，boolean 不提供 `options` |

Auxiliary、Quick、Mode 都可重复声明，动作行按 `params` 数组顺序从左到右排列。CLI Web 的 Quick 入口展示图标和当前选择，空间不足时从右到左收起文字，宽度恢复后自动展开；全部 Quick 已收起但其它入口仍超宽时保留横向滚动。可用静态 `icon` 字符串指定 Codicon 名称（匹配 `/^[a-z][a-z0-9-]*$/`，省略为 `settings`）。`label` 保留在菜单标题、悬停提示和无障碍名称中。Auxiliary/Quick 的 `id` 跨两类组唯一；所有字段和 Mode 的 `name`、flag 在整个数组内唯一。组内字段不能写 `panel` 或再嵌套组；Quick 的 `summary` 只能列出本组互不重复的字段名。空组、非法字段和重复标识会被静态分析与运行时拒绝。

Quick 的一级菜单显示本组每个可见字段和当前值；点字段后显示选项列表。宽屏并排，窄屏在同一弹层钻取。单选后关闭选项列表，多选可连续勾选。`control: "radio"` 与 `control: "select"` 在 Quick 内同形；主表单和 Auxiliary 中的 `radio` 是可见单选按钮，`select` 是下拉框。Quick 的“重置为默认值”只恢复本组字段，一次触发 `resolveParams`，不清除其它分组、未知 Raw 参数或未发送的正文与附件。摘要由 `summary` 显式决定，不按 `model`、`effort` 等名字猜测。

`text`、`textarea`、`date`、`time`、`datetime`、`date-range`、`audio` 和 `file` 只能作为主表单或 Auxiliary 字段，不能进 Quick。日期控件使用 `type: "string"`，不声明 `options`、`multiple: true`，resolver 不返回 option 补丁。音频使用单文件 `type: "file"` 和 `control: "audio"`，不声明 `options`。

## 值与宿主

组只影响展示。Core 将所有字段展平到同一个 `paramValues[name]` 命名空间，类型仍为 `string` 或 `string[]`；flag/argv 解析不变。结构报告的 `params` 是展平字段，`paramLayout.actions` 保存独立入口、标签、摘要、字段归属和顺序。Conversation 始终使用标准消息输入，Auxiliary、Quick、Mode 和 Slash 的值进入该轮 args；`--message`、`--images`、`--videos`、`--files` 由主输入框保留，不得在参数中声明。

Slash 的单选每个选项产生一条命令，`command` 默认取 `value`；boolean 的 `command` 默认取参数 `name`，选择后切换 `"true"` / `"false"`。所有命令在项目内唯一、不带 `/`，匹配 `/^[a-z][a-z0-9_-]*$/`。单选默认首项，boolean 默认 `"false"`；显式默认值必须合法。菜单按命令和标签筛选，支持键盘和鼠标选择，遵守 resolver 可见性和禁用状态。选择只移除光标处的命令并更新参数，不发送正文或清除附件。

Conversation 的 `commands` 是 `conversation.commands` 中的静态执行命令数组，与参数共用 `/` 菜单。每项声明 `command`、`label`、可选 `description` / `localizedLabel` / `localizedDescription` 和 `action`。`action.kind: "prompt"` 把 `text` 作为独立回合交给项目执行；`action.kind: "export"` 下载当前会话全部记录并在正文保存结果。命令名与所有参数命令唯一，不能带 `/`。单独输入 `/` 显示全部命令，其他草稿与附件保留。

标准输入框外底部的纯文字通过静态 `conversation.footer` 数组声明，每项二选一 `{ text, localizedText? }` 或 `{ param }`，可设置 `when: { param, value }`。参数项显示当前选项标签或原值；隐藏的引用参数和不匹配条件不展示，翻译缺失回退到 `text`，内容不解析 HTML/Markdown。小助手默认 Build，使用 boolean `/plan` 开关控制 Plan，并通过 `when: { param: "plan", value: "true" }` 显示“Plan 模式”；再次执行同一命令恢复默认。`/export` 导出完整会话，`/compact` 立即总结真实上下文并展示执行中、完成或失败，摘要供后续回合使用，原正文保留。

`resolveParams` 按展平字段名联动。初始化以及主表单或任一动作入口的 Form 字段变化都会触发；若主输入内容也影响选项，才给相关字段加 `resolveOnInput: true`。隐藏字段不自动清值，需要同时返回 `{ visible: false, value: null }`。Conversation 的动作值按会话恢复；Mode 不依赖参数名特例。

本地宿主读取 `paramLayout` 展示入口；终端 CLI 与本地定时任务只读取 flag 和参数值，不展示分组。Server Web 不展示执行参数表单。等待输入节点的 `params` 是独立的暂停表单，继续使用自身的字段契约，不写 executor 的组声明。

用户要求“收进高级选项”时创建 Auxiliary 并把相关字段放入同一个 `fields`；要求多个收缩面板时创建多个 Auxiliary。要求“模型和 Effort 在一个入口，权限另一个入口”时创建两个 Quick，各自设置 `summary`。要求“点一下切换模式”时创建 Mode，不靠把参数命名为 `agent` 来触发。完成后检查 `steamharness structure` 的 `params` 和 `paramLayout.actions`，再检查 `createInput({ paramValues })` 是否按同一字段名读取。
