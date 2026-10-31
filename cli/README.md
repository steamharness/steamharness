# @steamharness/cli

Unified local and server workspace CLI for SteamHarness projects.

```bash
pnpm add -D steamharness @steamharness/cli
steamharness --help
```

## Project templates

`dist/project-templates.mjs` exports `listProjectTemplates`, `createProjectFromTemplate`,
`registerTemplateProject`, and `validateProjectName` for hosts such as Studio. The catalog in
`src/project-templates/catalog.json` owns bilingual names, descriptions, project type,
starter/example purpose, entrypoint, and file mappings. Add an entry and its source files
to extend the catalog without changing the host layout.

Creation accepts an existing absolute parent directory, a portable folder name, and exact
published Core/CLI versions. It reserves a new directory, generates a UUID and local-storage
manifest, and never overwrites an existing folder. Dependency installation and window
management belong to the host. The three starters and four examples require no model or
account after dependencies are installed.

When a host supplies `allocateProjectId`, creation uses the Server-assigned UUID. If allocation
fails, creation still writes the complete project with an empty `steamharness.json.id` and
returns `idAllocationError`. Hosts can open the source folder, install dependencies, and use
`registerTemplateProject` to retry registration before runtime validation. Registration replaces
only the empty ID and rejects manifest edits made during the request. Explicit cancellation
still cancels creation; invalid paths and file-write failures remain errors.

Hosts can set `deferProjectId: true` to create complete files immediately with an empty ID,
without invoking the allocator. Studio uses this mode to open the selected window first;
dependency installation, ID registration, and validation then run in that project window.

项目模板由上述清单统一维护，提供三种最小项目及四个本地示例。生成模块校验名称、路径和精确版本，
独占创建目录并分配 UUID；宿主负责安装依赖、展示进度和打开项目。Studio 使用同步副本进行独立构建。
Studio 通过 `deferProjectId` 立即生成空 ID 的本地项目并打开用户选择的窗口，再在目标窗口中安装依赖、
申请 ID 和校验。申请失败保留完整文件，可通过 `registerTemplateProject` 单独重试，不覆盖已有源码。
