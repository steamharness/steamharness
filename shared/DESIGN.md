---
version: beta
name: SteamHarness Shared Quiet Technical Workbench
description: Shared design contract for a calm and compact workflow, conversation, output, diagram, logs, diagnostics, and markdown workbench.
colors:
  background: "#F7F8F7"
  surface: "#FFFFFF"
  panel: "#F1F3F2"
  border: "#DFE5E2"
  text: "#17211E"
  muted: "#5B6B65"
  accent: "#0F766E"
  info: "#2563EB"
  success: "#16A34A"
  warning: "#D97706"
  danger: "#DC2626"
darkColors:
  background: "#0B0B0C"
  surface: "#121214"
  panel: "#19191C"
  border: "#2B2B30"
  text: "#F4F4F5"
  muted: "#909099"
  accent: "#D4D4D8"
  info: "#93C5FD"
typography:
  ui:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 13px
    lineHeight: 1.5
  control:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 12px
    lineHeight: 1.4
  mono:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: 12px
    lineHeight: 1.55
rounded:
  control: 6px
  panel: 8px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
components:
  run-workspace-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.panel}"
    padding: "{spacing.md}"
  conversation-workspace-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.panel}"
    padding: "{spacing.md}"
  output-markdown:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "{spacing.sm}"
---


## Overview

`shared/run-workspace-input` 已整体迁出到 `desktop`（现为 `desktop/packages/run-workspace-input`），不再存在于本仓库、也不再随 `dist/source` 分发给下游。`shared` 只保留两个内联的最小子集（`shared/kanban-project/run-workspace` 与 `shared/knowledge-base/run-workspace`），分别支撑 Kanban 的参数表单与图片附件、知识库的 Markdown 预览；两者各自持有自己所需的 CSS Modules 片段，不再从本仓的其他目录取样式。这两个最小子集由本仓维护，宿主负责注入主题变量。Shared 维护知识库与 Kanban 静态预览；本地执行、conversation、历史和日志界面由本地宿主维护。Server Web 只消费知识库与静态 Kanban，不提供执行界面。

`shared/project-types` 是项目类型 ID、显示名翻译键、英文回退名、默认图标、默认图标底色和 executor 能力的唯一注册表。Desktop、server/web、项目模板、卡片元数据与 shared 工作区必须从该注册表派生类型选项和只读标签，并通过 Shared i18n 按当前界面语言解析显示名；宿主可以把共享图标 token 映射为自己的 Lucide 组件，但不得再维护一份独立的项目类型清单。Kanban 必须保留为项目类型且不属于 executor 子集。

shared 采用与 App 一致的 `Quiet Technical Workbench`：低色度连续 pane、hairline 分隔、紧凑密度和明确状态。禁止装饰渐变、glow、玻璃拟态、身份大卡、panel 套 panel，以及把 conversation composer 做成大圆角聊天气泡。浅色以青绿表达品牌、主要动作和 running；深色以中性灰表达这些层级，蓝色保留给 info，绿色、琥珀、红色分别表达 success、waiting 和 danger。

Server Web 的主题 token 位于 `server/web/src/theme/tokens.css`，本地 CLI Web 使用自身主题。Shared 可复用组件消费宿主注入的语义变量。`shared` 内保留的两个最小子集（`shared/kanban-project/run-workspace/styles.module.css`、`shared/knowledge-base/run-workspace/styles.module.css`）只复制当前 closure 实际命中的 CSS Modules 片段。知识库和 Kanban 的共享布局规则应在对应 Shared 模块中实现，宿主不要复制内部 CSS。

## Code Contract

本仓的可复用 UI 由 `knowledge-base` 与 `kanban-project` 模块维护，Server Web 的组合规范见 [Server Web 契约](../server/DESIGN-CODE-CONTRACT.md)。以下执行界面规范仅适用于本地宿主。调整 shared 设计系统能力时，在 shared owner 内补充 token、组件、API 或 formatter，并在同次变更更新调用方与契约测试。

## Code Entry Guide

新增或调整 shared 运行界面时，先找下面的代码入口；缺入口时在 shared 中补充 public API，再让调用点消费，不在消费方页面层绕过 shared 样式。

