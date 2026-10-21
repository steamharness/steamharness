import { callStudioControlHost } from "./host-bridge";
import type { StudioControlInput, StudioControlOutputPayload } from "./interface";
import { steamharness } from "./workflow-runtime";

type ParamValues = Record<string, string | string[] | undefined>;

export const studioControlProject = steamharness.defineProject<StudioControlInput, StudioControlOutputPayload>({
  name: "studio-control",
  async run(input, context) {
    try {
      const value = await callStudioControlHost(input.operation, input.input, undefined, fetch, context.abortSignal);
      return {
        ...steamharness.createOutputPayload({ items: [{ title: input.operation, content: value, contentType: "json", collapsed: false }] }),
        operation: input.operation,
        value,
      };
    } catch (error) {
      throw new steamharness.HarnessError({
        type: typeof error === "object" && error !== null && "code" in error && error.code === "STUDIO_CONTROL_INVALID_REQUEST"
          ? "input_validation" : "execution",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
});

export const executor = steamharness.defineExecutor<StudioControlInput, StudioControlOutputPayload>({
  projectType: "workflow",
  defaultEntrypoint: "studio_state",
  entrypoints: [
    steamharness.defineEntrypoint({
      id: "get_configurations", title: "Read or export project configurations",
      description: "Project configurations for workflow, conversation and kanban, including when the panel is closed. Specify storage local with projectDir, or server with projectId and target. Query before writing; pass revision and configuration id. Supported calls: create, duplicate, rename, save (typed values and unset keys), select, delete, field.save (field and optional old key), field.delete, import (complete document). Import generates IDs and preserves selection; invalid batches are rejected. Exports include sensitive values. Read-only mode rejects mutations. Responses include version template rules, fieldCapabilities, locked reasons and author publication draft when authorized. Use get with preview:true for recipient preview; manage supports publication.save with publication draft (revision, configurationRevision, fields with sharing {publish,includeValue,editable} and JSON Pointer paths, selected configurations and defaultConfigurationId). Official publication requires online access and actual project ownership or administrator permission. Downloaders can change only permitted personal values; JSON parent replacement and imports are checked atomically.",
      workflow: studioControlProject,
      params: [{name:"input",flag:"--input",type:"string",required:true,label:"Configuration request (JSON)"}],
      createInput: ({paramValues}) => createInput("studio.configurations.get", JSON.parse(readRequiredString(paramValues,"input"))),
    }),
    steamharness.defineEntrypoint({
      id: "manage_configurations", title: "Manage project configurations",
      description: "Project configurations for workflow, conversation and kanban, including when the panel is closed. Specify storage local with projectDir, or server with projectId and target. Query before writing; pass revision and configuration id. Supported calls: create, duplicate, rename, save (typed values and unset keys), select, delete, field.save (field and optional old key), field.delete, import (complete document). Import generates IDs and preserves selection; invalid batches are rejected. Exports include sensitive values. Read-only mode rejects mutations. Responses include version template rules, fieldCapabilities, locked reasons and author publication draft when authorized. Use get with preview:true for recipient preview; manage supports publication.save with publication draft (revision, configurationRevision, fields with sharing {publish,includeValue,editable} and JSON Pointer paths, selected configurations and defaultConfigurationId). Official publication requires online access and actual project ownership or administrator permission. Downloaders can change only permitted personal values; JSON parent replacement and imports are checked atomically.",
      workflow: studioControlProject,
      params: [{name:"input",flag:"--input",type:"string",required:true,label:"Configuration request (JSON)"}],
      createInput: ({paramValues}) => createInput("studio.configurations.manage", JSON.parse(readRequiredString(paramValues,"input"))),
    }),
    steamharness.defineEntrypoint({
      id: "open_configurations", title: "Open project configurations",
      description: "Project configurations for workflow, conversation and kanban, including when the panel is closed. Specify storage local with projectDir, or server with projectId and target. Query before writing; pass revision and configuration id. Supported calls: create, duplicate, rename, save (typed values and unset keys), select, delete, field.save (field and optional old key), field.delete, import (complete document). Import generates IDs and preserves selection; invalid batches are rejected. Exports include sensitive values. Read-only mode rejects mutations. Responses include version template rules, fieldCapabilities, locked reasons and author publication draft when authorized. Use get with preview:true for recipient preview; manage supports publication.save with publication draft (revision, configurationRevision, fields with sharing {publish,includeValue,editable} and JSON Pointer paths, selected configurations and defaultConfigurationId). Official publication requires online access and actual project ownership or administrator permission. Downloaders can change only permitted personal values; JSON parent replacement and imports are checked atomically.",
      workflow: studioControlProject,
      params: [{name:"input",flag:"--input",type:"string",required:true,label:"Configuration request (JSON)"}],
      createInput: ({paramValues}) => createInput("studio.configurations.open", JSON.parse(readRequiredString(paramValues,"input"))),
    }),
    steamharness.defineEntrypoint({
      id: "studio_state",
      title: "Get Studio state",
      description: "Read this run's permission policy and path access, the assistant's workspace folders, active editor, installed themes and available Studio views. Auto approve allows paths outside the workspace. Reuse returned paths and theme names in later calls.",
      workflow: studioControlProject,
      createInput: () => createInput("studio.state.get"),
    }),
    steamharness.defineEntrypoint({
      id: "get_related_projects",
      title: "Read related projects",
      description: "Read a Workflow project's declared related projects and their current Studio import status, UUIDs, localized names and verified directories. projectDir follows the selected permission policy and defaults to the assistant working directory; auto allows projects outside the workspace. Import status does not grant project data access.",
      workflow: studioControlProject,
      params: [{ name: "projectDir", flag: "--project-dir", type: "string", required: false, label: "Project directory" }],
      createInput: ({ paramValues }) => createInput("studio.relatedProjects.get", optionalString(paramValues, "projectDir")),
    }),
    steamharness.defineEntrypoint({
      id: "open_file",
      title: "Open a file in Studio",
      description: "Open an existing file allowed by the selected permission policy and optionally reveal a one-based line and column. Auto approve allows files outside the workspace. Does not modify file contents.",
      workflow: studioControlProject,
      params: [
        { name: "filePath", flag: "--file-path", type: "string", required: true, label: "File path" },
        { name: "line", flag: "--line", type: "number", required: false, label: "Line" },
        { name: "column", flag: "--column", type: "number", required: false, label: "Column" },
      ],
      createInput: ({ paramValues }) => createInput("studio.file.open", {
        filePath: readRequiredString(paramValues, "filePath"),
        ...optionalPosition(paramValues, "line"), ...optionalPosition(paramValues, "column"),
      }),
    }),
    steamharness.defineEntrypoint({
      id: "get_diagnostics",
      title: "Read Studio diagnostics",
      description: "Read VS Code errors and warnings within the selected permission policy's path scope, optionally restricted to one file. Auto approve includes files outside the workspace. Positions are one-based; results may be truncated.",
      workflow: studioControlProject,
      params: [{ name: "filePath", flag: "--file-path", type: "string", required: false, label: "File path" }],
      createInput: ({ paramValues }) => createInput("studio.diagnostics.get", optionalString(paramValues, "filePath")),
    }),
    steamharness.defineEntrypoint({
      id: "set_theme",
      title: "Set Studio theme",
      description: "Select an installed VS Code color theme by its exact name returned by studio_state. Applies to an existing workspace override or the user's settings and switches automatic color-scheme and high-contrast detection to manual mode.",
      workflow: studioControlProject,
      params: [{ name: "theme", flag: "--theme", type: "string", required: true, label: "Theme" }],
      createInput: ({ paramValues }) => createInput("studio.theme.set", { theme: readRequiredString(paramValues, "theme") }),
    }),
    steamharness.defineEntrypoint({
      id: "open_terminal",
      title: "Open a Studio terminal",
      description: "Create and show a VS Code terminal in the assistant's workspace or another directory allowed by the selected permission policy. Auto approve allows directories outside the workspace. This tool never sends or executes commands.",
      workflow: studioControlProject,
      params: [{ name: "cwd", flag: "--cwd", type: "string", required: false, label: "Working directory" }],
      createInput: ({ paramValues }) => createInput("studio.terminal.open", optionalString(paramValues, "cwd")),
    }),
    steamharness.defineEntrypoint({
      id: "show_view",
      title: "Show a Studio view",
      description: "Focus one of Studio's supported built-in views. Only the listed views can be opened; arbitrary VS Code commands are unavailable.",
      workflow: studioControlProject,
      params: [{ name: "view", flag: "--view", type: "string", required: true, label: "View", control: "select", options: [
        { value: "explorer", label: "Explorer" }, { value: "search", label: "Search" },
        { value: "source-control", label: "Source control" }, { value: "terminal", label: "Terminal" },
        { value: "assistant", label: "Assistant" },
      ] }],
      createInput: ({ paramValues }) => createInput("studio.view.show", { view: readRequiredString(paramValues, "view") }),
    }),
  ],
});

export { studioControlProject as workflow };
export default studioControlProject;

function createInput(operation: string, input: Record<string, unknown> = {}): StudioControlInput {
  return { errCode: 0, errMessage: "", operation, input };
}

function readRequiredString(values: ParamValues, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required parameter: ${name}`);
  return value.trim();
}

function optionalString(values: ParamValues, name: string): Record<string, string> {
  if (values[name] === undefined || values[name] === "") return {};
  return { [name]: readRequiredString(values, name) };
}

function optionalPosition(values: ParamValues, name: string): Record<string, number> {
  if (values[name] === undefined || values[name] === "") return {};
  const value = Number(values[name]);
  if (Array.isArray(values[name]) || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: expected a positive integer.`);
  return { [name]: value };
}
