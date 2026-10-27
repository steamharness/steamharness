# 上游补丁

`npm run prepare:studio` 按文件名顺序应用此目录的 `*.patch`，例如 `0001-*.patch`。已经应用的补丁通过反向检查识别；出现冲突会停止并保留本地改动。

`0001-use-upstream-builtin-artifacts.patch` 让固定版本的内置扩展从其原始 GitHub Release 下载，避免切换 Open VSX 后下载到不同字节而无法通过上游 SHA-256 校验。

`0002-studio-hide-accounts.patch` 添加产品级账号入口开关，隐藏桌面和 Web 的 Accounts 入口及其恢复菜单。

`0005-studio-panel-views.patch` 添加产品级 `disabledWorkbenchViews`，在注册时过滤指定视图，使 Studio 底部仅保留终端和按项目显示的资源标签。

`0006-studio-ports-container.patch` 在 Ports 被产品配置禁用时跳过空面板容器的创建，端口转发能力继续可用。

`0003-studio-workflow-titlebar.patch` 添加顶部运行项目图标按钮，沿用工具栏前景色和悬停反馈，保留操作提示。

`0007-studio-run-debug-view.patch` 在 Run and Debug 没有可用视图时隐藏其活动栏入口，Studio 通过 `disabledWorkbenchViews` 禁用对应视图。

`0008-studio-disabled-tree-views.patch` 跳过已禁用视图的数据提供者注册，避免移除 NPM Scripts 等扩展视图后仍弹出缺失视图错误；npm 任务等其他功能继续使用原有扩展。

`0009-studio-webview-resize-observer.patch` 在被观察文档所属的窗口中创建尺寸观察器，避免嵌入页面持续触发 ResizeObserver 循环日志，并在页面卸载时释放观察器。

`0012-studio-native-clipboard.patch` 在 Studio 的粘贴命令中通过原生宿主读取文字和图片，交给内嵌输入框处理，避免跨域页面的剪贴板权限拦截；其他扩展沿用原有编辑命令。

`0014-studio-ci-serial-build.patch` 在 `STUDIO_CI_SERIAL_BUILD=1` 时串行构建客户端、内置扩展和 Copilot，并逐个编译内置扩展，降低完整 CI 的内存和进程占用；默认开发构建仍并行执行。

`0016-studio-start-workspace.patch` 为无文件背景、空白可编辑 Untitled 和独立开始标签页提供共用原生工作台；模板、项目、账户与运行状态由 Studio 扩展提供，输入继续使用原 Monaco 文档。

`0017-studio-project-icons.patch` 让开始页最近项目和原生打开最近列表使用统一项目类型图标；打开最近先展示列表，再异步读取 Studio 的静态检测结果，保留过滤、选择、移除和窗口打开选项。

`0018-studio-project-creation-dialog.patch` 将开始页创建入口合并为一个原生弹窗，集中选择类型、模板、名称和目录；当前项目使用带运行按钮的卡片。弹窗支持表单校验、目录选择、键盘焦点循环和窄视口。

`0019-studio-start-button-icons.patch` 为开始页新建项目和运行项目按钮显式设置白色图标，避免被工作台通用图标颜色覆盖。

`0020-studio-start-overlay-layer.patch` 将空白 Untitled 的开始面板置于编辑器缩略图之上，避免按钮背景、项目卡片及右侧操作被缩略图画布覆盖。

`0021-studio-native-untitled.patch` 移除 Untitled 的开始面板并恢复原生空白文本编辑；关闭编辑器背景和标签栏空白处双击自动新建文件的行为。

`0022-studio-start-loading.patch` 为开始页首次加载添加主题适配的骨架占位与加载指示，隐藏尚未填入文字的按钮，并支持减少动态效果。

`0023-studio-server-projects.patch` 在顶部运行按钮右侧添加上传入口，并在开始页展示项目版本及上传、下载、版本入口。

`0024-studio-start-responsive-header.patch` 保持开始页标识与标题并排，按编辑区宽度调整间距和操作区换行，避免窄分栏将标识推到独立一行。

`0025-studio-project-upload-dialog.patch` 将项目上传集中到原生弹窗，展示项目、版本、服务器和目录，支持多行发布说明、上传进度、结果、失败反馈及取消。

`0026-studio-project-update-notifications.patch` 在开始页项目卡片展示本地与服务器版本、新版本提醒及升级入口，由扩展提供统一版本状态与升级操作。

`0027-studio-start-toolbar.patch` 将开始页顶部操作收拢为横向排列的新建项目与刷新按钮，链接导入保留在新建项目弹窗中。

`0028-studio-account-menu.patch` 将 Studio 头像入口改为独立账号弹层，展示开源账号的头像、昵称、邮箱与服务器状态，提供个人信息、刷新资料和退出入口；扩展账号授权管理继续通过命令面板使用。文案与公开展示数据由 Studio 扩展提供。

