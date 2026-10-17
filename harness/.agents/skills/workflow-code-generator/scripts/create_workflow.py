#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from uuid import uuid4
from pathlib import Path

KANBAN_TEMPLATE_ROOT = Path(__file__).resolve().parent.parent / "assets" / "kanban"
KANBAN_TEMPLATE_FILES = (
    ".workflowignore",
    "index.html",
    "board-state.js",
    "board-storage.js",
    "README.md",
    "tests/board-state.test.mjs",
    "tests/board-storage.test.mjs",
)
SEMVER_PATTERN = re.compile(
    r"(?:0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
PROJECT_CARD_DEFAULTS = {
    "workflow": ("workflow", "#2563eb"),
    "conversation": ("message-circle", "#0f766e"),
    "kanban": ("boxes", "#b45309"),
}

WORKFLOW_IGNORE = """.git/
node_modules/
dist/
build/
out/
coverage/
.cache/
.turbo/
*.log
*.tmp
*.tsbuildinfo
.env
.env.*
!.env.example
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="在目标目录创建 workflow-code workflow 脚手架。",
    )
    parser.add_argument("name", help="workflow 名称，例如 hello 或 issue-summary。")
    parser.add_argument(
        "--description",
        default="一个工作流项目。",
        help="写入 README 的描述。",
    )
    parser.add_argument(
        "--prompt",
        default="请用简洁方式总结输入。",
        help="未传 CLI 参数时使用的默认 prompt。",
    )
    parser.add_argument(
        "--project-type",
        choices=("workflow", "conversation", "kanban"),
        default="workflow",
        help="显式项目类型，默认 workflow。",
    )
    parser.add_argument(
        "--with-kanban-params",
        action="store_true",
        help="Kanban 项目额外生成示例 kanban.json 参数清单。",
    )
    parser.add_argument(
        "--dir",
        default=".",
        help="workflow 项目目录，默认当前工作目录。",
    )
    args = parser.parse_args()

    workflow_name = normalize_name(args.name)
    workflow_dir = Path(args.dir).resolve()

    if args.with_kanban_params and args.project_type != "kanban":
        raise SystemExit("--with-kanban-params 只能与 --project-type kanban 一起使用。")

    if workflow_dir.exists() and any(workflow_dir.iterdir()):
        existing_files = [workflow_dir / "package.json"]
        existing_files += (
            [workflow_dir / path for path in kanban_template_files(args.with_kanban_params)]
            if args.project_type == "kanban"
            else [
                workflow_dir / "interface.ts",
                workflow_dir / "index.ts",
                workflow_dir / "README.md",
            ]
        )
        conflicts = [str(path) for path in existing_files if path.exists()]
        if conflicts:
            raise SystemExit(
                "workflow 文件已存在，不会覆盖："
                + ", ".join(conflicts)
            )

    workflow_dir.mkdir(parents=True, exist_ok=True)
    write_file(workflow_dir / "package.json", package_json(workflow_name, args.project_type))
    if args.project_type == "kanban":
        for relative_path in kanban_template_files(args.with_kanban_params):
            write_file(
                workflow_dir / relative_path,
                render_kanban_template(relative_path, workflow_name, args.with_kanban_params),
            )
        print(f"已创建 Kanban：{workflow_dir}")
        print(f"可检查：workflow-code structure {workflow_dir}")
        return

    type_name = to_pascal_case(workflow_name)
    write_file(workflow_dir / ".workflowignore", WORKFLOW_IGNORE)
    write_file(workflow_dir / ".env.example", env_example())
    write_file(workflow_dir / "interface.ts", interface_ts(type_name))
    write_file(workflow_dir / "index.ts", index_ts(workflow_name, type_name, args.prompt, args.project_type))
    write_file(workflow_dir / "README.md", readme_md(workflow_name, args.description, args.project_type))

    print(f"已创建 workflow：{workflow_dir}")
    print(f"可运行：workflow-code structure {workflow_dir}")
    input_args = '--message "input text"' if args.project_type == "conversation" else '"input text"'
    print(f"可运行：workflow-code run {workflow_dir} -- {input_args}")


def normalize_name(value: str) -> str:
    name = re.sub(r"[^a-zA-Z0-9-]+", "-", value.strip()).strip("-").lower()
    name = re.sub(r"-+", "-", name)
    if not name:
        raise SystemExit("workflow 名称不能为空。")
    return name


def to_pascal_case(name: str) -> str:
    return "".join(part.capitalize() for part in name.split("-") if part) or "Workflow"


def write_file(path: Path, content: str) -> None:
    if path.exists():
        raise SystemExit(f"拒绝覆盖已有文件：{path}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def kanban_template_files(with_params: bool) -> tuple[str, ...]:
    return KANBAN_TEMPLATE_FILES + (("kanban.json",) if with_params else ())


def render_kanban_template(relative_path: str, name: str, with_params: bool) -> str:
    variant = "parameters" if with_params else "default"
    template_path = KANBAN_TEMPLATE_ROOT / variant / relative_path
    return template_path.read_text(encoding="utf-8").replace("{{name}}", name)


def package_json(name: str, project_type: str) -> str:
    workflow_id = str(uuid4())
    core_version, cli_version = resolve_dependency_versions()
    package_suffix = "kanban" if project_type == "kanban" else "workflow"
    icon, icon_background = PROJECT_CARD_DEFAULTS[project_type]
    project_type_metadata = f'\n    "projectType": "{project_type}",'
    release_metadata = '{"dependencies": {}}'
    workflow_metadata = f''',
  "workflowCode": {{{project_type_metadata}
    "projectCard": {{
      "icon": "{icon}",
      "iconBackgroundColor": "{icon_background}"
    }},
    "projectInfo": {{
      "dataStorage": {{
        "mode": "both"
      }},
      "relatedProjects": []
    }},
    "release": {release_metadata}
  }}'''
    return f'''{{
  "id": "{workflow_id}",
  "name": "@workflow-code/{name}-{package_suffix}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "devDependencies": {{
    "@workflow-code/cli": "{cli_version}",
    "workflow-code": "{core_version}"
  }}{workflow_metadata}
}}
'''


def read_package_json(package_path: Path) -> dict:
    try:
        value = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"无法读取 {package_path}：{error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"{package_path} 必须是 JSON 对象。")
    return value


LOCAL_SPECIFIER_PATTERN = re.compile(r"^(?:file|link):(\./|\.\./)")


def read_declared_version(package: dict, package_name: str, package_path: Path | None = None) -> str | None:
    for dependency_key in ("dependencies", "devDependencies"):
        version = package.get(dependency_key, {}).get(package_name)
        if isinstance(version, str) and SEMVER_PATTERN.fullmatch(version):
            return version
        # `dev` 和功能分支上用 `link:../core` 引用同级仓库，此时版本要从目标仓库
        # 自己的 package.json 读取；生成器的发布产物里永远是精确版本。
        if package_path is not None and isinstance(version, str) and LOCAL_SPECIFIER_PATTERN.match(version):
            sibling_version = read_sibling_version(package_path, version, package_name)
            if sibling_version is not None:
                return sibling_version
    return None


def read_sibling_version(package_path: Path, specifier: str, package_name: str) -> str | None:
    sibling_path = (package_path.parent / specifier.split(":", 1)[1]).resolve() / "package.json"
    if not sibling_path.is_file():
        return None
    sibling = read_package_json(sibling_path)
    if sibling.get("name") != package_name:
        return None
    version = sibling.get("version")
    return version if isinstance(version, str) and SEMVER_PATTERN.fullmatch(version) else None


def resolve_dependency_versions() -> tuple[str, str]:
    """解析 scaffold 要写入的精确 Core/CLI 版本。

    Core 仓库把 Core 版本放在根 `package.json.version`、CLI 版本放在
    `workspace/package.json`；Desktop 与内置项目则把两者写在最近的祖先
    package.json 依赖里。两种布局都支持，且只认包名/依赖声明，不看
    `version` 字段，避免误把宿主产品版本当成 Core 版本。
    """
    for directory in Path(__file__).resolve().parents:
        package_path = directory / "package.json"
        if not package_path.is_file():
            continue
        package = read_package_json(package_path)
        if package.get("name") == "workflow-code":
            workspace_path = directory / "workspace" / "package.json"
            core_version = package.get("version")
            cli_version = (
                read_declared_version(read_package_json(workspace_path), "@workflow-code/cli", workspace_path)
                if workspace_path.is_file()
                else None
            )
            if not isinstance(core_version, str) or not SEMVER_PATTERN.fullmatch(core_version):
                raise SystemExit(f"{package_path} 的版本不是精确 SemVer。")
            if cli_version is None:
                raise SystemExit(f"{workspace_path} 未声明精确的 @workflow-code/cli 版本。")
            return core_version, cli_version
        core_version = read_declared_version(package, "workflow-code", package_path)
        if core_version is None:
            continue
        cli_version = read_declared_version(package, "@workflow-code/cli", package_path)
        if cli_version is None:
            raise SystemExit(f"{package_path} 未声明精确的 @workflow-code/cli 版本。")
        return core_version, cli_version
    raise SystemExit(
        "找不到 workflow-code 与 @workflow-code/cli 的精确依赖版本；"
        "请在仓库根的 package.json（或 Core 布局的 workspace/package.json）中声明它们。"
    )


def env_example() -> str:
    return '''# 在这里添加 workflow 专用环境变量。
# 保持提交此文件，只写占位值或安全的非密默认值。
'''


def interface_ts(type_name: str) -> str:
    return f'''export interface WorkflowPayload {{
  errCode: number;
  errMessage: string;
}}

export type WorkflowOutputContentType = "markdown" | "text" | "json" | "audio" | "video";

export interface WorkflowOutputDisplay {{
  type: "ring";
  placement?: "inline" | "composer-right";
}}

export interface WorkflowRingContent {{
  value: number;
  total?: number;
  unit?: string;
}}

export interface WorkflowOutputItem {{
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: WorkflowOutputContentType;
  display?: WorkflowOutputDisplay;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}}

export interface WorkflowOutputPayload extends WorkflowPayload {{
  items: WorkflowOutputItem[];
}}

export interface WorkflowTimerPayload extends WorkflowPayload {{
  timerId: string;
  title: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}}

export interface WorkflowTimerRecord extends WorkflowTimerPayload {{
  status: "running" | "success" | "failed" | "cleared";
  endedAt?: string;
  durationMs?: number;
  message?: string;
}}

export interface WorkflowExecutorResult<Output extends WorkflowPayload> {{
  ok: boolean;
  data?: Output;
  error?: unknown;
}}

export type {type_name}Input = string;

export interface {type_name}OutputPayload extends WorkflowOutputPayload {{
  success: boolean;
}}

export type {type_name}Output = WorkflowExecutorResult<{type_name}OutputPayload>;
'''


def index_ts(name: str, type_name: str, prompt: str, project_type: str) -> str:
    escaped_prompt = prompt.replace("\\", "\\\\").replace('"', '\\"')
    workflow_const = f"{to_camel_case(name)}Workflow"
    if project_type == "workflow":
        executor_definition = f'''  defaultEntrypoint: "main",
  entrypoints: [
    workflow.defineEntrypoint<{type_name}Input, {type_name}OutputPayload>({{
      id: "main",
      title: "{name}",
      // 需要把多个入口折叠成 Desktop / CLI Web 里的分区时，给同一业务域的入口
      // 声明完全一致的静态 group（必须是内联字面量，order 一旦声明就要是非负整数）：
      // group: {{ id: "operations", title: "业务操作", order: 10 }},
      workflow: {workflow_const},
      params: [
        {{
          name: "input",
          flag: "--input",
          type: "positional",
          required: false,
          description: "输入文本。",
        }},
      ],
      createInput({{ args }}) {{
        const inputArgs: string[] = [];

        for (let i = 0; i < args.length; i++) {{
          if (args[i] === "--input") {{
            const value = args[++i];

            if (value !== undefined) {{
              inputArgs.push(value);
            }}
          }} else {{
            inputArgs.push(args[i]);
          }}
        }}

        return inputArgs.join(" ");
      }},
    }}),
  ],'''
    else:
        executor_definition = f'''  workflow: {workflow_const},
  createInput({{ args }}) {{
    return workflow.parseConversationDefaultInputArgs(args).message;
  }},'''
    return f'''import type {{
  {type_name}Input,
  {type_name}OutputPayload,
}} from "./interface";

const defaultPrompt = "{escaped_prompt}";

const outputNode = workflow.createOutputNode<{type_name}Input, {type_name}OutputPayload>({{
  name: "{name}-output",
  async *stream(input) {{
    const content = input.trim() === "" ? defaultPrompt : input.trim();
    yield content;
  }},
  format(stream) {{
    const content = stream.text.trim();
    return {{
      errCode: 0,
      errMessage: "",
      items: stream.items,
      success: content !== "",
    }};
  }},
}});

export const {workflow_const} = workflow.defineWorkflow<{type_name}Input, {type_name}OutputPayload>({{
  name: "{name}",
  async run(input, context) {{
    const result = await workflow.runStreamNode(outputNode, input, context);

    return requireOutput(result.output);
  }},
}});

export const executor = workflow.defineExecutor<{type_name}Input, {type_name}OutputPayload>({{
  projectType: "{project_type}",
{executor_definition}
}});

export {{ {workflow_const} as workflow }};
export default {workflow_const};

function requireOutput(output: {type_name}OutputPayload | undefined): {type_name}OutputPayload {{
  if (output === undefined) {{
    throw new Error("输出节点没有产生输出。");
  }}

  return output;
}}
'''


def to_camel_case(name: str) -> str:
    pascal = to_pascal_case(name)
    return pascal[:1].lower() + pascal[1:]


def readme_md(name: str, description: str, project_type: str) -> str:
    input_args = '--message "input text"' if project_type == "conversation" else '"input text"'
    return f'''# {name}

{description}

项目类型：`{project_type}`。

## 运行

运行。

检查结构：

```bash
workflow-code structure .
```

执行：

```bash
workflow-code run . -- {input_args}
```

生成 JSON report：

```bash
workflow-code json . -- {input_args}
```
'''


if __name__ == "__main__":
    main()