| 场景 | 必用入口 | 说明 |
| --- | --- | --- |
| canonical 视觉 token | `server/web/src/theme/tokens.css` 与宿主主题桥接 | 知识库和 Kanban 使用宿主语义变量。必须优先使用 `--hit-target-min`、`--hit-target-compact`、`--hit-target-comfortable`、`--control-visual-xs`、`--control-visual-sm`、`--control-visual-md`、`--control-visual-lg`、`--control-height-sm`、`--control-height-md`、`--control-height-lg`、`--field-height-compact`、`--field-height-default`、`--field-height-comfortable`、`--interactive-chip-height-compact`、`--interactive-chip-height-default`、`--status-badge-height`、`--list-row-height-compact`、`--list-row-height-default`、`--control-radius`、`--panel-radius`、`--radius-control`、`--radius-panel`、`--icon-size-xs`、`--icon-size-sm`、`--icon-size-md`、`--icon-size-lg`、`--control-gap`、`--focus-ring`。 |
| 状态语义 token | `desktop/run-workspace-input/theme.css` | 状态色统一从 `--state-success`、`--state-warning`、`--state-danger`、`--state-running`、`--state-waiting` 及其 `-soft` / `-fg` token 派生；组件可继续消费 bridge token `--color-success`、`--color-warning`、`--color-danger`、`--color-running`、`--color-waiting`。 |
| CSS Modules class 解析 | `rwiClass` / `resolveRwiClassName` / `rwiTokenClassName` in `desktop/run-workspace-input/styles.ts`；`shared/kanban-project/run-workspace/styles.ts` 与 `shared/knowledge-base/run-workspace/styles.ts` 暴露同样的最小 helper 给两处内联子集 | shared 内部写语义 token，再由 helper 解析成 CSS Modules hash；测试和宿主不得依赖编译后的 hash。 |
| workflow shell class | `workflowRunShellClassName(slot)` / `useWorkflowRunSidebarLayout` | 本地宿主需要 workflow shell、main、header、diagnostic panel、history restore 等 slot 时调用 shared API；缺 slot 时扩展 `RunShellClassSlot`，不要手拼 `workflow-run-*` 或导入 token 清单。 |
| Workflow 多入口工作区 | `EntrypointsWorkspace` | 按声明顺序组合多个 `RunWorkspaceInput`；宿主必须传稳定的 `workflowId`、resolved target、入口目录、隔离后的草稿/工具策略、活动入口和结果 slot。可选 `entrypoint.group` 的分区、排序、折叠持久化和自动展开都由 shared 维护，宿主不得复制这些逻辑。 |
| Run 主/次/危险操作 | `runActionButtonClassName("primary", "secondary", "danger")`、`PrimaryButton`、`SecondaryButton` | 主操作、取消、删除、对话菜单确认等必须从该入口继承 44px 触达、radius、focus 和状态。需要正方形视觉时传 `square`，不要局部写 34px。 |
| 诊断与结果操作 | `diagnosticActionButtonClassName("action", "icon", "message", "workspace")` | Diagram、Logs、Trace、Copy、诊断抽屉关闭/恢复按钮都走这个入口；`message` 用于 assistant 消息后的轻量动作，默认按 compact token 呈现，触摸/窄屏再放大；其它 workspace/diagnostic 操作保持 44px 触达。按钮文案用 shared formatter，icon-only 必须带 `aria-label` / `title`。 |
| 附件操作 | `attachmentActionButtonClassName()` in `desktop/run-workspace-input/styles.ts`；`shared/knowledge-base/run-workspace/ui/attachment.tsx` 内联 `ImagePreviewDialog` 供知识库预览使用 | 图片附件删除、预览、剪贴板附件操作必须走该入口，视觉图标使用 `--icon-size-*`，命中区使用 `--hit-target-min`。 |
| 可见状态文案 | `desktop/run-workspace-input/utils/labels.ts`；`shared/knowledge-base/run-workspace/utils/labels.ts` 暴露 `formatRunStatusLabel`、`formatImagePreviewError` 给内联子集 | 使用 `formatRunStatusLabel`、`getRunStatusTone`、`formatDiagnosticViewLabel`、`formatDiagnosticViewActionLabel`、`formatImagePreviewError`、`formatRunFallbackMessage`，以及图片预览、复制、运行中断 fallback 常量；不要在页面分支里散写英文 fallback。 |
| 输出/状态 class | `rwiStatusBadgeClass`、`rwiOutputItemStatusClass`、`rwiRunStatusDotClass` | 运行状态、output item 状态、history dot 都从这里选 tone；不要在调用点直接拼 raw 颜色 class。 |
| Menu/Dialog 焦点 | `useMenuFocus` / `useModalFocus` in `desktop/run-workspace-input/hooks/useOverlayFocus.ts`；`shared/kanban-project/run-workspace/hooks/useOverlayFocus.ts` 与 `shared/knowledge-base/run-workspace/hooks/useOverlayFocus.ts` 内联同一组 helper 支撑 Kanban 配置菜单/弹窗和知识库 Markdown 图片预览 | shared/desktop 手写 menu、确认弹窗和图片预览必须复用该入口，保证初始聚焦、方向键或 Tab 循环、Escape 关闭及焦点归还；不能只添加 `role` 而不实现键盘行为。 |
| 知识库工作区 | `KnowledgeWorkspace` and `KnowledgeRepository` in `shared/knowledge-base` | App 与 server/web 传入各自隔离的数据 repository、刷新 token 和图片 URL resolver；摘要列表、按需正文、分页、搜索、草稿、错误与 stale/abort 防护必须由 shared 组件维护。宿主需要自己的左栏外壳时传 `documentRail`，拿到 `list` 与 `total` / `busy` / `refresh`，把 shared 的文档列表放进宿主外壳里，不要自行渲染文档行或复制列表状态；折叠左栏用 `railCollapsed`，行上右键菜单用 `documentRowMenu`（只渲染菜单，编辑 / 删除仍调用回调里给出的操作）。 |

宿主边界：本地客户端与 Server Web 只能传数据、theme bridge、平台适配和 shared 暴露的 shell/action API。若发现需要覆盖 `.rwi-*`、`.run-output-*`、`.diagram-*`、`.diagnostic-text-*` 或 `.workspace-diagnostic-*`，优先视为 shared API 缺失，应在 shared 包中补 token、slot、class helper 或组件，而不是在宿主 CSS 中覆盖。

## Colors

