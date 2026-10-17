# @workflow-code/cli

Unified local and server workspace CLI for Workflow Code projects.

```bash
pnpm add -D workflow-code @workflow-code/cli
workflow-code --help
```

## Project templates

`dist/project-templates.mjs` exports `listProjectTemplates`, `createProjectFromTemplate`,
and `validateProjectName` for hosts such as Studio. The catalog in
`src/project-templates/catalog.json` owns bilingual names, descriptions, project type,
starter/example purpose, entrypoint, and file mappings. Add an entry and its source files
to extend the catalog without changing the host layout.

Creation accepts an existing absolute parent directory, a portable folder name, and exact
published Core/CLI versions. It reserves a new directory, generates a UUID and local-storage
manifest, and never overwrites an existing folder. Dependency installation and window
management belong to the host. The three starters and four examples require no model or
account after dependencies are installed.

项目模板由上述清单统一维护，提供三种最小项目及四个本地示例。生成模块校验名称、路径和精确版本，
独占创建目录并分配 UUID；宿主负责安装依赖、展示进度和打开项目。Studio 使用同步副本进行独立构建。
