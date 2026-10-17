# 文件预览

在资源管理器中打开 PDF、DOCX、PPTX、XLSX 或图片时，Studio 会在编辑器标签页显示只读预览，包括 HEIC / HEIF 图片。预览使用当前 VS Code 主题和显示语言，无需另外安装预览插件。

源文件保存后，已打开的预览会自动更新。原子保存、删除后重新创建和后台标签页均受支持；刷新保留缩放、滚动位置、当前幻灯片和选中的工作表。标签页可以分栏打开。读取失败时显示错误并保留已显示的内容，也可以使用工具栏的刷新按钮重试。

PDF 支持页码跳转、缩放、文字选择和密码解锁。DOCX 保留分页与文档样式；PPTX 按预览区大小等比居中显示，通过边框和主题背景区分幻灯片，支持翻页及工具栏文字复制；XLSX 显示可见工作表、格式化单元格及合并单元格，单元格文字可以选择复制，不会计算公式或写回文件。图片支持缩放和适应宽度。

`.tex` / `.latex` 默认打开 LaTeX 公式预览。如需编辑源文件，可在标签页菜单的 **重新打开方式** 中选择 **文本编辑器**。此预览显示 KaTeX 支持的公式，不执行完整 TeX 文档编译。

预览支持普通文件夹和 Workflow 项目，通过 VS Code 文件系统访问文件，也适用于提供文件读取和监听能力的远程、虚拟工作区。文件大小限制为 50 MB，LaTeX 为 200 KB；工作簿上限为 20,000 行、200 列、200,000 个单元格，HEIC / HEIF 上限为 6400 万像素。旧的 `.doc`、`.ppt`、`.xls` 格式需要先转换为对应的 Office Open XML 格式。

渲染库和字体、PDF worker、字符映射与 WebAssembly 资源随扩展构建，按格式加载，不使用外部文档预览服务。第三方来源见 [预览库及许可证](document-preview-licenses.md)。

## 验证

日常检查在后台运行，使用 `npm run check` 和 `npm run build:extension`。提交并推送后，通过 GitLab 的 `linux` runner 在 Xvfb 中运行完整测试：

```sh
glab ci run --branch <目标分支> --variables STUDIO_FULL_TESTS:1
```

文件预览桌面回归需要在 runner 上配置 `STUDIO_TEST_PREVIEW_FILES`，指向包含 PDF、DOCX、PPTX、XLSX、TEX 和 HEIC 的样例文件夹。缺少样例时，完整测试会明确跳过此项。测试仅修改样例副本，并使用独立用户数据目录；不要在正在使用的本机桌面运行真实 Electron 回归。

在远端 Xvfb 环境中，可分别运行简体中文和英文回归：

```sh
STUDIO_TEST_UI_LANGUAGE=zh-cn npm run test:document-preview-ui
STUDIO_TEST_UI_LANGUAGE=en npm run test:document-preview-ui
```

截图和验证结果位于 `.studio/document-preview/<language>/`，完整测试会将其保存为 CI 制品。