- 使用 `theme.css` 中的语义 token：`--color-bg`、`--color-surface`、`--color-panel`、`--color-border`、`--color-text`、`--color-text-muted`、`--color-accent`、`--color-success`、`--color-warning`、`--color-error`。
- light 基线为 `#F7F8F7 / #FFFFFF / #F1F3F2 / #DFE5E2`，dark 基线为 `#0B0B0C / #121214 / #19191C / #2B2B30`；组件不直接复刻这些 raw 值，必须消费语义 token。
- 浅色中的青绿只承担品牌、focus、selected、primary 与 running；深色对应层级使用中性灰。蓝色 info、绿色 success、琥珀 waiting、红色 danger 不得相互复用。状态 soft 背景必须配对 `*-fg` token，不能把饱和状态色直接当小字号正文色。
- light/dark 必须成对设计；shared dark mode 选择器基于 `html[data-theme="dark"]`，宿主必须把主题写到同一个根节点契约。
- 状态颜色只能作为辅助；success、warning、danger、running、waiting、failed 等状态必须同时用图标、文字或 badge 表达。
- 项目身份图标读取 `projectCard.iconColor` 与 `iconBackgroundColor`，两者属于用户项目身份色而不是状态色；旧元数据缺少 `iconColor` 时统一回退白色，本地客户端、Server Web 与 conversation identity 不得各自硬编码不同前景色。
- 小字号正文、metadata 和状态前景在最终 surface 上至少达到 WCAG AA `4.5:1`；token 测试必须递归解析 CSS 变量后校验真实前景/背景组合，不能只比较源 hex。
- 宿主发现 shared 深色模式 fallback 到浅色时，先修 theme bridge，不要在宿主覆盖 `.rwi-*`、`.run-output-*`、`.diagram-*` 或 `.workspace-diagnostic-*`。

## Typography

- shared 默认正文为 13px。按钮、参数 label/input、菜单和其它需要直接读取或操作的 UI 不低于 12px；Markdown、错误/恢复说明、帮助说明和连续阅读文本不低于 13px，并保持至少 1.5 行高。
- `11px` 只用于短小的次级状态、时间、路径或紧凑导航辅助；`10px` 只用于微型 metadata、只读 badge、kbd/code 标签和不影响任务理解的辅助计数。两者都不能承载关键错误、字段说明、主要操作或唯一状态文案，低于 10px 的字号不进入新代码。
- `14 / 16px` 用于正文强调、section title 和 conversation input 等需要更舒适阅读的局部层级；`18 / 20 / 24 / 26px` 只用于页面标题、首次/空状态标题、诊断概览或同等级 display 内容，不进入紧凑 panel、toolbar、button、badge 或列表行。字号不随 viewport 宽度缩放，letter-spacing 保持 `0`。
- 字重按语义而非固定四档使用：正文与 conversation/history 标题保持 regular，控件、section label 和重要状态使用 medium/semibold，display 或极短强调可使用更高字重。可变字体允许 `520 / 560 / 620 / 650 / 720 / 750 / 760` 等中间值；系统 fallback 下仍须保持清晰层级，不能靠加粗补偿过小字号或低对比。
- 正文、小字号 metadata 和语义状态前景在最终 surface 上至少满足 WCAG AA `4.5:1`；非文本控件边界、focus 和必要图形至少 `3:1`。muted 只表示层级，不能让必要信息失去可读性。
- 数字、耗时、token、runId、JSON 和日志使用 tabular 或 monospace figures，避免运行中数字跳动造成布局漂移。
- shared 中面向用户的事件时间统一显示为 `YYYY-MM-DD HH:mm:ss`，只有生日、账期、日期参数等不需要时刻语义的值显示为 `YYYY-MM-DD`。不得使用斜杠日期、月份名称、AM/PM、相对时间或仅时分替代记录时间；API、持久化字段和 workflow 参数值继续遵循各自协议，不因展示规则改写。
- 普通 Workflow Run 中，默认 `Output` 的 markdown/text item 在没有详情 metadata 时直接平铺展示；Conversation 中的 assistant 主回答（默认 `Output` markdown/text）即使携带 `finishReason`、usage、provider metadata 等响应元数据也必须直接平铺。工具调用、reasoning、诊断、JSON、结构化辅助结果、自定义 title/icon 或显式折叠的 item 才渲染为详情块。

## Layout