`0029-studio-account-menu-focus.patch` 将账号菜单的初始焦点放在弹层容器，避免默认高亮个人信息按钮，并保留键盘导航与焦点提示。

`0030-studio-project-upload-options.patch` 让原生上传框展示宿主提供的通用复选项，并独立显示上传成功后的后续操作结果；成功后锁定选项与上传入口。

`0031-studio-project-avatars.patch` 让开始页项目卡片、最近项目和打开最近列表展示项目声明的图标与配色，保留未识别目录和工作区的原有图标。

`0032-studio-avatar-actions.patch` 为开始页项目头像增加可键盘访问的打开项目入口，沿用运行项目按钮的命令和反馈。

`0033-studio-start-recent-avatar-spacing.patch` 为最近项目的头像预留完整列宽与文字间距，并让普通文件夹图标和项目头像的名称对齐。

`0038-studio-steam-group-lifecycle.patch` 固定 Steam 左侧运行画布，统一保护分屏、移动、复制、合并及替换操作；右侧分屏标签按分组独立管理，关闭空分组自动回收，项目关闭重开及模式往返保留正确归属。

`0039-studio-steam-tools.patch` 将 Steam 工具区改为圆角标签并保留最右侧显隐按钮，隐藏其他布局和运行区编辑器操作；终端移入工具区，增加浏览器和其它项目入口。固定左侧项目身份，恢复重载前选中的工具编辑器，避免源文件迁移抢占选中标签。

`0043-studio-steam-tab-navigation.patch` 为 Steam 工具导航和实例标签增加主题背景与四周留白，保持新增按钮在左侧、操作按钮在右侧；同步导航高度与工具内容区布局，实例标签使用独立圆角和间距。

`0044-studio-steam-tab-actions.patch` 将两级新增按钮移到各自标签列表之后，实例下拉按钮紧随新增按钮；工具分类使用更小的标签和文字，导航图标统一采用紧凑尺寸，并在空间不足时保留操作按钮。

`0045-studio-steam-editor.patch` 在 Steam 工具区增加原生编辑器，将项目文件与文件预览统一放入下层标签。通过稳定的网格宿主将原生资源管理器、搜索和源代码管理等侧栏放在代码右侧，支持宽度调整、原生文件打开与保存、关闭确认以及模式往返恢复，保留左侧运行页面。

`0046-studio-steam-tools-width.patch` 将 Steam 工具区默认宽度设为窗口的三分之一。网格向布局服务提供用户调整完成事件，按工作区保存拖动或命令调整的宽度；工具显隐、模式往返和重载恢复同一偏好，窗口尺寸约束不写回保存值。

`0047-studio-steam-tab-hierarchy.patch` 让 Steam 工具分类标签均分顶部可用宽度，增加主标签高度；实例标签使用更小的字号、高度和内边距，并以独立主题背景区分两层导航，标签过多时保留横向滚动及尾部操作按钮。

`0048-studio-mode-motion.patch` 将 IDE / Steam 入口改为当前模式胶囊和滑动图标，控件固定在独立顶层；统一两个方向的离场、入场与加载反馈，包含标题栏、侧栏、状态栏和嵌入页面，并支持连续切换及系统和工作台的减少动态效果设置。

`0049-studio-mode-transition-cancellation.patch` 在每个切换阶段检查请求版本，避免反向操作执行过期布局或初始化，并保存取消启动后的模式选择；异步恢复期间隐藏新出现的区域，先清除临时位移再测量布局，动画结束后重新对齐加载遮罩。

`0051-studio-steam-native-tool-tabs.patch` 将下层工具实例切换为各分类独立的原生编辑器组，复用 VS Code 标签、预览、固定、拆分和右键关闭操作；默认工具视图保留控制器并支持原生序列化，终端关闭分类或返回 IDE 时保留 shell 会话。上层分类提供关闭、关闭其他和全部关闭。

`0052-studio-start-empty-badge.patch` 让开始页标识的隐藏状态优先于徽标布局样式，空内容时移除边框及占位。

`0053-studio-mode-panel-state.patch` 在退出 Steam 时先隐藏工具栏，再移除首页上下文并恢复视图位置，避免自动聚焦终端后延迟展开底部面板；只重新打开 IDE 中原本可见的视图容器。

`0057-studio-language-command-service-lifetime.patch` 在语言切换命令的首次异步调用前获取所需服务，避免点击语言或重启应用时使用已失效的服务访问器。

`0060-studio-start-settings-entry.patch` 将开始页徽标移到左侧标题旁并移除顶部刷新按钮；齿轮入口统一通过鼠标、键盘及触控直接打开 Studio 设置页，使用双语标签与按钮语义。

`0064-studio-windows-background-updater-paths.patch` 统一安装目标与后台更新辅助程序的扩展长度路径转换，避免传统目录替换在较深依赖路径上重试失败。

新内核修改应通过 `git diff` 导出统一格式补丁，并排除脚本生成的 `product.json` 及 Studio 扩展链接。品牌配置由 `config/product.json` 维护。