- `RunWorkspaceInput` 和 `ConversationWorkspaceInput` 通过 `mainMaxWidth` 暴露主列宽度上限；本地运行界面可传 960px，左侧 history/session list、右侧诊断抽屉不受该上限控制。
- workflow history rail 与 conversation session list 共用同一套话题式列表语言：顶部新建入口 + 折叠按钮，列表项单行标题，运行中只在右侧显示极简 spinner。
- history/session list 只保留一个 roving Tab stop；`ArrowUp / ArrowDown / Home / End` 移动焦点，`Enter / Space` 打开当前项，`ContextMenu / Shift+F10` 打开上下文操作。可见 More 操作不得增加第二条列表 Tab 路径。
- 左侧 rail 支持拖拽调宽、隐藏、恢复和键盘调宽；折叠后不得留下窄 rail 或竖排标签，恢复入口放在运行界面顶部标题栏。
- Kanban 宿主可以通过 `KanbanWorkspace.renderLayout` 自定义配置外壳，插槽中的配置内容、移动入口、抽屉遮罩和预览必须保留挂载位置与焦点契约；`configurationHeadingAction` 用于标题栏动作。Desktop 使用 canonical 标题栏与侧栏组件，配置状态与 CRUD 仍由 Shared 管理。隐藏侧栏不得卸载表单或 iframe，窄容器继续使用参数抽屉，恢复宽容器时关闭抽屉。
- Output、transcript、live/read-only 结果容器新增内容或已有流式块持续增高时必须使用 shared auto-follow scroll；只有视图仍停留在真实底部时才继续跟随。用户手动向上滚动后立即停止，重新滚到最底部后恢复；内容增长产生的非用户 scroll 事件不得误判为主动上滚。本地执行宿主不得另写私有 `scrollTop` 兜底。
- 已从历史或其它上下文启动的普通 workflow 和 conversation 请求允许并行存在；运行状态必须按 `requestId`、`runId` 或 `conversationId` 回写到对应历史项和消息，不能抢占当前编辑的新 workflow、其它入口或其它会话。
- `EntrypointsWorkspace` 在当前工作区一次只聚焦一条 live run。任一入口处于 starting、running 或 waiting 时，所有入口的 Run 都必须禁用；只有活动入口显示 loading、Cancel 和结果。此约束只管理当前本地工作区的活动运行。
- Workflow 入口默认使用 Swagger 式一层扁平折叠列表：全部入口都没有 `group` 时必须保留原 DOM 与视觉，按声明顺序显示标题、ID、默认标记和可选描述。只要存在一个显式分组，就在入口层外增加一层可折叠分区；有 `order` 的分区按升序、同值按首次出现顺序排列，无 `order` 的分区随后按首次出现顺序排列，未声明 `group` 的入口进入参与无序排序的本地化“未分组”分区，分区内入口保持声明顺序。分区使用带 Chevron 的原生按钮及关联 region，不渲染嵌套卡片或多级入口树。
- 入口标题栏保持 44px 紧凑高度，描述在最右侧单行右对齐，空间不足时省略并通过 `title` 保留完整内容。标题栏不显示 Run，默认入口初始展开，入口必须展开后从内容区运行；分区首次进入作用域时只展开默认入口所在分区，运行入口或接收新的活动/结果入口时自动重新展开对应分区。禁止让一个入口隐式先运行默认入口。
- Workflow 的 Form/Raw 模式、参数、附件和工具权限草稿按 `workflowId + resolvedTarget + entrypointId` 隔离。入口折叠只保留当前挂载会话语义；分区展开状态使用 `steamharness:entrypoint-groups:v1:<encoded workflowId>:<encoded target>` 持久化，并以 `group:<id>` / `ungrouped` 区分显式组和未分组。存储不可用或数据损坏时静默回退，恢复时过滤已删除分区，新分区默认折叠。折叠、展开或切换入口不能清空草稿；参数输入、日期选择、resolver 结果和等价入口目录重建也不能改变用户手动选择的折叠状态。运行结果只渲染在实际入口下方，历史和只读回放使用 run 的入口标题/ID 快照。
- shared 运行界面区分“可触达尺寸”和“视觉层级”：运行主操作、工具权限入口、附件删除/预览、抽屉关闭/恢复、Diagram 控制等高频或触摸风险操作使用 `--hit-target-min: 44px`；assistant 消息结束后的 Trace / Logs / Copy 属于低风险、消息级辅助动作，桌面 fine pointer 可使用 `--hit-target-compact` / `--control-visual-sm` 呈现为小按钮，触摸或窄屏再提升到 44px。
- hit area 不等于所有控件可见高度。shared 还提供字段、筛选 chip、状态 badge 和列表行 density token：参数输入和工具栏 select 使用 `--field-height-compact`，可交互筛选/切换使用 `--interactive-chip-height-*`，只读状态 badge 使用 `--status-badge-height`，history/session list 使用 `--list-row-height-*`。先判断主操作、可交互辅助、只读状态和列表行层级，再选 token。
- `1440 / 960 / 720 / 640 / 375px` 是 shared 必验宽度。三栏 workspace 必须按自身实际可用宽度而不是浏览器窗口宽度响应：在 `720-1079px` 把 diagnostics 堆叠到主区下方并占满整行，不能继续压缩主输出；更窄时 rail、主区和 diagnostics 按内容优先级单列化，内部代码块与表格自行滚动而非撑宽页面。
- 普通 workflow 低于 `720px` 时隐藏完整历史 rail 和调宽手柄，改用主区顶部单行选择入口与独立的新建图标操作。选择入口展开有界覆盖面板，提供已加载记录数量、搜索、滚动列表、当前/运行状态和 loading/empty 状态；关闭后归还触发器焦点。桌面 rail 的宽度、折叠与历史菜单行为不得受影响。
- conversation 的窄布局必须依据 `ConversationWorkspaceInput` 自身容器宽度触发，不依赖浏览器 viewport。低于 `720px` 时话题选择保持单行，顶部栏使用与 `WorkspaceSectionHeader` 一致的 44px 触达行和 hairline 分隔，New 使用带可访问名称的 44px 命中区和 32px 可见图形；窄版 composer 与常规 conversation 保持相同的垂直内容高度和 18px 底部留白，只压缩横向 gutter。消息区占用剩余高度，composer 固定保留在面板内，footer 中各 Quick 摘要按可用宽度省略，Send 和附件/Auxiliary 入口不得被挤出容器。
- conversation 的默认消息输入与兼容的单文本主输入必须随多行内容增减自动伸缩，保持 `68px`（窄布局 `72px`）的最小可见高度，增长到 `240px` 后才启用输入框内部纵向滚动；Dock 调宽、收窄或内容清空时必须重新测量并缩回，不得长期保留无内容的高输入区。
- `ConversationWorkspaceInput` 的导航默认使用 `responsive`：在 `720px` 上下切换完整话题 rail 与紧凑选择器。没有宿主级 rail 恢复入口的 Dock 或嵌入工作区必须显式使用 `compact`，在任意容器宽度都保留顶部话题选择与新建操作，并隐藏完整 rail、调宽手柄和恢复按钮。

## Elevation & Depth

- shared UI 以 hairline border、连续 surface 和 token 化 panel 区分层级。普通 composer、列表、Output、Markdown 和 diagnostics 不使用阴影；只有 popover、Dialog 和图片预览允许 token 化 elevation。
- 诊断抽屉是右侧可关闭、可拖拽/键盘调宽的工作区层级；隐藏后不得保留独立右侧窄列。
- Markdown 大图预览使用覆盖层和足够 scrim 隔离背景，支持 Escape、背景点击、关闭按钮和重置缩放。

## Shapes

- 紧凑元素 4px、控件 6px、panel 8px；pill 只用于状态、筛选或真实胶囊语义。composer、Output 和 identity 区域不得恢复 14-16px 大圆角。
- 工具权限触发区必须是一个连续 summary 区域：工具主图标 + 全部/启用/自动批准三组图标和数量，不要拆成分裂 chip。
- Advanced options 中 radio/checkbox 选项保持稳定最小点击高度、换行说明、清晰选中/hover/focus/disabled 状态，长 label 不得挤出边界。
- `executor.params` 按声明顺序定义独立的 Auxiliary、Quick 和 Mode 入口，composer footer 从左到右依次展示。每个 Auxiliary 是可收起的面板，可包含多个字段；每个 Quick 是独立摘要入口，可包含多个枚举字段；每个 Mode 是独立轮换开关。同一组字段不拆成多个触发器，入口也不得把 Send 和附件挤出容器。
- Quick 摘要由该声明的 `label` 和 `summary` 字段决定；一级菜单按组内定义顺序展示全部可见字段及当前值，进入字段后再显示二级选项列表。宽屏二级列表优先在一级菜单相邻侧展开；可用宽度不足时在同一有界弹层中钻取，并提供明确返回入口。
- 每个 Quick 的“重置为默认值”只恢复该组字段，只触发一次联动求值；Main、其它 Quick、Auxiliary、Mode、Raw 未知参数、conversation 未发送正文和附件都必须保留。conversation 中的选择值由宿主按 workflow 与 conversation 隔离保存，切换或重新进入会话时先恢复对应值，不能串到其它会话。
- Quick options 只处理 `select` / `radio` / `checkboxes` 枚举参数；`date` / `time` / `datetime` / `date-range` 只能放在 main 或 auxiliary，不在 Quick 中降级成文本或空选项。
- Quick options 的一级菜单和二级单选/多选列表固定向上展开并限制在视口内；Auxiliary、附件菜单和各 Quick 弹层互斥。二级列表中的 Escape / ArrowLeft 返回一级菜单，一级菜单中的 Escape、页面外部点击或切换其它弹层会关闭当前 Quick 弹层并恢复对应触发器焦点。
- 参数联动求值必须覆盖 main、Advanced、Quick 的 Form 参数变化，并显示局部 loading/error；求值中或失败时禁用 Send。动态 `visible` 状态同步控制字段、Advanced 计数和 Quick 入口，当前入口隐藏时关闭已打开的弹层。失败区域必须保留当前输入并提供原位重试，重试期间显示 busy、禁用重复触发，成功后清除错误并恢复 Send；旧请求响应不能覆盖较新的输入、选择状态或进行中的 Raw 编辑。`visible: false` 不隐式清空值，互斥参数由 resolver 同时返回 `value: null`。Raw 模式应用 resolver 值补丁时只能替换对应已声明参数，不得重建整段 args 或丢失未知参数。
- 参数 resolver 返回 `resolvedOptions` 数组时，Quick 与 Advanced 必须统一以该数组替换静态选项；返回 `null` 时恢复静态选项。替换时清除旧 option 状态，按 conversation ID 隔离已选值和请求代次，loading、empty、error、visible、disabled 必须在两个表单入口保持一致。

## Components

- **Style ownership**: shared 内部样式必须通过 CSS Modules 和 `rwiClass` / `resolveRwiClassName` 输出；新增稳定测试钩子使用 `data-slot`、`data-state`、ARIA、role 或文本，不依赖 CSS Modules 编译后的类名。
- **Host boundary**: 本地客户端与 Server Web 使用 shared 时只允许传外层 shell、theme bridge、平台差异和数据；宿主需要 workflow shell class 时必须调用 `workflowRunShellClassName` / `useWorkflowRunSidebarLayout` 这类 shared API，禁止直接覆盖 shared 内部结构类名，也禁止在宿主手动拼接 shared 内部类名字符串或导入 shell token 清单。
- **Workflow entrypoints**: `EntrypointsWorkspace` 是 Workflow 多入口运行区及可选入口分区的唯一共享组合入口，`EntrypointsWorkspaceProps.workflowId` 必须使用跨挂载稳定的项目标识，不能用显示名代替。Conversation 必须继续直接使用 `ConversationWorkspaceInput`，不能为了视觉一致套入入口列表；入口为空时显示独立空状态，异步加载入口目录时由宿主显示 loading，不得把二者合并。
- **Kanban workspace**: `shared/kanban-project` 统一拥有清单校验、产物目录与 HTML 入口契约、参数值转换、命名配置 CRUD、300ms 自动保存、iframe bridge 和响应式布局。`artifactDir` 默认 `.`，`entry` 默认 `index.html`；宿主只从产物根加载资源，不处理源码构建、dev server 或 HMR。没有参数时不渲染配置 chrome，画布占满容器；存在参数时桌面使用紧凑配置选择器、参数设置侧栏和画布，低于 `760px` 容器宽度时使用顶部配置入口与参数抽屉。配置切换使用有界 listbox，新建保留独立图标入口，重命名、复制和删除进入当前配置菜单；参数表单使用 `ParamsForm variant="settings"` 的纵向标签与全宽控件，短单选项使用紧凑等宽分段布局，换行后的最后一项不得拉满整行，合法十六进制颜色选项同时显示色块和文字。保存状态固定在侧栏标题栏；新建、复制、重命名、删除、切换、保存与预览加载分别维护 loading/error/retry，最后一个配置不可删除，关闭菜单或弹层后恢复触发器焦点。
- **Kanban iframe**: `KanbanPreviewFrame` 是完整工作区与 Conversation 卡片共用的 iframe/bridge 入口；卡片展开后才创建预览，卸载时由宿主释放本地预览会话。iframe 尺寸必须稳定并使用 `sandbox="allow-scripts"`；宿主只允许带 nonce 的配置、展示模式消息和 KV/知识库白名单 RPC，不得开放项目选择、scope、存储路径、Node、preload、父页面 DOM、弹窗、下载或顶层导航。静态资源使用绑定项目、用户和版本的短期 capability，并返回 CORS 与浏览器可识别 MIME；CSP 的 `connect-src` 只允许该 capability 下的同源产物以及 `data:` / `blob:`，使 ES module、动态 import、WASM 和项目内 `fetch()` 可用但不开放公网请求。宿主在 capability 到期前自动续期并只替换预览 URL/nonce，不覆盖当前配置；临时失败按固定间隔重试，旧 capability 到期后显示可重试错误。RPC 必须校验当前 iframe source、nonce、request id、operation 和 JSON 输入，限制 16 个并发请求并在 15 秒后超时；刷新 iframe 后丢弃旧代次响应，错误只返回安全 code 和文案。配置切换和值更新派发页面事件而不刷新 iframe；只有已保存的 HTML/CSS/JS、外部文件落盘或 capability 续期才触发页面刷新。loading、empty 和 error 状态互斥，错误必须保留重试入口且不能覆盖仍可用的旧配置。
- **Kanban presentation**: 页面通过 `getPresentation()` 和 `steamharness:kanban-presentation-change` 获取独立于业务配置的 `{ mode: "fullscreen" | "phone" | "tablet" | "card" }`。完整工作区默认全屏，`compact` 的 Conversation 卡片默认为 card；宿主改变模式时、iframe 加载和就绪时均发送当前值。只接受父窗口和当前 nonce 下的合法模式，不重建 iframe 或重置 RPC 代次。页面依据该模式决定只读布局，并根据自身实际宽高测量内容；调整卡片尺寸不改变 card 语义。
- **Run workspace**: 参数输入保持紧凑；同一表单中的 textarea、日期和普通输入必须共用一条控件起始线，不能因控件类型改变标签列宽。`description` 优先作为 placeholder，不在输入框下重复说明；file 参数不展示 `format: json` 或 managed file JSON。
- **Active workflow cancellation**: 运行中的 workflow 在结果标题栏最右侧保留 Cancel 操作；流式输出、工具调用和等待输入期间都必须可终止，等待输入复用对应的结束运行路径。
- **Pending tool approval**: `tool-approval` 等待节点使用专用决策界面，不渲染通用 boolean switch，也不响应 Enter 隐式提交。界面常驻展示工具标识与调用参数，并提供语义完整的“批准并继续”与“拒绝并结束”操作；异步时只在被触发的操作上显示对应 loading 文案。
- **Pending choice questions**: 等待用户输入中的 radio / checkbox 问题必须让问题正文独占完整一行，选项位于下一行并按组件实际宽度响应式排列；宽容器使用两列，低于 `560px` 自动单列。中文长句、绝对路径和选项说明必须完整换行，不得被固定 label 列挤压、截断或撑出横向滚动。
- **Conversation tool permissions**: Conversation 模式的工具启用与自动批准策略按对话保存，和 Advanced / quick composer 参数一样随活动对话切换并恢复；新建或尚无独立策略的对话直接使用 executor `tools` 默认值，不继承项目级或其它对话的 override；普通 Workflow Run 继续使用项目级策略。
- **Queued conversation input**: 等待输入队列使用紧凑单行列表；每项只显示可省略的文字摘要，不渲染图片、附件数量或其它输入详情。拖拽、引导、编辑和删除使用 compact 视觉控件，触摸设备仍由 shared hit-target token 提升命中尺寸。
- **Textarea**: `executor.params.control = "textarea"` 渲染多行输入；textarea 内 Enter 保持换行，conversation raw 输入 Shift+Enter 换行，Form 文本输入 Enter 发送且不得打断 IME。
- **Date params**: `date`、`time`、`datetime`、`date-range` 由 `DateParamControl` 统一渲染，提交值分别保持 `YYYY-MM-DD`、`HH:mm:ss`、本地 `YYYY-MM-DDTHH:mm:ss` 与闭区间 `YYYY-MM-DD/YYYY-MM-DD`；可见日期使用 `YYYY-MM-DD`，可见 datetime 把协议中的 `T` 显示为空格，范围起止也分别使用 `YYYY-MM-DD`。日历弹层 portal 到 body，支持 Escape、外部点击、日期键盘导航和焦点归还；共享 overlay stack 只允许最上层处理键盘事件，在 Advanced 内操作年月滚轮或关闭日期弹层不能误关父面板。宿主在弹层打开期间替换受控值时立即关闭旧弹层，不能让旧草稿覆盖新值。范围只允许选择不早于开始日期的结束日期并在完整选择后写回，datetime 只在“确定”后写回。点击日历标题使用紧凑的年份、月份双列滚轮选择，滚轮只更新草稿，“取消”保持当前月份，“完成”后才跳转日历；合法年份固定为 `0001..9999`，滚轮仅渲染当前年份附近的有限窗口。`date-range` 在桌面显示两个独立导航的单月日历，重新打开时分别定位到已选起止月份；起止同月时右侧显示下一个月。任一日历切换年月时另一个保持不动，低于 720px 回退单月。范围起止和中段必须使用各自的 light/dark 语义色。Run workspace 展开入口时不得立即显示必填或格式错误，只在首次点击 Run/Send 后显示；必填空值和无效非空原值必须原样保留，错误显示后阻止运行，值修正后恢复操作。日期标题、滚轮操作、导航和日期单元使用 44px 命中区，跨月可选日期在 light/dark surface 上满足正文 AA 对比度。
- **Number input**: number 参数在 Form 模式展示默认值，提供右侧 stepper 与直接输入；stepper 必须有边界、hover/focus/disabled 状态和可访问名称。
- **File attachments**: 图片参数显示固定缩略图、删除和预览入口；同一图片引用在文本输入、表单重算或 args 解析时保持稳定，不回退成文件 JSON 或图片 icon。
- **Token usage**: Token badge 正文保持紧凑总量；hover/focus tooltip 必须分别展示 Input、Output、Reasoning、Cache read、Cache write 和 Calls，不能把 SDK 已提供的 reasoning 或 cache 写入量仅藏在无障碍文本中。
- **Tool permissions**: `executor.tools` 的入口位于 本地运行工作区顶部标题栏右侧，从标题栏向下弹出表格，列为可用工具、启用工具、自动批准；触发 summary 区域本身必须至少 44px 高。
- **Output items**: `OutputItem[]` 是 conversation、只读 replay 和普通 workflow Output 的统一渲染协议；`metadata.status` 显示 running/success/failed，running spinner 尊重 `prefers-reduced-motion`。同一输出列表中的 assistant 文字、reasoning、tool 和其它活动行不增加额外容器纵向 gap，依靠正文行高与活动行自身的 44px 触达高度形成紧凑连续节奏；tool 与 tool 之间同样不得加入大块留白。
- **OpenCode output presentation**: OpenCode 的 reasoning、tool、Todo、patch/diff、agent/subtask、file、retry/recovery、compaction 和 error 必须统一经过 shared presentation adapter，再交给同一个紧凑活动行渲染；assistant text 继续平铺为 Markdown，`step-start`、`step-finish` 和 `snapshot` 等协议记账事件不生成可见噪音。每类 `output_item_start` 都必须携带 type、status 和生成首帧标题、图标、详情所需的完整语义字段，后续 delta 只能原位更新，不能中途更换图标或从 raw JSON 跳成专用布局。折叠摘要按消息语义与 running/success/failed 状态生成自然语言动作并使用一致 Lucide 图标；成功态不增加重复可见徽标，running、retry、Todo 和 question 在恢复、失败、暂停或 turn 结束时必须收敛到终态。长摘要只按真实可用宽度 CSS ellipsis，并保留完整 `title`。展开详情只允许 Input、Result、Error、Files、Tasks、Agent、Prompt、Reasoning、Source、Type、Reason 等用户有价值的结构化 section，不倾倒 callId、协议 status 或整层 metadata；未知工具回退 OpenCode runtime title。
- **Command summaries**: command execution 的完整单行标题交给 shared summary 按真实可用宽度展示；标题可占满 icon 与 disclosure 之间的空间，只有实际宽度不足时才用 CSS ellipsis，不能在 workflow 层按固定字符数预截断。
- **History and conversation lists**: workflow history 与 conversation list 使用 roving tabindex，支持 ArrowUp/ArrowDown/Home/End 和 Enter/Space；每行菜单必须在桌面、触摸和键盘下都可见可达，不能只依赖右键或 hover。窄 workflow 与 conversation 容器都不得使用原生 `select` 承载历史；顶部只显示当前项紧凑入口，展开后使用有界覆盖面板提供搜索、滚动列表、当前/运行状态，关闭后恢复触发器焦点。话题历史续载使用 rail 或覆盖面板底部的全宽连续区，必须同时表达加载、已显示数量、远端续载和失败重试，不能退化为悬空小按钮；分页加载失败显示在对应列表/消息区域并保留重试入口，不能静默吞错。
- **Default message composer**: 配置默认 message 输入时，composer footer 只保留一个固定操作位；普通状态显示 Send，运行中且草稿为空时显示图标化 Cancel，输入文字或加入附件后原位切换回 Send，不能同时展示两个大按钮或造成 footer 位移。Send/Cancel 的可见图形统一为 32px，桌面命中区使用 `--hit-target-comfortable` 的 40px 紧凑尺寸，粗指针自动回到 44px；图标按钮保留可访问名称。普通 workflow composer 不再渲染与真实 Send 重复的被动 `Input + 发送图标`，存在参数时只保留 Form/Raw 模式切换和声明的 Auxiliary/Quick/Mode controls。
- **Conversation empty state**: 宿主需要展示 conversation 专属介绍时使用 `emptyStateHeader`；shared 只在活动话题确认无消息时渲染该 slot，加载、错误和已有消息状态都不展示。窄容器把介绍与 18px 标题放入独立的上方滚动区，composer 始终作为不随该内容滚动的底部区域并保留安全间距；不使用占满高度的营销 hero 或大字号垂直居中。
- **Menus and dialogs**: 行菜单、rename/delete Dialog 与附件菜单必须管理初始焦点、Escape、Tab 边界和关闭后的焦点恢复；键盘上下文入口与可见 More 入口打开同一菜单。
- **Message actions**: assistant 消息结束后的 Trace / Logs / Copy 是上下文辅助动作，不与 composer Send、附件删除或工具权限入口同级；默认使用 `diagnosticActionButtonClassName("message")` 的小号视觉，保持轻量、低干扰和清晰 tooltip，不要把它们做成 44px 可见主按钮。
- **Markdown**: 支持 CommonMark 与 GFM：标题、段落、强调、列表、任务列表、链接、引用、行内代码、代码块、分隔线、删除线、表格。代码块和表格在窄容器内部横向滚动，不撑破页面。
- **Knowledge workspace**: 采用左侧有界文档列表、右侧独立正文/编辑滚动区和固定操作栏。左侧默认是搜索框加文档列表；宿主传 `documentRail` 时改由宿主提供左栏外壳（是否放搜索框、以及 `railCollapsed` 折叠后的恢复入口都由宿主决定），文档列表本体、分页与选中状态仍必须来自 shared，宿主只摆放 `list` 并让列表自己滚动。摘要按页加载，底部固定「上一页 / 第 N / M 页 / 下一页」，滚动到底不自动续载；宿主传 `documentRowMenu` 时行上的右键菜单交给宿主渲染，但编辑与删除仍走 shared 自己的流程（编辑先过未保存草稿确认，删除先确认再删）。首次只加载文档摘要，选择文档后才请求 markdown 正文。超过 `200 KB` 的 markdown 不渲染预览，超过 `48` 张图片时切换到手动图片加载模式。宿主不能复制这套状态或对 server/local 数据做混合缓存。
- **Image preview**: 只预览安全 `data:image/png|jpeg|webp|gif;base64,...`；使用 `react-zoom-pan-pinch` 支持按钮、键盘、Cmd/Ctrl + 滚轮、触摸板/触摸双指缩放，缩放围绕当前指针或手势中心，放大后可拖动平移。
- **Diagram**: 优先呈现已连线的 workflow 执行链路；节点类型用统一 Lucide 图标和语义色辅助识别，不能只靠颜色。runFor/runWhile 用语义矩形容器表达循环范围，节点详情层纵向展示 input、output、executionInfo，可折叠且长 JSON 内部滚动。
- **Logs/diagnostics**: Logs 中每条 run 的 stdout、stderr、runner diagnostics 和 `report.json` 默认展开但保留手动折叠；日志卡、摘要和查看器必须占满抽屉可用宽度，折叠后不得保留空白占位。长文本、`report.json`、Diagram 节点详情和 Result 原始 items JSON 使用有明确边界的独立滚动区或只读可搜索查看器，支持当前匹配定位、上/下一个跳转，展开后不得被父容器裁切。workflow 最终 output 提供 `threadId` 时，Logs 运行摘要直接显示完整值并保留 title，便于恢复或关联 provider thread。
- **Pending and error priority**: running / waiting 且尚无 output 时显示明确进行中说明，不能复用“暂无 output”空状态；Logs 或分页存在真实错误时错误优先于 empty，loading、empty、error 三态不得叠加或互相遮蔽。

## Do's and Don'ts

- Do: 先在 shared 包内修复运行界面样式、布局、滚动和可访问性，再让实际消费方继承。
- Do: 保持 `workflow` 与 `Conversation` 成对命名，不恢复旧的可见 `Run workspace` chrome。
- Do: 使用 Lucide/SVG 图标，并为 icon-only 操作提供 `aria-label` / `title`。
- Don't: 在宿主里覆盖 `.rwi-*`、`.run-output-*`、`.diagram-*`、`.diagnostic-text-*`、`.workspace-diagnostic-*`。
- Don't: 用 Tailwind utility 或全局 CSS 在宿主修 shared 内部 icon 尺寸、间距、滚动容器或诊断细节。
- Don't: 把结构性图标换成 emoji。
- Do: 样式合同测试可以读取 canonical `theme.css` / `styles.module.css` 源文件，断言稳定 token 与源选择器声明；不得依赖 CSS Modules 编译后的 hash，也不能用源码文本断言替代 computed style/layout、Playwright 或组件行为测试。
