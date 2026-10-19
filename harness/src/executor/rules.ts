import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { projectRuntimeApi } from "../runtime-api";
import { HarnessError } from "../workflow/index";
import type {
  ConversationDefinition,
  EntrypointGroupDefinition,
  NodeRegistryItem,
  ParamDeclaration,
  ParamDefinition,
  ParamLayout,
} from "./types";
import { assertProjectParamDeclarations, normalizeProjectParamDeclarations, readProjectParamDefinitionError } from "./param-definition";
import { assertConversationFooter } from "./conversation-footer";
import { assertConversationUserInput } from "./conversation-input";
import { assertConversationCommands } from "./conversation-commands";
import { STEAMHARNESS_ENTRYPOINT_ID_PATTERN } from "./definition";
import type { TokenUsageDefinition } from "../token-usage/index";
import type { ToolPermissionDefinition } from "../tool-permissions/index";
import {
  STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE,
  assertNeverExecutorProjectKind,
  isExecutorProjectKind,
  type ExecutorProjectType,
} from "../project-types";

export type ScriptRuleViolationType =
  | "duplicate_script_declaration"
  | "duplicate_node_name"
  | "declaration_conflicts_with_node"
  | "project_output_type_not_executor_result"
  | "invalid_executor_project_type"
  | "legacy_conversation_enabled"
  | "invalid_project_entrypoints"
  | "legacy_project_executor_fields"
  | "invalid_executor_param_configuration"
  | "project_type_configuration_conflict";

export interface ScriptRuleLocation {
  file: string;
  line: number;
  column: number;
}

export interface ScriptRuleViolation {
  type: ScriptRuleViolationType;
  name: string;
  message: string;
  locations: ScriptRuleLocation[];
}

export interface DefinedNode {
  order: number;
  name: string;
  location: ScriptRuleLocation;
}

export type StructureValue =
  | {
      kind: "literal";
      value: string | number | boolean | null;
    }
  | {
      kind: "array";
      value: StructureValue[];
    }
  | {
      kind: "object";
      value: Record<string, StructureValue>;
    }
  | {
      kind: "function";
      source: string;
    }
  | {
      kind: "variable";
      name: string;
      resolved?: StructureValue;
    }
  | {
      kind: "expression";
      source: string;
    };

export type StructureReference =
  | {
      kind: "workflow-input";
      name: string;
    }
  | {
      kind: "node-output";
      callOrder: number;
      nodeId: string;
      variable: string;
    }
  | {
      kind: "variable";
      name: string;
    }
  | {
      kind: "node";
      nodeId: string;
      standardName?: string;
      callOrder: number;
    }
  | {
      kind: "workflow-output";
    }
  | {
      kind: "value";
      value: StructureValue;
    }
  | {
      kind: "expression";
      source: string;
    };

export interface StructureNode {
  id: string;
  order: number;
  standardName: string;
  configuredName?: string;
  factory: string;
  location: ScriptRuleLocation;
  options: StructureValue;
}

export interface StructureCall {
  order: number;
  callee: "runNode" | "runStreamNode" | "runIf" | "runFor" | "runWhile" | "runProject";
  nodeRef: string;
  standardName?: string;
  location: ScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: StructureReference | StructureValue;
  }>;
  input: StructureReference;
  output: StructureReference;
}

export interface StructureApiCall {
  order: number;
  method: string;
  location: ScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: StructureValue;
  }>;
  output?: StructureReference;
}

export interface StructureEdge {
  order: number;
  from: StructureReference;
  to: StructureReference;
}

export type StructureTreeItem =
  | StructureCallTreeItem
  | StructureIfTreeItem
  | StructureRunIfTreeItem
  | StructureLoopTreeItem;

export interface StructureCallTreeItem {
  kind: "call";
  order: number;
  callOrder: number;
  callee: "runNode" | "runStreamNode" | "runIf" | "runFor" | "runWhile" | "runProject";
  nodeRef: string;
  standardName?: string;
  location: ScriptRuleLocation;
  arguments: StructureCall["arguments"];
  input: StructureReference;
  output: StructureReference;
}

export interface StructureIfTreeItem {
  kind: "if";
  order: number;
  condition: string;
  location: ScriptRuleLocation;
  branches: StructureIfBranch[];
}

export interface StructureIfBranch {
  kind: "if" | "else-if" | "else";
  condition?: string;
  location: ScriptRuleLocation;
  children: StructureTreeItem[];
}

export interface StructureRunIfTreeItem {
  kind: "run-if";
  order: number;
  callOrder: number;
  callId: string;
  label?: string;
  location: ScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: StructureReference | StructureValue;
  }>;
  input: StructureReference;
  output: StructureReference;
  branches: StructureRunIfBranch[];
}

export interface StructureRunIfBranch {
  kind: "if" | "else-if" | "else";
  label?: string;
  description?: string;
  condition?: string;
  location: ScriptRuleLocation;
  children: StructureTreeItem[];
}

export interface StructureLoopTreeItem {
  kind: "loop";
  source: "run-for" | "run-while";
  order: number;
  callOrder: number;
  callId: string;
  label?: string;
  condition?: string;
  items?: string;
  maxIterations?: number;
  location: ScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: StructureReference | StructureValue;
  }>;
  input: StructureReference;
  output: StructureReference;
  children: StructureTreeItem[];
}

export interface StructureTree {
  kind: "workflow-run";
  projectRef?: string;
  projectKey?: string;
  location: ScriptRuleLocation;
  children: StructureTreeItem[];
}

export interface StructureProject {
  name: string;
  dir: string;
  files: string[];
}

export interface StructureDefinitions {
  nodes: Record<string, StructureNode>;
  apiCalls: StructureApiCall[];
  variables: Record<string, Omit<StructureVariable, "name">>;
  registry: Record<string, NodeRegistryItem>;
}

export type StructureExecutionItem =
  | StructureExecutionNode
  | StructureExecutionBranch
  | StructureExecutionLoop;

export interface StructureExecution {
  kind: "sequence";
  location?: ScriptRuleLocation;
  children: StructureExecutionItem[];
}

export interface StructureExecutionNode {
  kind: "node";
  order: number;
  callId: string;
  callOrder: number;
  callee: "runNode" | "runStreamNode" | "runIf" | "runFor" | "runWhile" | "runProject";
  nodeId: string;
  standardName?: string;
  location: ScriptRuleLocation;
  arguments: StructureCall["arguments"];
  input: StructureReference;
  output: StructureReference;
}

export interface StructureExecutionBranch {
  kind: "branch";
  source: "if" | "run-if" | "question-classifier";
  order: number;
  branchId: string;
  condition?: string;
  decision?: StructureExecutionNode;
  location: ScriptRuleLocation;
  branches: StructureExecutionBranchPath[];
}

export interface StructureExecutionBranchPath {
  kind: "if" | "else-if" | "else" | "case";
  value?: string;
  label?: string;
  description?: string;
  condition?: string;
  location: ScriptRuleLocation;
  children: StructureExecutionItem[];
}

export interface StructureExecutionLoop {
  kind: "loop";
  source: "run-for" | "run-while";
  order: number;
  loopId: string;
  label?: string;
  condition?: string;
  items?: string;
  maxIterations?: number;
  decision: StructureExecutionNode;
  location: ScriptRuleLocation;
  children: StructureExecutionItem[];
}

export interface StructureDiagnostics {
  warnings: StructureWarning[];
  violations: ScriptRuleViolation[];
}

export interface StructureVariable {
  name: string;
  location: ScriptRuleLocation;
  value: StructureValue;
}

export interface StructureWarning {
  message: string;
  location?: ScriptRuleLocation;
}

export interface StructureInspection {
  projectType?: ExecutorProjectType;
  workflow: StructureProject;
  definitions: StructureDefinitions;
  diagnostics: StructureDiagnostics;
  defaultEntrypoint?: string;
  entrypoints?: StructureEntrypoint[];
  execution?: StructureExecution;
  params?: ParamDefinition[];
  paramLayout?: ParamLayout;
  paramResolver?: { enabled: true };
  tools?: ToolPermissionDefinition[];
  conversation?: ConversationDefinition;
  tokenUsage?: TokenUsageDefinition;
  registry?: NodeRegistryItem[];
}

export interface StructureEntrypoint {
  id: string;
  title: string;
  description?: string;
  group?: EntrypointGroupDefinition;
  projectName: string;
  execution: StructureExecution;
  params?: ParamDefinition[];
  paramLayout?: ParamLayout;
  paramResolver?: { enabled: true };
  tools?: ToolPermissionDefinition[];
  tokenUsage?: TokenUsageDefinition;
  registry?: NodeRegistryItem[];
}

interface AnalyzedProjectEntrypoint extends Omit<StructureEntrypoint, "execution" | "projectName"> {
  projectRef: string;
  projectKey?: string;
  projectName?: string;
  location: ScriptRuleLocation;
}

interface ModuleBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface ModuleExportBinding {
  importedName?: string;
  localName?: string;
  moduleSpecifier?: string;
}

interface ModuleBindings {
  imports: Record<string, ModuleBinding>;
  exports: Record<string, ModuleExportBinding>;
  exportAllModuleSpecifiers: string[];
}

interface AnalyzedProjectModule {
  analysis: ScriptAnalysis;
  bindings: ModuleBindings;
  filePath: string;
  sourceFile: ts.SourceFile;
}

interface ResolvedProjectDefinition {
  key: string;
  name: string;
}

export interface ScriptInspection {
  definedNodes: DefinedNode[];
  violations: ScriptRuleViolation[];
}

export interface ValidateProjectScriptsOptions {
  cwd: string;
  projectName: string;
  projectDir: string;
}

export interface ScriptNameOccurrence {
  name: string;
  normalizedName: string;
  scopeKey: string;
  canConflictWithNode: boolean;
  location: ScriptRuleLocation;
}

export interface NodeNameOccurrence {
  name: string;
  normalizedName: string;
  location: ScriptRuleLocation;
}

export interface OutputTypeOccurrence {
  name: string;
  extendsProjectExecutorResult: boolean;
  location: ScriptRuleLocation;
}

export interface ScriptAnalysis {
  declarations: ScriptNameOccurrence[];
  nodeNames: NodeNameOccurrence[];
  definedNodes: DefinedNode[];
  projectOutputTypes: OutputTypeOccurrence[];
  structureNodes: StructureNode[];
  structureCalls: StructureCall[];
  structureApiCalls: StructureApiCall[];
  structureEdges: StructureEdge[];
  structureTrees: StructureTree[];
  structureVariables: StructureVariable[];
  structureWarnings: StructureWarning[];
  executorDefinitionCount: number;
  executorProjectType?: ExecutorProjectType;
  executorConfigurationViolations: ScriptRuleViolation[];
  executorParams?: ParamDefinition[];
  executorParamLayout?: ParamLayout;
  executorParamResolver?: { enabled: true };
  executorTools?: ToolPermissionDefinition[];
  executorConversation?: ConversationDefinition;
  executorTokenUsage?: TokenUsageDefinition;
  executorRegistry?: NodeRegistryItem[];
  executorDefaultEntrypoint?: string;
  executorEntrypoints?: AnalyzedProjectEntrypoint[];
  projectDefinitions: Record<string, string>;
}

const NODE_FACTORY_DEFAULT_NAMES = {
  createFileInputNode: "file-input",
  createDetailsOutputNode: "output",
  createInputNode: "input",
  createLLMNode: "llm",
  createLLMStreamNode: "llm-stream",
  createOutputNode: "output",
  createQuestionClassifierNode: "question-classifier",
  createUserInputNode: "user-input",
  createTimerNode: "timer",
} satisfies Record<string, string>;

const NODE_FACTORY_NAMES = new Set(Object.keys(NODE_FACTORY_DEFAULT_NAMES));
const STEAMHARNESS_RUNTIME_API_NAMES = new Set([
  ...Object.keys(projectRuntimeApi),
  "defineProjectExecutor",
]);

export function validateProjectScripts(
  options: ValidateProjectScriptsOptions,
): ScriptInspection {
  const inspection = inspectProjectScripts(options);

  if (inspection.violations.length === 0) {
    return inspection;
  }

  throw new HarnessError({
    type: "input_validation",
    message: `Workflow "${options.projectName}" script validation failed.`,
    metadata: {
      project: options.projectName,
      violations: inspection.violations,
    },
  });
}

export function inspectProjectScripts(
  options: ValidateProjectScriptsOptions,
): ScriptInspection {
  const scriptPaths = findProjectScriptPaths(options.projectDir);

  if (scriptPaths.length === 0) {
    return {
      definedNodes: [],
      violations: [createMissingExecutorViolation()],
    };
  }

  const analysis = analyzeProjectScripts(options.cwd, scriptPaths);

  return {
    definedNodes: analysis.definedNodes,
    violations: findProjectScriptRuleViolations(analysis, {
      projectName: options.projectName,
    }),
  };
}

export function inspectProjectStructure(
  options: ValidateProjectScriptsOptions,
): StructureInspection {
  const scriptPaths = findProjectScriptPaths(options.projectDir);

  if (scriptPaths.length === 0) {
    return {
      workflow: {
        name: options.projectName,
        dir: options.projectDir,
        files: [],
      },
      definitions: {
        nodes: {},
        apiCalls: [],
        variables: {},
        registry: {},
      },
      execution: {
        kind: "sequence",
        children: [],
      },
      diagnostics: {
        warnings: [],
        violations: [{
          type: "invalid_executor_project_type",
          name: "projectType",
          message: createProjectTypeRuleMessage(
            'Workflow must define an executor with projectType: "workflow" or projectType: "conversation".',
          ),
          locations: [],
        }],
      },
      conversation: undefined,
      tokenUsage: undefined,
      tools: undefined,
    };
  }

  const analysis = analyzeProjectScripts(options.cwd, scriptPaths);

  return createProjectStructureInspection({
    projectName: options.projectName,
    projectDir: options.projectDir,
    files: scriptPaths.map((scriptPath) => path.relative(options.cwd, scriptPath)),
    analysis,
  });
}

export function analyzeProjectScriptSource(
  sourceText: string,
  fileName = "index.ts",
): ScriptAnalysis {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  return analyzeSourceFile(process.cwd(), fileName, sourceFile);
}

export function validateProjectScriptSource(
  sourceText: string,
  fileName = "index.ts",
): ScriptRuleViolation[] {
  return findProjectScriptRuleViolations(
    analyzeProjectScriptSource(sourceText, fileName),
  );
}

function createProjectTypeRuleMessage(reason: string): string {
  return `${reason}\n\nMigration example:\n${STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE}`;
}

function createMissingExecutorViolation(): ScriptRuleViolation {
  return {
    type: "invalid_executor_project_type",
    name: "executor",
    message: createProjectTypeRuleMessage(
      'Project must export steamharness.defineExecutor({ projectType: "workflow" | "conversation", ... }).',
    ),
    locations: [],
  };
}

function findProjectScriptRuleViolations(
  analysis: ScriptAnalysis,
  options: {
    projectName?: string;
  } = {},
): ScriptRuleViolation[] {
  return [
    ...(analysis.executorDefinitionCount === 0 ? [createMissingExecutorViolation()] : []),
    ...analysis.executorConfigurationViolations,
    ...findDuplicateDeclarations(analysis.declarations),
    ...findDuplicateNodeNames(analysis.nodeNames),
    ...findDeclarationNodeNameConflicts(
      analysis.declarations,
      analysis.nodeNames,
    ),
    ...findUnknownProjectEntrypointReferences(analysis),
    ...findProjectOutputTypeViolations(analysis.projectOutputTypes, options),
  ];
}

function findUnknownProjectEntrypointReferences(
  analysis: ScriptAnalysis,
): ScriptRuleViolation[] {
  if (analysis.executorProjectType !== "workflow") return [];

  return (analysis.executorEntrypoints ?? []).flatMap((entrypoint) => (
    entrypoint.projectKey !== undefined &&
    Object.hasOwn(analysis.projectDefinitions, entrypoint.projectKey)
      ? []
      : [{
          type: "invalid_project_entrypoints" as const,
          name: entrypoint.id,
          message: `Workflow entrypoint "${entrypoint.id}" must reference a project defined with steamharness.defineProject(...) in this project.`,
          locations: [entrypoint.location],
        }]
  ));
}

function createProjectStructureInspection(options: {
  projectName: string;
  projectDir: string;
  files: string[];
  analysis: ScriptAnalysis;
}): StructureInspection {
  const nodeIds = new Set(options.analysis.structureNodes.map((node) => node.id));
  const nodesById = Object.fromEntries(
    options.analysis.structureNodes.map((node) => [node.id, node]),
  );
  const entrypoints = options.analysis.executorEntrypoints?.map((entrypoint) => ({
    id: entrypoint.id,
    title: entrypoint.title,
    ...(entrypoint.description === undefined ? {} : { description: entrypoint.description }),
    ...(entrypoint.group === undefined ? {} : { group: entrypoint.group }),
    projectName: entrypoint.projectName ??
      (entrypoint.projectKey === undefined
        ? undefined
        : options.analysis.projectDefinitions[entrypoint.projectKey]) ??
      entrypoint.projectRef,
    execution: createProjectStructureExecution(
      options.analysis.structureTrees.filter((tree) => (
        entrypoint.projectKey !== undefined && tree.projectKey === entrypoint.projectKey
      )),
      nodesById,
    ),
    ...(entrypoint.params === undefined ? {} : { params: entrypoint.params }),
    ...(entrypoint.paramLayout === undefined ? {} : { paramLayout: entrypoint.paramLayout }),
    ...(entrypoint.paramResolver === undefined
      ? {}
      : { paramResolver: entrypoint.paramResolver }),
    ...(entrypoint.tools === undefined ? {} : { tools: entrypoint.tools }),
    ...(entrypoint.tokenUsage === undefined ? {} : { tokenUsage: entrypoint.tokenUsage }),
    ...(entrypoint.registry === undefined ? {} : { registry: entrypoint.registry }),
  }));
  const structureRegistry = options.analysis.executorProjectType === "workflow"
    ? undefined
    : options.analysis.executorRegistry;

  return {
    projectType: options.analysis.executorProjectType,
    workflow: {
      name: options.projectName,
      dir: options.projectDir,
      files: options.files,
    },
    definitions: {
      nodes: Object.fromEntries(
        options.analysis.structureNodes.map((node) => [node.id, node]),
      ),
      apiCalls: options.analysis.structureApiCalls,
      variables: Object.fromEntries(
        options.analysis.structureVariables
          .filter((variable) => {
            return (
              !nodeIds.has(variable.name) &&
              variable.name !== "steamharness" &&
              variable.name !== "executor"
            );
          })
          .map((variable) => [
            variable.name,
            {
              location: variable.location,
              value: variable.value,
            },
          ]),
      ),
      registry: Object.fromEntries(
        (structureRegistry ?? []).map((item) => [item.name, item]),
      ),
    },
    diagnostics: {
      warnings: options.analysis.structureWarnings,
      violations: findProjectScriptRuleViolations(options.analysis, {
        projectName: options.projectName,
      }),
    },
    ...(options.analysis.executorProjectType === "workflow"
      ? {
          defaultEntrypoint: options.analysis.executorDefaultEntrypoint,
          entrypoints: entrypoints ?? [],
        }
      : {
          execution: createProjectStructureExecution(
            options.analysis.structureTrees,
            nodesById,
          ),
          params: options.analysis.executorParams,
          paramLayout: options.analysis.executorParamLayout,
          paramResolver: options.analysis.executorParamResolver,
          tools: options.analysis.executorTools,
          conversation: options.analysis.executorConversation,
          tokenUsage: options.analysis.executorTokenUsage,
          registry: options.analysis.executorRegistry,
        }),
  };
}

function createProjectStructureExecution(
  trees: StructureTree[],
  nodesById: Record<string, StructureNode>,
): StructureExecution {
  const firstTree = trees[0];

  return {
    kind: "sequence",
    location: firstTree?.location,
    children: trees.flatMap((tree) => {
      return tree.children.map((item) => {
        return convertProjectStructureTreeItem(item, nodesById);
      });
    }),
  };
}

function convertProjectStructureTreeItem(
  item: StructureTreeItem,
  nodesById: Record<string, StructureNode>,
): StructureExecutionItem {
  if (item.kind === "call") {
    const nodeItem: StructureExecutionNode = {
      kind: "node",
      order: item.order,
      callId: `call_${item.callOrder}`,
      callOrder: item.callOrder,
      callee: item.callee,
      nodeId: item.nodeRef,
      standardName: item.standardName,
      location: item.location,
      arguments: item.arguments,
      input: item.input,
      output: item.output,
    };

    return createQuestionClassifierBranchItem(nodeItem, nodesById) ?? nodeItem;
  }

  if (item.kind === "run-if") {
    const decision: StructureExecutionNode = {
      kind: "node",
      order: item.order,
      callId: item.callId,
      callOrder: item.callOrder,
      callee: "runIf",
      nodeId: "run-if",
      standardName: "run-if",
      location: item.location,
      arguments: item.arguments,
      input: item.input,
      output: item.output,
    };

    return {
      kind: "branch",
      source: "run-if",
      order: item.order,
      branchId: `run_if_${item.callOrder}`,
      condition: item.label,
      decision,
      location: item.location,
      branches: item.branches.map((branch) => ({
        kind: branch.kind,
        label: branch.label,
        description: branch.description,
        condition: branch.condition,
        location: branch.location,
        children: branch.children.map((child) => {
          return convertProjectStructureTreeItem(child, nodesById);
        }),
      })),
    };
  }

  if (item.kind === "loop") {
    const standardName = item.source;
    const callee = item.source === "run-for" ? "runFor" : "runWhile";
    const decision: StructureExecutionNode = {
      kind: "node",
      order: item.order,
      callId: item.callId,
      callOrder: item.callOrder,
      callee,
      nodeId: standardName,
      standardName,
      location: item.location,
      arguments: item.arguments,
      input: item.input,
      output: item.output,
    };

    return {
      kind: "loop",
      source: item.source,
      order: item.order,
      loopId: `loop_${item.callOrder}`,
      label: item.label,
      condition: item.condition,
      items: item.items,
      maxIterations: item.maxIterations,
      decision,
      location: item.location,
      children: item.children.map((child) => {
        return convertProjectStructureTreeItem(child, nodesById);
      }),
    };
  }

  return {
    kind: "branch",
    source: "if",
    order: item.order,
    branchId: `branch_${item.order}`,
    condition: item.condition,
    location: item.location,
    branches: item.branches.map((branch) => ({
      kind: branch.kind,
      condition: branch.condition,
      location: branch.location,
      children: branch.children.map((child) => {
        return convertProjectStructureTreeItem(child, nodesById);
      }),
    })),
  };
}

function createQuestionClassifierBranchItem(
  item: StructureExecutionNode,
  nodesById: Record<string, StructureNode>,
): StructureExecutionBranch | undefined {
  const node = nodesById[item.nodeId];

  if (node?.standardName !== "question-classifier") {
    return undefined;
  }

  const categories = readQuestionClassifierCategories(node.options);

  if (categories.length === 0) {
    return undefined;
  }

  const variableName =
    item.output.kind === "variable" ? item.output.name : undefined;

  return {
    kind: "branch",
    source: "question-classifier",
    order: item.order,
    branchId: `branch_${item.order}`,
    condition: variableName,
    decision: item,
    location: item.location,
    branches: categories.map((category) => ({
      kind: "case" as const,
      value: category.name,
      label: category.name,
      description: category.description,
      condition:
        variableName === undefined
          ? undefined
          : `${variableName} === ${JSON.stringify(category.name)}`,
      location: item.location,
      children: [],
    })),
  };
}

function readQuestionClassifierCategories(
  options: StructureValue,
): Array<{
  name: string;
  description: string;
}> {
  if (options.kind !== "object") {
    return [];
  }

  const categories = resolveStructureValue(options.value.categories);

  if (categories?.kind !== "array") {
    return [];
  }

  return categories.value.flatMap((category) => {
    const resolvedCategory = resolveStructureValue(category);

    if (resolvedCategory?.kind !== "object") {
      return [];
    }

    const name = resolveStructureValue(resolvedCategory.value.name);
    const description = resolveStructureValue(resolvedCategory.value.description);

    if (
      name?.kind !== "literal" ||
      typeof name.value !== "string" ||
      description?.kind !== "literal" ||
      typeof description.value !== "string"
    ) {
      return [];
    }

    return [
      {
        name: name.value,
        description: description.value,
      },
    ];
  });
}

function resolveStructureValue(
  value: StructureValue | undefined,
): StructureValue | undefined {
  if (value?.kind === "variable" && value.resolved !== undefined) {
    return resolveStructureValue(value.resolved);
  }

  return value;
}

function analyzeProjectScripts(cwd: string, scriptPaths: string[]): ScriptAnalysis {
  const analysis: ScriptAnalysis = {
    declarations: [],
    nodeNames: [],
    definedNodes: [],
    projectOutputTypes: [],
    structureNodes: [],
    structureCalls: [],
    structureApiCalls: [],
    structureEdges: [],
    structureTrees: [],
    structureVariables: [],
    structureWarnings: [],
    executorDefinitionCount: 0,
    executorProjectType: undefined,
    executorConfigurationViolations: [],
    executorParams: undefined,
    executorParamResolver: undefined,
    executorTools: undefined,
    executorConversation: undefined,
    executorTokenUsage: undefined,
    executorRegistry: undefined,
    executorDefaultEntrypoint: undefined,
    executorEntrypoints: undefined,
    projectDefinitions: {},
  };

  const modules = scriptPaths.map((scriptPath): AnalyzedProjectModule => {
    const sourceText = readFileSync(scriptPath, "utf8");
    const sourceFile = ts.createSourceFile(
      scriptPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return {
      analysis: analyzeSourceFile(cwd, scriptPath, sourceFile),
      bindings: collectProjectModuleBindings(sourceFile),
      filePath: path.resolve(scriptPath),
      sourceFile,
    };
  });
  const modulesByPath = new Map(modules.map((module) => [module.filePath, module]));

  for (const module of modules) {
    for (const entrypoint of module.analysis.executorEntrypoints ?? []) {
      const definition = resolveProjectDefinition({
        filePath: module.filePath,
        localName: entrypoint.projectRef,
        modulesByPath,
      });
      entrypoint.projectKey = definition?.key;
      entrypoint.projectName = definition?.name;
    }
  }

  for (const module of modules) {
    const scriptPath = module.filePath;
    const fileAnalysis = module.analysis;
    const sourceFile = module.sourceFile;
    const definedNodeOffset = analysis.definedNodes.length;
    const structureNodeOffset = analysis.structureNodes.length;
    const structureCallOffset = analysis.structureCalls.length;
    const structureApiCallOffset = analysis.structureApiCalls.length;
    const structureEdgeOffset = analysis.structureEdges.length;

    analysis.declarations.push(...fileAnalysis.declarations);
    analysis.nodeNames.push(...fileAnalysis.nodeNames);
    analysis.definedNodes.push(
      ...fileAnalysis.definedNodes.map((node) => ({
        ...node,
        order: definedNodeOffset + node.order,
      })),
    );
    analysis.projectOutputTypes.push(...fileAnalysis.projectOutputTypes);
    analysis.structureNodes.push(
      ...fileAnalysis.structureNodes.map((node) => ({
        ...node,
        order: structureNodeOffset + node.order,
      })),
    );
    analysis.structureCalls.push(
      ...fileAnalysis.structureCalls.map((call) => ({
        ...call,
        order: structureCallOffset + call.order,
        arguments: call.arguments.map((argument) => ({
          ...argument,
          value: offsetStructureReferenceCallOrder(
            argument.value,
            structureCallOffset,
          ),
        })),
        input: offsetStructureReferenceCallOrder(call.input, structureCallOffset),
        output: offsetStructureReferenceCallOrder(call.output, structureCallOffset),
      })),
    );
    analysis.structureApiCalls.push(
      ...fileAnalysis.structureApiCalls.map((call) => ({
        ...call,
        order: structureApiCallOffset + call.order,
        output: call.output === undefined
          ? undefined
          : offsetStructureReferenceCallOrder(call.output, structureCallOffset),
      })),
    );
    analysis.structureEdges.push(
      ...fileAnalysis.structureEdges.map((edge) => ({
        ...edge,
        order: structureEdgeOffset + edge.order,
        from: offsetStructureReferenceCallOrder(edge.from, structureCallOffset),
        to: offsetStructureReferenceCallOrder(edge.to, structureCallOffset),
      })),
    );
    analysis.structureTrees.push(
      ...fileAnalysis.structureTrees.map((tree) => {
        return offsetProjectStructureTreeCallOrder(tree, structureCallOffset);
      }),
    );
    analysis.structureVariables.push(...fileAnalysis.structureVariables);
    analysis.structureWarnings.push(...fileAnalysis.structureWarnings);
    analysis.executorDefinitionCount += fileAnalysis.executorDefinitionCount;
    analysis.executorConfigurationViolations.push(...fileAnalysis.executorConfigurationViolations);

    if (fileAnalysis.executorProjectType) {
      if (
        analysis.executorProjectType !== undefined &&
        analysis.executorProjectType !== fileAnalysis.executorProjectType
      ) {
        analysis.structureWarnings.push({
          message: `Workflow sources declare conflicting executor project types: ${analysis.executorProjectType}, ${fileAnalysis.executorProjectType}. The first type will be used for structure preview.`,
          location: createLocation(cwd, scriptPath, sourceFile, sourceFile),
        });
      } else {
        analysis.executorProjectType = fileAnalysis.executorProjectType;
      }
    }

    if (fileAnalysis.executorParams && !analysis.executorParams) {
      analysis.executorParams = fileAnalysis.executorParams;
      analysis.executorParamLayout = fileAnalysis.executorParamLayout;
    }
    if (fileAnalysis.executorParamResolver && !analysis.executorParamResolver) {
      analysis.executorParamResolver = fileAnalysis.executorParamResolver;
    }
    if (fileAnalysis.executorTools && !analysis.executorTools) {
      analysis.executorTools = fileAnalysis.executorTools;
    }
    if (fileAnalysis.executorConversation && !analysis.executorConversation) {
      analysis.executorConversation = fileAnalysis.executorConversation;
    }
    if (fileAnalysis.executorTokenUsage && !analysis.executorTokenUsage) {
      analysis.executorTokenUsage = fileAnalysis.executorTokenUsage;
    }
    if (fileAnalysis.executorRegistry && !analysis.executorRegistry) {
      analysis.executorRegistry = fileAnalysis.executorRegistry;
    }
    if (fileAnalysis.executorDefaultEntrypoint && !analysis.executorDefaultEntrypoint) {
      analysis.executorDefaultEntrypoint = fileAnalysis.executorDefaultEntrypoint;
    }
    if (fileAnalysis.executorEntrypoints && !analysis.executorEntrypoints) {
      analysis.executorEntrypoints = fileAnalysis.executorEntrypoints;
    }
    for (const [projectKey, projectName] of Object.entries(fileAnalysis.projectDefinitions)) {
      analysis.projectDefinitions[projectKey] = projectName;
    }
  }

  return analysis;
}

function collectProjectModuleBindings(sourceFile: ts.SourceFile): ModuleBindings {
  const bindings: ModuleBindings = {
    imports: {},
    exports: {},
    exportAllModuleSpecifiers: [],
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.importClause !== undefined &&
      !statement.importClause.isTypeOnly
    ) {
      const moduleSpecifier = statement.moduleSpecifier.text;
      if (statement.importClause.name !== undefined) {
        bindings.imports[statement.importClause.name.text] = {
          importedName: "default",
          moduleSpecifier,
        };
      }
      const namedBindings = statement.importClause.namedBindings;
      if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (element.isTypeOnly) continue;
          bindings.imports[element.name.text] = {
            importedName: element.propertyName?.text ?? element.name.text,
            moduleSpecifier,
          };
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        bindings.exports[declaration.name.text] = { localName: declaration.name.text };
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrapExpression(statement.expression);
      if (ts.isIdentifier(expression)) {
        bindings.exports.default = { localName: expression.text };
      } else if (isProjectDefineProjectCall(expression)) {
        bindings.exports.default = { localName: "default" };
      }
      continue;
    }

    if (!ts.isExportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : undefined;
    if (statement.exportClause === undefined) {
      if (moduleSpecifier !== undefined) {
        bindings.exportAllModuleSpecifiers.push(moduleSpecifier);
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      bindings.exports[element.name.text] = moduleSpecifier === undefined
        ? { localName: importedName }
        : { importedName, moduleSpecifier };
    }
  }

  return bindings;
}

function resolveProjectDefinition(options: {
  filePath: string;
  localName: string;
  modulesByPath: Map<string, AnalyzedProjectModule>;
}): ResolvedProjectDefinition | undefined {
  return resolveLocal(options.filePath, options.localName, new Set<string>());

  function resolveLocal(
    filePath: string,
    localName: string,
    visited: Set<string>,
  ): ResolvedProjectDefinition | undefined {
    const visitKey = `local\0${filePath}\0${localName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    const module = options.modulesByPath.get(filePath);
    if (module === undefined) return undefined;
    const definitionKey = createProjectDefinitionKey(filePath, localName);
    const projectName = module.analysis.projectDefinitions[definitionKey];
    if (projectName !== undefined) {
      return { key: definitionKey, name: projectName };
    }

    const imported = module.bindings.imports[localName];
    if (imported === undefined) return undefined;
    const importedFilePath = resolveProjectModulePath(
      filePath,
      imported.moduleSpecifier,
      options.modulesByPath,
    );
    return importedFilePath === undefined
      ? undefined
      : resolveExport(importedFilePath, imported.importedName, visited);
  }

  function resolveExport(
    filePath: string,
    exportedName: string,
    visited: Set<string>,
  ): ResolvedProjectDefinition | undefined {
    const visitKey = `export\0${filePath}\0${exportedName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    const module = options.modulesByPath.get(filePath);
    if (module === undefined) return undefined;
    const exported = module.bindings.exports[exportedName];
    if (exported?.localName !== undefined) {
      return resolveLocal(filePath, exported.localName, visited);
    }
    if (exported?.moduleSpecifier !== undefined && exported.importedName !== undefined) {
      const exportedFilePath = resolveProjectModulePath(
        filePath,
        exported.moduleSpecifier,
        options.modulesByPath,
      );
      return exportedFilePath === undefined
        ? undefined
        : resolveExport(exportedFilePath, exported.importedName, visited);
    }

    let resolved: ResolvedProjectDefinition | undefined;
    for (const moduleSpecifier of module.bindings.exportAllModuleSpecifiers) {
      const exportedFilePath = resolveProjectModulePath(
        filePath,
        moduleSpecifier,
        options.modulesByPath,
      );
      if (exportedFilePath === undefined) continue;
      const candidate = resolveExport(exportedFilePath, exportedName, new Set(visited));
      if (candidate === undefined) continue;
      if (resolved !== undefined && resolved.key !== candidate.key) return undefined;
      resolved = candidate;
    }
    return resolved;
  }
}

function resolveProjectModulePath(
  fromFilePath: string,
  moduleSpecifier: string,
  modulesByPath: Map<string, AnalyzedProjectModule>,
): string | undefined {
  if (!moduleSpecifier.startsWith(".")) return undefined;

  const basePath = path.resolve(path.dirname(fromFilePath), moduleSpecifier);
  const candidates = [basePath];
  const extension = path.extname(basePath);
  if (extension === "") {
    candidates.push(`${basePath}.ts`, path.join(basePath, "index.ts"));
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const sourceBasePath = basePath.slice(0, -extension.length);
    candidates.push(`${sourceBasePath}.ts`, path.join(sourceBasePath, "index.ts"));
  }

  return candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => modulesByPath.has(candidate));
}

function createProjectDefinitionKey(filePath: string, localName: string): string {
  return `${path.resolve(filePath)}\0${localName}`;
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function offsetStructureReferenceCallOrder<
  Value extends StructureReference | StructureValue,
>(value: Value, offset: number): Value {
  if (offset === 0) {
    return value;
  }

  if (value.kind === "node" || value.kind === "node-output") {
    return {
      ...value,
      callOrder: value.callOrder + offset,
    } as Value;
  }

  return value;
}

function offsetProjectStructureTreeCallOrder(
  tree: StructureTree,
  callOffset: number,
): StructureTree {
  if (callOffset === 0) {
    return tree;
  }

  return {
    ...tree,
    children: tree.children.map((item) => {
      return offsetProjectStructureTreeItemCallOrder(item, callOffset);
    }),
  };
}

function offsetProjectStructureTreeItemCallOrder(
  item: StructureTreeItem,
  callOffset: number,
): StructureTreeItem {
  if (item.kind === "call") {
    return {
      ...item,
      callOrder: item.callOrder + callOffset,
      arguments: item.arguments.map((argument) => ({
        ...argument,
        value: offsetStructureReferenceCallOrder(argument.value, callOffset),
      })),
      input: offsetStructureReferenceCallOrder(item.input, callOffset),
      output: offsetStructureReferenceCallOrder(item.output, callOffset),
    };
  }

  if (item.kind === "run-if") {
    const callOrder = item.callOrder + callOffset;

    return {
      ...item,
      callOrder,
      callId: `call_${callOrder}`,
      arguments: item.arguments.map((argument) => ({
        ...argument,
        value: offsetStructureReferenceCallOrder(argument.value, callOffset),
      })),
      input: offsetStructureReferenceCallOrder(item.input, callOffset),
      output: offsetStructureReferenceCallOrder(item.output, callOffset),
      branches: item.branches.map((branch) => ({
        ...branch,
        children: branch.children.map((child) => {
          return offsetProjectStructureTreeItemCallOrder(child, callOffset);
        }),
      })),
    };
  }

  if (item.kind === "loop") {
    const callOrder = item.callOrder + callOffset;

    return {
      ...item,
      callOrder,
      callId: `call_${callOrder}`,
      arguments: item.arguments.map((argument) => ({
        ...argument,
        value: offsetStructureReferenceCallOrder(argument.value, callOffset),
      })),
      input: offsetStructureReferenceCallOrder(item.input, callOffset),
      output: offsetStructureReferenceCallOrder(item.output, callOffset),
      children: item.children.map((child) => {
        return offsetProjectStructureTreeItemCallOrder(child, callOffset);
      }),
    };
  }

  return {
    ...item,
    branches: item.branches.map((branch) => ({
      ...branch,
      children: branch.children.map((child) => {
        return offsetProjectStructureTreeItemCallOrder(child, callOffset);
      }),
    })),
  };
}

function analyzeSourceFile(
  cwd: string,
  filePath: string,
  sourceFile: ts.SourceFile,
): ScriptAnalysis {
  const analysis: ScriptAnalysis = {
    declarations: [],
    nodeNames: [],
    definedNodes: [],
    projectOutputTypes: [],
    structureNodes: [],
    structureCalls: [],
    structureApiCalls: [],
    structureEdges: [],
    structureTrees: [],
    structureVariables: [],
    structureWarnings: [],
    executorDefinitionCount: 0,
    executorProjectType: undefined,
    executorConfigurationViolations: [],
    executorParams: undefined,
    executorParamResolver: undefined,
    executorTools: undefined,
    executorConversation: undefined,
    executorTokenUsage: undefined,
    executorRegistry: undefined,
    executorDefaultEntrypoint: undefined,
    executorEntrypoints: undefined,
    projectDefinitions: {},
  };
  const scopeStack = [createScopeKey(filePath, "source", 0)];
  const constValues = new Map<string, StructureValue>();
  const nodeIdsByVariable = new Map<string, string>();
  const nodeNamesById = new Map<string, string>();
  const outputVariables = new Map<string, StructureReference>();
  const projectInputNames = new Set<string>();
  const structureCallsByNode = new WeakMap<ts.CallExpression, StructureCall>();
  const structureProjectCallsByNode = new WeakMap<ts.CallExpression, StructureCall>();
  const structureRunIfByNode = new WeakMap<ts.CallExpression, StructureRunIfTreeItem>();
  const structureLoopByNode = new WeakMap<ts.CallExpression, StructureLoopTreeItem>();
  let treeItemOrder = 0;

  visitSourceFile(sourceFile);
  collectProjectRunTrees(sourceFile);

  return analysis;

  function visitSourceFile(node: ts.Node): void {
    collectDeclaration(node);
    collectTopLevelConst(node);
    collectProjectDefinitionMetadata(node);
    collectNodeName(node);
    collectProjectOutputType(node);
    collectProjectApiCall(node);
    collectRunNodeCall(node);
    collectRunProjectCall(node);
    collectRunIfCall(node);
    collectRunLoopCall(node);
    collectExecutorParams(node);
    collectExecutorParamResolver(node);
    collectExecutorTools(node);
    collectExecutorProjectType(node);
    collectExecutorConversation(node);
    collectExecutorTokenUsage(node);
    collectExecutorRegistry(node);

    if (createsDeclarationScope(node)) {
      collectProjectRunInputNames(node);
      withScope(node, () => {
        ts.forEachChild(node, visitSourceFile);
      });
      return;
    }

    ts.forEachChild(node, visitSourceFile);
  }

  function collectDeclaration(node: ts.Node): void {
    const names = readDeclarationNames(node);

    if (names.length === 0) {
      return;
    }

    for (const name of names) {
      analysis.declarations.push({
        name,
        normalizedName: normalizeComparableName(name),
        scopeKey: currentScopeKey(),
        canConflictWithNode: canDeclarationConflictWithNode(node),
        location: createLocation(cwd, filePath, sourceFile, node),
      });
    }
  }

  function collectNodeName(node: ts.Node): void {
    if (!ts.isCallExpression(node)) {
      return;
    }

    const factoryName = readNodeFactoryName(node.expression);

    if (factoryName === undefined) {
      return;
    }

    const location = createLocation(cwd, filePath, sourceFile, node);
    const standardName = NODE_FACTORY_DEFAULT_NAMES[
      factoryName as keyof typeof NODE_FACTORY_DEFAULT_NAMES
    ];
    const nodeName = readNodeNameFromFactoryCall(node, factoryName);

    analysis.definedNodes.push({
      order: analysis.definedNodes.length + 1,
      name: standardName,
      location,
    });

    const id = readAssignedVariableName(node) ?? `${standardName}-${analysis.structureNodes.length + 1}`;
    nodeIdsByVariable.set(id, id);
    nodeNamesById.set(id, standardName);
    analysis.structureNodes.push({
      id,
      order: analysis.structureNodes.length + 1,
      standardName,
      configuredName: nodeName,
      factory: factoryName,
      location,
      options: readNodeOptions(node),
    });

    if (nodeName === undefined) {
      return;
    }

    analysis.nodeNames.push({
      name: nodeName,
      normalizedName: normalizeComparableName(nodeName),
      location,
    });
  }

  function collectProjectOutputType(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node)) {
      analysis.projectOutputTypes.push({
        name: node.name.text,
        extendsProjectExecutorResult: isProjectExecutorResultTypeNode(node.type),
        location: createLocation(cwd, filePath, sourceFile, node),
      });
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      analysis.projectOutputTypes.push({
        name: node.name.text,
        extendsProjectExecutorResult: interfaceExtendsProjectExecutorResult(node),
        location: createLocation(cwd, filePath, sourceFile, node),
      });
    }
  }

  function withScope(node: ts.Node, visit: () => void): void {
    scopeStack.push(createScopeKey(filePath, node.kind.toString(), node.pos));

    try {
      visit();
    } finally {
      scopeStack.pop();
    }
  }

  function currentScopeKey(): string {
    return scopeStack[scopeStack.length - 1] ?? filePath;
  }

  function collectTopLevelConst(node: ts.Node): void {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.initializer === undefined ||
      currentScopeKey() !== scopeStack[0]
    ) {
      return;
    }

    const value = evaluateExpression(node.initializer);

    constValues.set(node.name.text, value);
    analysis.structureVariables.push({
      name: node.name.text,
      location: createLocation(cwd, filePath, sourceFile, node),
      value,
    });
  }

  function collectProjectDefinitionMetadata(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      !isProjectDefineProjectCall(node) ||
      currentScopeKey() !== scopeStack[0]
    ) {
      return;
    }
    const variableName = readProjectDefinitionBindingName(node);
    const objectArg = node.arguments[0];
    if (variableName === undefined) return;
    const projectOptions = objectArg === undefined ? undefined : unwrapExpression(objectArg);
    const projectName = projectOptions !== undefined && ts.isObjectLiteralExpression(projectOptions)
      ? readStringProperty(projectOptions, "name")
      : undefined;
    analysis.projectDefinitions[createProjectDefinitionKey(filePath, variableName)] =
      projectName ?? variableName;
  }

  function collectExecutorParams(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      analysis.executorParams !== undefined
    ) {
      return;
    }

    if (!isProjectDefineExecutorCall(node)) {
      return;
    }

    const objectArg = node.arguments[0];

    if (objectArg === undefined || !ts.isObjectLiteralExpression(objectArg)) {
      return;
    }

    const paramsProperty = objectArg.properties.find(
      (prop): prop is ts.PropertyAssignment =>
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "params",
    );

    if (paramsProperty === undefined) return;
    const normalized = readExecutorParamDeclarations(paramsProperty, "Conversation executor");
    if (normalized !== undefined) {
      analysis.executorParams = normalized.params;
      analysis.executorParamLayout = normalized.layout;
    }
  }

  function collectExecutorParamResolver(node: ts.Node): void {
    if (!ts.isCallExpression(node) || analysis.executorParamResolver !== undefined) return;
    if (!isProjectDefineExecutorCall(node)) return;
    const objectArg = node.arguments[0];
    if (!objectArg || !ts.isObjectLiteralExpression(objectArg)) return;
    const resolver = objectArg.properties.find((property) => (
      (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "resolveParams"
    ));
    if (resolver) analysis.executorParamResolver = { enabled: true };
  }

  function collectExecutorTools(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      analysis.executorTools !== undefined
    ) {
      return;
    }

    if (!isProjectDefineExecutorCall(node)) {
      return;
    }

    const objectArg = node.arguments[0];

    if (objectArg === undefined || !ts.isObjectLiteralExpression(objectArg)) {
      return;
    }

    const toolsProperty = objectArg.properties.find(
      (prop): prop is ts.PropertyAssignment =>
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "tools",
    );

    if (toolsProperty === undefined || !ts.isArrayLiteralExpression(toolsProperty.initializer)) {
      return;
    }

    const tools: ToolPermissionDefinition[] = [];

    for (const element of toolsProperty.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        continue;
      }

      const tool = readToolPermissionObject(element);

      if (tool !== undefined) {
        tools.push(tool);
      }
    }

    if (tools.length > 0) {
      // Expose registered tool permissions through the structure
      // report so local hosts can render their policy controls.
      analysis.executorTools = tools;
    }
  }

  function collectExecutorConversation(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      analysis.executorConversation !== undefined
    ) {
      return;
    }

    if (!isProjectDefineExecutorCall(node)) {
      return;
    }

    const objectArg = node.arguments[0];

    if (objectArg === undefined || !ts.isObjectLiteralExpression(objectArg)) {
      return;
    }

    const conversationProperty = findStaticPropertyAssignment(objectArg, "conversation");

    if (
      conversationProperty === undefined ||
      !ts.isObjectLiteralExpression(conversationProperty.initializer)
    ) {
      return;
    }

    const attachments = readConversationAttachmentsProperty(
      conversationProperty.initializer,
    );
    const inputQueue = readConversationInputQueueProperty(
      conversationProperty.initializer,
    );
    const openai = readConversationOpenAIProperty(
      conversationProperty.initializer,
    );
    const footer = readConversationFooterProperty(conversationProperty.initializer);
    const commands = readConversationCommandsProperty(conversationProperty.initializer);
    const userInput = readConversationUserInputProperty(conversationProperty.initializer);
    const recoveryProperty = findStaticPropertyAssignment(conversationProperty.initializer, "recovery");
    const recovery = recoveryProperty !== undefined && ts.isObjectLiteralExpression(recoveryProperty.initializer)
      && readBooleanProperty(recoveryProperty.initializer, "enabled") === true ? { enabled: true as const } : undefined;
    const durableProperty = findStaticPropertyAssignment(conversationProperty.initializer, "durable");
    const durable = durableProperty !== undefined && ts.isObjectLiteralExpression(durableProperty.initializer)
      && readBooleanProperty(durableProperty.initializer, "enabled") === true ? { enabled: true as const } : undefined;
    if (durable !== undefined || recovery !== undefined || attachments !== undefined || inputQueue !== undefined || openai !== undefined || footer !== undefined || commands !== undefined || userInput !== undefined) {
      analysis.executorConversation = {
        ...(durable === undefined ? {} : { durable }),
        ...(recovery === undefined ? {} : { recovery }),
        ...(attachments === undefined ? {} : { attachments }),
        ...(inputQueue === undefined ? {} : { inputQueue }),
        ...(openai === undefined ? {} : { openai }),
        ...(footer === undefined ? {} : { footer }),
        ...(commands === undefined ? {} : { commands }),
        ...(userInput === undefined ? {} : { userInput }),
      };
    }
  }

  function collectExecutorProjectType(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isProjectDefineExecutorCall(node)) {
      return;
    }

    analysis.executorDefinitionCount += 1;
    const objectArg = node.arguments[0];
    if (objectArg === undefined || !ts.isObjectLiteralExpression(objectArg)) {
      analysis.structureWarnings.push({
        message: "Executor project type could not be read statically and will be resolved at runtime.",
        location: createLocation(cwd, filePath, sourceFile, node),
      });
      return;
    }

    const location = createLocation(cwd, filePath, sourceFile, node);
    const projectTypeProperty = findStaticPropertyAssignment(objectArg, "projectType");
    const conversationProperty = findStaticPropertyAssignment(objectArg, "conversation");

    const declaredProjectType = projectTypeProperty !== undefined && ts.isStringLiteralLike(projectTypeProperty.initializer)
      ? projectTypeProperty.initializer.text
      : undefined;
    const projectType = isExecutorProjectKind(declaredProjectType)
      ? declaredProjectType
      : inferStaticExecutorProjectType(objectArg);
    if (projectTypeProperty === undefined || !isExecutorProjectKind(declaredProjectType)) {
      analysis.structureWarnings.push({
        message: projectType === undefined
          ? "Executor project type could not be inferred statically and will be resolved at runtime."
          : `Executor project type was inferred as "${projectType}" for compatibility.`,
        location: projectTypeProperty === undefined
          ? location
          : createLocation(cwd, filePath, sourceFile, projectTypeProperty),
      });
    }
    if (projectType === undefined) {
      return;
    }

    if (
      analysis.executorProjectType !== undefined &&
      analysis.executorProjectType !== projectType
    ) {
      analysis.structureWarnings.push({
        message: `Workflow source declares conflicting executor project types: ${analysis.executorProjectType}, ${projectType}. The first type will be used for structure preview.`,
        location: projectTypeProperty === undefined
          ? location
          : createLocation(cwd, filePath, sourceFile, projectTypeProperty),
      });
    } else {
      analysis.executorProjectType = projectType;
    }

    if (conversationProperty !== undefined) {
      if (!ts.isObjectLiteralExpression(conversationProperty.initializer)) {
        analysis.executorConfigurationViolations.push({
          type: "project_type_configuration_conflict",
          name: "conversation",
          message: "Executor conversation settings must be an object literal.",
          locations: [createLocation(cwd, filePath, sourceFile, conversationProperty)],
        });
        return;
      }

      const enabledProperty = findStaticPropertyAssignment(
        conversationProperty.initializer,
        "enabled",
      );
      if (enabledProperty !== undefined) {
        analysis.structureWarnings.push({
          message: "Legacy conversation.enabled is ignored; the inferred executor project type controls conversation behavior.",
          location: createLocation(cwd, filePath, sourceFile, enabledProperty),
        });
      }

      const defaultInputProperty = findStaticPropertyAssignment(conversationProperty.initializer, "defaultInput");
      if (defaultInputProperty !== undefined) {
        analysis.executorConfigurationViolations.push({
          type: "project_type_configuration_conflict",
          name: "defaultInput",
          message: "conversation.defaultInput was removed. Conversation always uses the standard message input; declare attachment capabilities in conversation.attachments.",
          locations: [createLocation(cwd, filePath, sourceFile, defaultInputProperty)],
        });
      }

      switch (projectType) {
        case "conversation":
          break;
        case "workflow":
          analysis.structureWarnings.push({
            message: 'Conversation settings are ignored when the executor project type is "workflow".',
            location: createLocation(cwd, filePath, sourceFile, conversationProperty),
          });
          break;
        default:
          assertNeverExecutorProjectKind(projectType);
      }
    }

    if (projectType === "workflow") {
      collectProjectEntrypoints(objectArg, location);
    }
  }

  function inferStaticExecutorProjectType(
    executorObject: ts.ObjectLiteralExpression,
  ): ExecutorProjectType | undefined {
    if (findStaticPropertyAssignment(executorObject, "entrypoints") !== undefined
        || findStaticPropertyAssignment(executorObject, "defaultEntrypoint") !== undefined) {
      return "workflow";
    }
    if (findStaticPropertyAssignment(executorObject, "conversation") !== undefined
        || findStaticPropertyAssignment(executorObject, "workflow") !== undefined
        || findStaticPropertyAssignment(executorObject, "createInput") !== undefined) {
      return "conversation";
    }
    return undefined;
  }

  function collectProjectEntrypoints(
    executorObject: ts.ObjectLiteralExpression,
    executorLocation: ScriptRuleLocation,
  ): void {
    const legacyKeys = [
      "workflow",
      "params",
      "createInput",
      "resolveParams",
      "requiredProviders",
      "tools",
      "tokenUsage",
      "registry",
      "createContext",
    ];
    for (const key of legacyKeys) {
      const property = findStaticPropertyAssignment(executorObject, key);
      if (property !== undefined) {
        analysis.executorConfigurationViolations.push({
          type: "legacy_project_executor_fields",
          name: key,
          message: `Workflow executors no longer accept top-level ${key}. Move it into workflow.defineEntrypoint(...).`,
          locations: [createLocation(cwd, filePath, sourceFile, property)],
        });
      }
    }

    const defaultProperty = findStaticPropertyAssignment(executorObject, "defaultEntrypoint");
    if (
      defaultProperty === undefined ||
      !ts.isStringLiteralLike(defaultProperty.initializer)
    ) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: "defaultEntrypoint",
        message: "Workflow executor defaultEntrypoint must be a static string literal.",
        locations: [defaultProperty === undefined
          ? executorLocation
          : createLocation(cwd, filePath, sourceFile, defaultProperty)],
      });
    } else {
      analysis.executorDefaultEntrypoint = defaultProperty.initializer.text;
    }

    const entrypointsProperty = findStaticPropertyAssignment(executorObject, "entrypoints");
    if (
      entrypointsProperty === undefined ||
      !ts.isArrayLiteralExpression(entrypointsProperty.initializer)
    ) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: "entrypoints",
        message: "Workflow executor entrypoints must be a non-empty static array.",
        locations: [entrypointsProperty === undefined
          ? executorLocation
          : createLocation(cwd, filePath, sourceFile, entrypointsProperty)],
      });
      return;
    }
    if (entrypointsProperty.initializer.elements.length === 0) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: "entrypoints",
        message: "Workflow executor entrypoints must contain at least one entrypoint.",
        locations: [createLocation(cwd, filePath, sourceFile, entrypointsProperty)],
      });
      return;
    }

    const entrypoints: AnalyzedProjectEntrypoint[] = [];
    const ids = new Set<string>();
    const groups = new Map<string, {
      definition: EntrypointGroupDefinition;
      location: ScriptRuleLocation;
    }>();
    for (const element of entrypointsProperty.initializer.elements) {
      if (
        !ts.isCallExpression(element) ||
        readProjectApiCallName(element.expression) !== "defineEntrypoint"
      ) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: "entrypoints",
          message: "Each entrypoints element must directly call steamharness.defineEntrypoint({...}).",
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
        continue;
      }
      const entrypointObject = element.arguments[0];
      if (entrypointObject === undefined || !ts.isObjectLiteralExpression(entrypointObject)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: "entrypoints",
          message: "steamharness.defineEntrypoint(...) must receive an inline object literal.",
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
        continue;
      }
      const id = readStringProperty(entrypointObject, "id");
      const title = readStringProperty(entrypointObject, "title");
      const descriptionProperty = entrypointObject.properties.find((property) =>
        hasPropertyName(property) && readStructurePropertyName(property.name) === "description"
      );
      const groupProperty = entrypointObject.properties.find((property) =>
        hasPropertyName(property) && readStructurePropertyName(property.name) === "group"
      );
      const projectRef = readIdentifierProperty(entrypointObject, "workflow");
      if (id === undefined || !STEAMHARNESS_ENTRYPOINT_ID_PATTERN.test(id)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: id ?? "id",
          message: `Workflow entrypoint id must match ${STEAMHARNESS_ENTRYPOINT_ID_PATTERN}.`,
          locations: [createLocation(cwd, filePath, sourceFile, entrypointObject)],
        });
        continue;
      }
      if (ids.has(id)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: id,
          message: `Workflow executor declares duplicate entrypoint id "${id}".`,
          locations: [createLocation(cwd, filePath, sourceFile, entrypointObject)],
        });
        continue;
      }
      ids.add(id);
      if (title === undefined || title.trim() === "") {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: id,
          message: `Workflow entrypoint "${id}" must declare a non-empty static title.`,
          locations: [createLocation(cwd, filePath, sourceFile, entrypointObject)],
        });
        continue;
      }
      if (
        descriptionProperty !== undefined &&
        (
          !ts.isPropertyAssignment(descriptionProperty) ||
          !ts.isStringLiteralLike(unwrapExpression(descriptionProperty.initializer))
        )
      ) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: id,
          message: `Workflow entrypoint "${id}" description must be a static string literal when provided.`,
          locations: [createLocation(cwd, filePath, sourceFile, descriptionProperty)],
        });
        continue;
      }
      const group = readEntrypointGroup(groupProperty, id);
      if (groupProperty !== undefined && group === undefined) {
        continue;
      }
      if (group !== undefined) {
        const existing = groups.get(group.definition.id);
        if (
          existing !== undefined &&
          (
            existing.definition.title !== group.definition.title ||
            existing.definition.order !== group.definition.order
          )
        ) {
          analysis.executorConfigurationViolations.push({
            type: "invalid_project_entrypoints",
            name: group.definition.id,
            message: `Workflow entrypoint group "${group.definition.id}" must use identical title and order in every entrypoint.`,
            locations: [existing.location, group.location],
          });
        } else if (existing === undefined) {
          groups.set(group.definition.id, group);
        }
      }
      if (projectRef === undefined) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: id,
          message: `Workflow entrypoint "${id}" must reference a statically named workflow definition.`,
          locations: [createLocation(cwd, filePath, sourceFile, entrypointObject)],
        });
        continue;
      }
      const paramDeclarations = readEntrypointParams(entrypointObject);
      entrypoints.push({
        id,
        title,
        description: readStringProperty(entrypointObject, "description"),
        group: group?.definition,
        projectRef,
        projectKey: createProjectDefinitionKey(filePath, projectRef),
        projectName: analysis.projectDefinitions[createProjectDefinitionKey(filePath, projectRef)],
        location: createLocation(cwd, filePath, sourceFile, entrypointObject),
        params: paramDeclarations?.params,
        paramLayout: paramDeclarations?.layout,
        paramResolver: hasObjectMember(entrypointObject, "resolveParams")
          ? { enabled: true }
          : undefined,
        tools: readEntrypointTools(entrypointObject),
        tokenUsage: readEntrypointTokenUsage(entrypointObject),
        registry: readEntrypointRegistry(entrypointObject),
      });
    }
    analysis.executorEntrypoints = entrypoints;
    if (
      analysis.executorDefaultEntrypoint !== undefined &&
      !ids.has(analysis.executorDefaultEntrypoint)
    ) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: "defaultEntrypoint",
        message: `Workflow executor defaultEntrypoint "${analysis.executorDefaultEntrypoint}" does not match a declared entrypoint.`,
        locations: [defaultProperty === undefined
          ? executorLocation
          : createLocation(cwd, filePath, sourceFile, defaultProperty)],
      });
    }
  }

  function collectExecutorTokenUsage(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      analysis.executorTokenUsage !== undefined
    ) {
      return;
    }

    if (!isProjectDefineExecutorCall(node)) {
      return;
    }

    const objectArg = node.arguments[0];

    if (objectArg === undefined || !ts.isObjectLiteralExpression(objectArg)) {
      return;
    }

    const tokenUsageProperty = objectArg.properties.find(
      (prop): prop is ts.PropertyAssignment =>
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "tokenUsage",
    );

    if (
      tokenUsageProperty === undefined ||
      !ts.isObjectLiteralExpression(tokenUsageProperty.initializer)
    ) {
      return;
    }

    const enabled = readBooleanProperty(tokenUsageProperty.initializer, "enabled");
    if (enabled !== undefined) {
      analysis.executorTokenUsage = {
        enabled,
        display: readBooleanProperty(tokenUsageProperty.initializer, "display"),
      };
    }
  }

  function collectExecutorRegistry(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      analysis.executorRegistry !== undefined
    ) {
      return;
    }

    if (!isProjectDefineExecutorCall(node)) {
      return;
    }

    const objectArg = node.arguments[0];

    if (objectArg === undefined || !ts.isObjectLiteralExpression(objectArg)) {
      return;
    }

    const registryProperty = objectArg.properties.find(
      (prop): prop is ts.PropertyAssignment =>
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "registry",
    );

    if (
      registryProperty === undefined ||
      !ts.isArrayLiteralExpression(registryProperty.initializer)
    ) {
      return;
    }

    const registry: NodeRegistryItem[] = [];

    for (const element of registryProperty.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        continue;
      }

      const item = readRegistryObject(element);

      if (item !== undefined) {
        registry.push(item);
      }
    }

    if (registry.length > 0) {
      analysis.executorRegistry = registry;
    }
  }

  function readEntrypointGroup(
    property: ts.ObjectLiteralElementLike | undefined,
    entrypointId: string,
  ): {
    definition: EntrypointGroupDefinition;
    location: ScriptRuleLocation;
  } | undefined {
    if (property === undefined) return undefined;
    if (!ts.isPropertyAssignment(property)) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group must be an inline object literal.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }
    const initializer = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group must be an inline object literal.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }

    const allowedProperties = new Set(["id", "title", "order"]);
    const seenProperties = new Set<string>();
    const invalidProperty = initializer.properties.find((member) => {
      if (!ts.isPropertyAssignment(member)) return true;
      const name = readStructurePropertyName(member.name);
      if (name === undefined || !allowedProperties.has(name) || seenProperties.has(name)) return true;
      seenProperties.add(name);
      return false;
    });
    if (invalidProperty !== undefined) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group must contain only one static id, title, and optional order property.`,
        locations: [createLocation(cwd, filePath, sourceFile, invalidProperty)],
      });
      return undefined;
    }

    const id = readStringProperty(initializer, "id");
    if (id === undefined || id.trim() === "") {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group id must be a non-empty static string literal.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }
    const title = readStringProperty(initializer, "title");
    if (title === undefined || title.trim() === "") {
      analysis.executorConfigurationViolations.push({
        type: "invalid_project_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group title must be a non-empty static string literal.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }

    const orderProperty = findStaticPropertyAssignment(initializer, "order");
    let order: number | undefined;
    if (orderProperty !== undefined) {
      const orderInitializer = unwrapExpression(orderProperty.initializer);
      order = ts.isNumericLiteral(orderInitializer)
        ? Number(orderInitializer.text)
        : Number.NaN;
      if (!Number.isInteger(order) || order < 0) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_project_entrypoints",
          name: entrypointId,
          message: `Workflow entrypoint "${entrypointId}" group order must be a non-negative static integer when provided.`,
          locations: [createLocation(cwd, filePath, sourceFile, orderProperty)],
        });
        return undefined;
      }
    }

    return {
      definition: {
        id,
        title,
        ...(order === undefined ? {} : { order }),
      },
      location: createLocation(cwd, filePath, sourceFile, property),
    };
  }

  function readEntrypointParams(
    obj: ts.ObjectLiteralExpression,
  ): { params: ParamDefinition[]; layout?: ParamLayout } | undefined {
    const property = findStaticPropertyAssignment(obj, "params");
    if (property === undefined) return undefined;
    return readExecutorParamDeclarations(property, "Workflow entrypoint");
  }

  function readExecutorParamDeclarations(
    property: ts.PropertyAssignment,
    owner: string,
  ): { params: ParamDefinition[]; layout?: ParamLayout } | undefined {
    const initialViolationCount = analysis.executorConfigurationViolations.length;
    if (!ts.isArrayLiteralExpression(property.initializer)) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_executor_param_configuration",
        name: "params",
        message: `${owner} params must be a static array.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }
    const declarations: ParamDeclaration[] = [];
    for (const element of property.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_executor_param_configuration",
          name: "params",
          message: `${owner} params must contain inline object literals.`,
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
        continue;
      }
      const kind = readStringProperty(element, "kind");
      if (kind === "auxiliary" || kind === "quick") {
        const fieldsProperty = findStaticPropertyAssignment(element, "fields");
        if (fieldsProperty === undefined || !ts.isArrayLiteralExpression(fieldsProperty.initializer) ||
          fieldsProperty.initializer.elements.some((field) => !ts.isObjectLiteralExpression(field))) {
          analysis.executorConfigurationViolations.push({
            type: "invalid_executor_param_configuration",
            name: kind,
            message: `${owner} ${kind} fields must be an inline array of object literals.`,
            locations: [createLocation(cwd, filePath, sourceFile, element)],
          });
          continue;
        }
        const fields = fieldsProperty.initializer.elements
          .map((field) => readParamObject(field as ts.ObjectLiteralExpression))
          .filter((field): field is ParamDefinition => field !== undefined);
        if (fields.length !== fieldsProperty.initializer.elements.length) {
          analysis.executorConfigurationViolations.push({
            type: "invalid_executor_param_configuration",
            name: kind,
            message: `${owner} ${kind} fields must declare static name and flag values.`,
            locations: [createLocation(cwd, filePath, sourceFile, element)],
          });
          continue;
        }
        declarations.push((kind === "quick"
          ? {
              kind,
              id: readStringProperty(element, "id") ?? "",
              label: readStringProperty(element, "label") ?? "",
              ...(findStaticPropertyAssignment(element, "icon") === undefined ? {} : { icon: readStringProperty(element, "icon") ?? "" }),
              summary: readStringArrayProperty(element, "summary") ?? [],
              fields,
            }
          : {
              kind,
              id: readStringProperty(element, "id") ?? "",
              label: readStringProperty(element, "label") ?? "",
              fields,
            }) as ParamDeclaration);
        continue;
      }
      const param = readParamObject(element);
      if (param === undefined) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_executor_param_configuration",
          name: "params",
          message: `${owner} params must declare static name and flag values.`,
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
        continue;
      }
      const error = readProjectParamDefinitionError(param, {
        options: findStaticPropertyAssignment(element, "options") !== undefined,
      });
      if (error !== undefined) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_executor_param_configuration",
          name: param.name,
          message: error,
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
      }
      if (kind === "mode") {
        declarations.push({ ...param, kind: "mode", options: param.options ?? [] } as ParamDeclaration);
      } else if (kind === "slash") {
        const { control: _control, panel: _panel, multiple: _multiple, ...field } = param;
        const properties = ["control", "panel", "multiple"].filter(name => findStaticPropertyAssignment(element, name) !== undefined);
        if (properties.length) {
          analysis.executorConfigurationViolations.push({ type: "invalid_executor_param_configuration", name: param.name,
            message: `Slash parameter "${param.name}" cannot declare ${properties.join(", ")}.`,
            locations: [createLocation(cwd, filePath, sourceFile, element)] });
        }
        declarations.push({ ...field, kind: "slash" } as ParamDeclaration);
      } else if (kind === undefined) {
        declarations.push(param as ParamDeclaration);
      } else {
        analysis.executorConfigurationViolations.push({
          type: "invalid_executor_param_configuration",
          name: kind,
          message: `Unknown parameter entry kind "${kind}".`,
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
      }
    }
    if (analysis.executorConfigurationViolations.length > initialViolationCount) return undefined;
    try {
      assertProjectParamDeclarations(declarations, owner === "Conversation executor" ? "conversation" : "workflow");
      return normalizeProjectParamDeclarations(declarations);
    } catch (error) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_executor_param_configuration",
        name: "params",
        message: error instanceof Error ? error.message : String(error),
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }
  }

  function readEntrypointTools(
    obj: ts.ObjectLiteralExpression,
  ): ToolPermissionDefinition[] | undefined {
    const property = findStaticPropertyAssignment(obj, "tools");
    if (property === undefined) return undefined;
    if (!ts.isArrayLiteralExpression(property.initializer)) return undefined;
    return property.initializer.elements.flatMap((element) => {
      if (!ts.isObjectLiteralExpression(element)) return [];
      const tool = readToolPermissionObject(element);
      return tool === undefined ? [] : [tool];
    });
  }

  function readEntrypointTokenUsage(
    obj: ts.ObjectLiteralExpression,
  ): TokenUsageDefinition | undefined {
    const property = findStaticPropertyAssignment(obj, "tokenUsage");
    if (property === undefined || !ts.isObjectLiteralExpression(property.initializer)) {
      return undefined;
    }
    const enabled = readBooleanProperty(property.initializer, "enabled");
    return enabled === undefined
      ? undefined
      : {
          enabled,
          display: readBooleanProperty(property.initializer, "display"),
        };
  }

  function readEntrypointRegistry(
    obj: ts.ObjectLiteralExpression,
  ): NodeRegistryItem[] | undefined {
    const property = findStaticPropertyAssignment(obj, "registry");
    if (property === undefined || !ts.isArrayLiteralExpression(property.initializer)) {
      return undefined;
    }
    return property.initializer.elements.flatMap((element) => {
      if (!ts.isObjectLiteralExpression(element)) return [];
      const item = readRegistryObject(element);
      return item === undefined ? [] : [item];
    });
  }

  function hasObjectMember(obj: ts.ObjectLiteralExpression, name: string): boolean {
    return obj.properties.some((property) => (
      hasPropertyName(property) && readStructurePropertyName(property.name) === name
    ));
  }

  function readParamObject(
    obj: ts.ObjectLiteralExpression,
  ): ParamDefinition | undefined {
    const name = readStringProperty(obj, "name");
    const flag = readStringProperty(obj, "flag");

    if (name === undefined || flag === undefined) {
      return undefined;
    }

    const type = (readStringProperty(obj, "type") as ParamDefinition["type"]) ?? "string";

    return {
      name,
      flag,
      shortFlag: readStringProperty(obj, "shortFlag"),
      type,
      required: readBooleanProperty(obj, "required"),
      label: readStringProperty(obj, "label"),
      description: readStringProperty(obj, "description"),
      command: readStringProperty(obj, "command"),
      defaultValue: readStringProperty(obj, "defaultValue"),
      multiple: readBooleanProperty(obj, "multiple"),
      // keeps option metadata visible to local host parameter forms.
      control: readParamControlProperty(obj, "control"),
      panel: readParamPanelProperty(obj, "panel"),
      resolveOnInput: readBooleanProperty(obj, "resolveOnInput"),
      step: readNumberProperty(obj, "step"),
      options: readParamOptionsProperty(obj, "options"),
      accept: readStringArrayProperty(obj, "accept"),
      audio: readParamAudioProperty(obj),
      format: readStringProperty(obj, "format") === "json" ? "json" : undefined,
    } as ParamDefinition;
  }

  function readToolPermissionObject(
    obj: ts.ObjectLiteralExpression,
  ): ToolPermissionDefinition | undefined {
    const name = readStringProperty(obj, "name");

    if (name === undefined) {
      return undefined;
    }

    return {
      name,
      label: readStringProperty(obj, "label"),
      description: readStringProperty(obj, "description"),
      enabled: readBooleanProperty(obj, "enabled"),
      autoApprove: readBooleanProperty(obj, "autoApprove"),
    };
  }

  function readRegistryObject(
    obj: ts.ObjectLiteralExpression,
  ): NodeRegistryItem | undefined {
    const name = readStringProperty(obj, "name");
    const nodeName = readIdentifierProperty(obj, "node");

    if (name === undefined || nodeName === undefined) {
      return undefined;
    }

    const standardName = nodeNamesById.get(nodeName);
    const metadata = readMetadataProperty(obj, "metadata") ?? readNodeMetadataById(nodeName);

    return {
      name,
      standardName,
      metadata: {
        type: metadata?.type ?? standardName ?? name,
        title: metadata?.title ?? readConfiguredNodeName(nodeName) ?? name,
        version: metadata?.version ?? "1.0.0",
      },
    };
  }

  function readMetadataProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): Partial<NodeRegistryItem["metadata"]> | undefined {
    const prop = obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === propertyName,
    );

    if (prop === undefined || !ts.isObjectLiteralExpression(prop.initializer)) {
      return undefined;
    }

    return {
      type: readStringProperty(prop.initializer, "type"),
      title: readStringProperty(prop.initializer, "title"),
      version: readStringProperty(prop.initializer, "version"),
    };
  }

  function readIdentifierProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): string | undefined {
    const prop = obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === propertyName,
    );

    if (prop === undefined || !ts.isIdentifier(prop.initializer)) {
      return undefined;
    }

    return prop.initializer.text;
  }

  function readNodeMetadataById(
    nodeId: string,
  ): Partial<NodeRegistryItem["metadata"]> | undefined {
    const node = analysis.structureNodes.find((item) => item.id === nodeId);

    if (node === undefined || node.options.kind !== "object") {
      return undefined;
    }

    const metadata = resolveStructureValue(node.options.value.metadata);

    if (metadata?.kind !== "object") {
      return undefined;
    }

    return {
      type: readLiteralStringValue(metadata.value.type),
      title: readLiteralStringValue(metadata.value.title),
      version: readLiteralStringValue(metadata.value.version),
    };
  }

  function readConfiguredNodeName(nodeId: string): string | undefined {
    return analysis.structureNodes.find((item) => item.id === nodeId)?.configuredName;
  }

  function readLiteralStringValue(
    value: StructureValue | undefined,
  ): string | undefined {
    const resolved = resolveStructureValue(value);

    return resolved?.kind === "literal" && typeof resolved.value === "string"
      ? resolved.value
      : undefined;
  }

  function readStringProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): string | undefined {
    const prop = findStaticPropertyAssignment(obj, propertyName);

    if (prop === undefined) {
      return undefined;
    }

    const initializer = unwrapExpression(prop.initializer);
    if (ts.isStringLiteralLike(initializer)) {
      return initializer.text;
    }

    return undefined;
  }

  function readBooleanProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): boolean | undefined {
    const prop = obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === propertyName,
    );

    if (prop === undefined) {
      return undefined;
    }

    if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }

    if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }

    return undefined;
  }

  function readNumberProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): number | undefined {
    const prop = obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === propertyName,
    );

    return prop !== undefined && ts.isNumericLiteral(prop.initializer)
      ? Number(prop.initializer.text)
      : undefined;
  }

  function readStringArrayProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): string[] | undefined {
    const prop = obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === propertyName,
    );

    if (prop === undefined || !ts.isArrayLiteralExpression(prop.initializer)) {
      return undefined;
    }

    const values = prop.initializer.elements
      .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
      .map((element) => element.text);

    return values.length === 0 ? undefined : values;
  }

  function readParamControlProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): ParamDefinition["control"] | undefined {
    const value = readStringProperty(obj, propertyName);
    return value === "text" ||
      value === "audio" ||
      value === "textarea" ||
      value === "radio" ||
      value === "select" ||
      value === "checkboxes" ||
      value === "date" ||
      value === "time" ||
      value === "datetime" ||
      value === "date-range"
      ? value
      : undefined;
  }

  function readParamAudioProperty(obj: ts.ObjectLiteralExpression): ParamDefinition["audio"] {
    const property = findStaticPropertyAssignment(obj, "audio");
    if (!property) return undefined;
    const initializer = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) return undefined;
    const limits: NonNullable<ParamDefinition["audio"]> = {};
    for (const name of ["maxDurationSeconds", "maxBytes"] as const) {
      const field = findStaticPropertyAssignment(initializer, name);
      if (!field) continue;
      const value = unwrapExpression(field.initializer);
      if (ts.isNumericLiteral(value)) limits[name] = Number(value.text);
      else if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
        limits[name] = value.operator === ts.SyntaxKind.MinusToken ? -Number(value.operand.text) : Number(value.operand.text);
      }
    }
    return limits;
  }

  function readParamPanelProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): ParamDefinition["panel"] | undefined {
    const value = readStringProperty(obj, propertyName);
    return value === "main" || value === "auxiliary" || value === "quick" || value === "mode" || value === "slash" ? value : undefined;
  }

  function readParamOptionsProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): ParamDefinition["options"] | undefined {
    const prop = findStaticPropertyAssignment(obj, propertyName);

    if (prop === undefined || !ts.isArrayLiteralExpression(prop.initializer)) {
      return undefined;
    }

    const options = prop.initializer.elements
      .map((element) => {
        if (ts.isStringLiteral(element)) {
          return { value: element.text };
        }

        if (!ts.isObjectLiteralExpression(element)) {
          return undefined;
        }

        const value = readStringProperty(element, "value");
        if (value === undefined) {
          return undefined;
        }

        return {
          value,
          label: readStringProperty(element, "label"),
          description: readStringProperty(element, "description"),
          ...(readStringProperty(element, "command") === undefined ? {} : { command: readStringProperty(element, "command") }),
        };
      })
      .filter((option): option is NonNullable<typeof option> => option !== undefined);

    return options.length === 0 ? undefined : options;
  }

  function readConversationUserInputProperty(obj: ts.ObjectLiteralExpression): ConversationDefinition["userInput"] {
    const property = findStaticPropertyAssignment(obj, "userInput");
    if (!property) return undefined;
    try {
      const literal = (value: StructureValue): unknown => {
        if (value.kind === "literal") return value.value;
        if (value.kind === "array") return value.value.map(literal);
        if (value.kind === "object") return Object.fromEntries(Object.entries(value.value).map(([name, child]) => [name, literal(child)]));
        throw new Error("Conversation userInput must contain static literals.");
      };
      const userInput = literal(evaluateExpression(property.initializer));
      assertConversationUserInput(userInput, analysis.executorParams ?? []);
      return userInput;
    } catch (error) {
      analysis.executorConfigurationViolations.push({ type: "invalid_executor_param_configuration", name: "userInput",
        message: error instanceof Error ? error.message : String(error),
        locations: [createLocation(cwd, filePath, sourceFile, property)] });
      return undefined;
    }
  }

  function readConversationFooterProperty(obj: ts.ObjectLiteralExpression): ConversationDefinition["footer"] {
    const property = findStaticPropertyAssignment(obj, "footer");
    if (!property) return undefined;
    try {
      const literal = (value: StructureValue): unknown => {
        if (value.kind === "literal") return value.value;
        if (value.kind === "array") return value.value.map(literal);
        if (value.kind === "object") return Object.fromEntries(Object.entries(value.value).map(([name, child]) => [name, literal(child)]));
        throw new Error("Conversation footer must contain static literals.");
      };
      const footer = literal(evaluateExpression(property.initializer));
      assertConversationFooter(footer, analysis.executorParams ?? []);
      return footer;
    } catch (error) {
      analysis.executorConfigurationViolations.push({ type: "invalid_executor_param_configuration", name: "footer",
        message: error instanceof Error ? error.message : String(error),
        locations: [createLocation(cwd, filePath, sourceFile, property)] });
      return undefined;
    }
  }

  function readConversationCommandsProperty(obj: ts.ObjectLiteralExpression): ConversationDefinition["commands"] {
    const property = findStaticPropertyAssignment(obj, "commands");
    if (!property) return undefined;
    try {
      const literal = (value: StructureValue): unknown => {
        if (value.kind === "literal") return value.value;
        if (value.kind === "array") return value.value.map(literal);
        if (value.kind === "object") return Object.fromEntries(Object.entries(value.value).map(([name, child]) => [name, literal(child)]));
        throw new Error("Conversation commands must contain static literals.");
      };
      const commands = literal(evaluateExpression(property.initializer));
      assertConversationCommands(commands, analysis.executorParams ?? []);
      return commands;
    } catch (error) {
      analysis.executorConfigurationViolations.push({ type: "invalid_executor_param_configuration", name: "commands",
        message: error instanceof Error ? error.message : String(error),
        locations: [createLocation(cwd, filePath, sourceFile, property)] });
      return undefined;
    }
  }

  function readConversationAttachmentsProperty(
    obj: ts.ObjectLiteralExpression,
  ): ConversationDefinition["attachments"] | undefined {
    const prop = findStaticPropertyAssignment(obj, "attachments");

    if (prop === undefined || !ts.isObjectLiteralExpression(prop.initializer)) {
      return undefined;
    }

    const images = readBooleanProperty(prop.initializer, "images");
    const videos = readBooleanProperty(prop.initializer, "videos");
    const files = readBooleanProperty(prop.initializer, "files");
    if (images === undefined && videos === undefined && files === undefined) return undefined;
    return {
      ...(images === undefined ? {} : { images }),
      ...(videos === undefined ? {} : { videos }),
      ...(files === undefined ? {} : { files }),
    };
  }

  function readConversationInputQueueProperty(
    obj: ts.ObjectLiteralExpression,
  ): ConversationDefinition["inputQueue"] | undefined {
    const prop = findStaticPropertyAssignment(obj, "inputQueue");

    if (prop === undefined || !ts.isObjectLiteralExpression(prop.initializer)) {
      return undefined;
    }

    const enabled = readBooleanProperty(prop.initializer, "enabled");
    if (enabled === undefined) {
      return undefined;
    }

    return { enabled };
  }

  function readConversationOpenAIProperty(
    obj: ts.ObjectLiteralExpression,
  ): ConversationDefinition["openai"] | undefined {
    const prop = findStaticPropertyAssignment(obj, "openai");
    if (prop === undefined || !ts.isObjectLiteralExpression(prop.initializer)) {
      return undefined;
    }
    const enabled = readBooleanProperty(prop.initializer, "enabled");
    const outputItemId = readStringProperty(prop.initializer, "outputItemId")?.trim();
    if (enabled !== true || outputItemId === undefined || outputItemId === "") {
      return undefined;
    }
    return { enabled: true, outputItemId };
  }

  function collectProjectRunInputNames(node: ts.Node): void {
    if (!ts.isMethodDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "run") {
      return;
    }

    const firstParameter = node.parameters[0];

    if (firstParameter !== undefined && ts.isIdentifier(firstParameter.name)) {
      projectInputNames.add(firstParameter.name.text);
    }
  }

  function collectRunNodeCall(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isRunNodeCall(node)) {
      return;
    }

    ensureRunNodeTreeCall(node);
  }

  function collectRunProjectCall(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isRunProjectCall(node)) {
      return;
    }

    ensureRunProjectTreeCall(node);
  }

  function ensureRunNodeTreeCall(node: ts.CallExpression): StructureCall {
    const existing = structureCallsByNode.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const nodeRef = describeNodeRef(node.arguments[0]);
    const input = describeInputRef(node.arguments[1]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const call: StructureCall = {
      order,
      callee: readRunNodeCallee(node),
      nodeRef: nodeRef.id,
      standardName: nodeRef.standardName,
      location: createLocation(cwd, filePath, sourceFile, node),
      arguments: node.arguments.map((argument, index) => ({
        position: index,
        source: argument.getText(sourceFile),
        value:
          index === 0
            ? {
                kind: "node",
                nodeId: nodeRef.id,
                standardName: nodeRef.standardName,
                callOrder: order,
              }
            : index === 1
              ? input
              : describeInputRef(argument),
      })),
      input,
      output,
    };

    analysis.structureCalls.push(call);
    structureCallsByNode.set(node, call);
    analysis.structureEdges.push({
      order: analysis.structureEdges.length + 1,
      from: input,
      to: {
        kind: "node",
        nodeId: call.nodeRef,
        standardName: call.standardName,
        callOrder: call.order,
      },
    });

    if (output.kind !== "expression") {
      analysis.structureEdges.push({
        order: analysis.structureEdges.length + 1,
        from: {
          kind: "node",
          nodeId: call.nodeRef,
          standardName: call.standardName,
          callOrder: call.order,
        },
        to: output,
      });
    }

    if (output.kind === "variable") {
      outputVariables.set(output.name, {
        kind: "node-output",
        callOrder: order,
        nodeId: nodeRef.id,
        variable: output.name,
      });
    }

    return call;
  }

  function ensureRunProjectTreeCall(node: ts.CallExpression): StructureCall {
    const existing = structureProjectCallsByNode.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const projectRef = describeProjectRef(node.arguments[0]);
    const input = describeInputRef(node.arguments[1]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const call: StructureCall = {
      order,
      callee: "runProject",
      nodeRef: projectRef.id,
      standardName: "run-workflow",
      location: createLocation(cwd, filePath, sourceFile, node),
      arguments: node.arguments.map((argument, index) => ({
        position: index,
        source: argument.getText(sourceFile),
        value:
          index === 0
            ? {
                kind: "node",
                nodeId: projectRef.id,
                standardName: "run-workflow",
                callOrder: order,
              }
            : index === 1
              ? input
              : describeInputRef(argument),
      })),
      input,
      output,
    };

    analysis.structureCalls.push(call);
    structureProjectCallsByNode.set(node, call);
    analysis.structureEdges.push({
      order: analysis.structureEdges.length + 1,
      from: input,
      to: {
        kind: "node",
        nodeId: projectRef.id,
        standardName: "run-workflow",
        callOrder: order,
      },
    });

    if (output.kind !== "expression") {
      analysis.structureEdges.push({
        order: analysis.structureEdges.length + 1,
        from: {
          kind: "node",
          nodeId: projectRef.id,
          standardName: "run-workflow",
          callOrder: order,
        },
        to: output,
      });
    }

    if (output.kind === "variable") {
      outputVariables.set(output.name, {
        kind: "node-output",
        callOrder: order,
        nodeId: projectRef.id,
        variable: output.name,
      });
    }

    return call;
  }

  function collectRunIfCall(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isRunIfCall(node)) {
      return;
    }

    ensureRunIfTreeItem(node);
  }

  function collectRunLoopCall(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isRunLoopCall(node)) {
      return;
    }

    ensureLoopTreeItem(node);
  }

  function ensureRunIfTreeItem(node: ts.CallExpression): StructureRunIfTreeItem {
    const existing = structureRunIfByNode.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const input = describeInputRef(node.arguments[0]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const runIfItem: StructureRunIfTreeItem = {
      kind: "run-if",
      order: 0,
      callOrder: order,
      callId: `call_${order}`,
      label: readRunIfName(node.arguments[2]),
      location: createLocation(cwd, filePath, sourceFile, node),
      arguments: node.arguments.map((argument, index) => ({
        position: index,
        source: argument.getText(sourceFile),
        value: index === 0 ? input : evaluateExpression(argument),
      })),
      input,
      output,
      branches: [],
    };

    analysis.structureCalls.push({
      order,
      callee: "runIf",
      nodeRef: "run-if",
      standardName: "run-if",
      location: runIfItem.location,
      arguments: runIfItem.arguments,
      input,
      output,
    });
    structureRunIfByNode.set(node, runIfItem);
    analysis.structureEdges.push({
      order: analysis.structureEdges.length + 1,
      from: input,
      to: {
        kind: "node",
        nodeId: "run-if",
        standardName: "run-if",
        callOrder: order,
      },
    });

    if (output.kind !== "expression") {
      analysis.structureEdges.push({
        order: analysis.structureEdges.length + 1,
        from: {
          kind: "node",
          nodeId: "run-if",
          standardName: "run-if",
          callOrder: order,
        },
        to: output,
      });
    }

    if (output.kind === "variable") {
      outputVariables.set(output.name, {
        kind: "node-output",
        callOrder: order,
        nodeId: "run-if",
        variable: output.name,
      });
    }

    runIfItem.branches = describeRunIfBranches(node.arguments[2]);
    return runIfItem;
  }

  function ensureLoopTreeItem(node: ts.CallExpression): StructureLoopTreeItem {
    const existing = structureLoopByNode.get(node);
    if (existing !== undefined) {
      existing.children = describeLoopRunChildren(node.arguments[2]);
      return existing;
    }

    const source = readProjectApiCallName(node.expression) === "runFor" ? "run-for" : "run-while";
    const input = describeInputRef(node.arguments[0]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const optionsExpression = node.arguments[2];
    const loopItem: StructureLoopTreeItem = {
      kind: "loop",
      source,
      order: 0,
      callOrder: order,
      callId: `call_${order}`,
      label: readLoopName(optionsExpression),
      condition: source === "run-while" ? readLoopOptionSource(optionsExpression, "condition") : undefined,
      items: source === "run-for" ? readLoopOptionSource(optionsExpression, "items") : undefined,
      maxIterations: readLoopMaxIterations(optionsExpression),
      location: createLocation(cwd, filePath, sourceFile, node),
      arguments: node.arguments.map((argument, index) => ({
        position: index,
        source: argument.getText(sourceFile),
        value: index === 0 ? input : evaluateExpression(argument),
      })),
      input,
      output,
      children: [],
    };
    const callee = source === "run-for" ? "runFor" : "runWhile";

    analysis.structureCalls.push({
      order,
      callee,
      nodeRef: source,
      standardName: source,
      location: loopItem.location,
      arguments: loopItem.arguments,
      input,
      output,
    });
    structureLoopByNode.set(node, loopItem);
    analysis.structureEdges.push({
      order: analysis.structureEdges.length + 1,
      from: input,
      to: {
        kind: "node",
        nodeId: source,
        standardName: source,
        callOrder: order,
      },
    });

    if (output.kind !== "expression") {
      analysis.structureEdges.push({
        order: analysis.structureEdges.length + 1,
        from: {
          kind: "node",
          nodeId: source,
          standardName: source,
          callOrder: order,
        },
        to: output,
      });
    }

    if (output.kind === "variable") {
      outputVariables.set(output.name, {
        kind: "node-output",
        callOrder: order,
        nodeId: source,
        variable: output.name,
      });
    }

    loopItem.children = describeLoopRunChildren(optionsExpression);
    return loopItem;
  }

  function collectProjectApiCall(node: ts.Node): void {
    if (!ts.isCallExpression(node)) {
      return;
    }

    const method = readKnownProjectApiCallName(node.expression);
    if (method === undefined) {
      return;
    }

    const call: StructureApiCall = {
      order: analysis.structureApiCalls.length + 1,
      method,
      location: createLocation(cwd, filePath, sourceFile, node),
      arguments: node.arguments.map((argument, index) => ({
        position: index,
        source: argument.getText(sourceFile),
        value: evaluateExpression(argument),
      })),
      output: describeApiCallOutputRef(node),
    };

    // Keep static workflow API usage in definitions so diagram
    // summaries cannot imply node hook execution order.
    analysis.structureApiCalls.push(call);
  }

  function collectProjectRunTrees(node: ts.Node): void {
    if (isProjectRunMethod(node) && node.body !== undefined) {
      // Only workflow definitions own the top-level execution tree; runIf branch handlers
      // are parsed from their branch object so they do not drift into the diagram root.
      const projectRef = readProjectDefinitionBindingName(findProjectDefinitionCall(node));
      analysis.structureTrees.push({
        kind: "workflow-run",
        projectRef,
        projectKey: projectRef === undefined
          ? undefined
          : createProjectDefinitionKey(filePath, projectRef),
        location: createLocation(cwd, filePath, sourceFile, node),
        children: describeStatements(node.body.statements),
      });
    }

    ts.forEachChild(node, collectProjectRunTrees);
  }

  function describeStatements(
    statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  ): StructureTreeItem[] {
    return statements.flatMap((statement) => describeStatement(statement));
  }

  function describeStatement(statement: ts.Statement): StructureTreeItem[] {
    if (ts.isIfStatement(statement)) {
      return [describeIfStatement(statement)];
    }

    if (ts.isBlock(statement)) {
      return describeStatements(statement.statements);
    }

    if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
      return collectCallTreeItems(statement.expression);
    }

    return collectCallTreeItems(statement);
  }

  function describeIfStatement(statement: ts.IfStatement): StructureIfTreeItem {
    return {
      kind: "if",
      order: nextTreeItemOrder(),
      condition: statement.expression.getText(sourceFile),
      location: createLocation(cwd, filePath, sourceFile, statement),
      branches: describeIfBranches(statement),
    };
  }

  function describeIfBranches(statement: ts.IfStatement): StructureIfBranch[] {
    const branches: StructureIfBranch[] = [];
    let current: ts.IfStatement | undefined = statement;
    let branchKind: StructureIfBranch["kind"] = "if";

    while (current !== undefined) {
      branches.push({
        kind: branchKind,
        condition: current.expression.getText(sourceFile),
        location: createLocation(cwd, filePath, sourceFile, current),
        children: describeBranchChildren(current.thenStatement),
      });

      const elseStatement: ts.Statement | undefined = current.elseStatement;

      if (elseStatement === undefined) {
        break;
      }

      if (ts.isIfStatement(elseStatement)) {
        current = elseStatement;
        branchKind = "else-if";
        continue;
      }

      branches.push({
        kind: "else",
        location: createLocation(cwd, filePath, sourceFile, elseStatement),
        children: describeBranchChildren(elseStatement),
      });
      break;
    }

    return branches;
  }

  function describeRunIfBranches(
    optionsExpression: ts.Expression | undefined,
  ): StructureRunIfBranch[] {
    if (optionsExpression === undefined) {
      return [];
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return [];
    }

    const branchesProperty = readObjectPropertyInitializer(options, "branches");
    const branches: StructureRunIfBranch[] = [];

    if (branchesProperty !== undefined && ts.isArrayLiteralExpression(branchesProperty)) {
      branchesProperty.elements.forEach((element, index) => {
        const branchObject = unwrapExpression(element);
        if (!ts.isObjectLiteralExpression(branchObject)) {
          return;
        }

        branches.push({
          kind: index === 0 ? "if" : "else-if",
          label: readStringLiteralObjectProperty(branchObject, "label"),
          description: readStringLiteralObjectProperty(branchObject, "description"),
          condition: readRunIfConditionSource(branchObject),
          location: createLocation(cwd, filePath, sourceFile, branchObject),
          children: describeRunIfRunChildren(branchObject),
        });
      });
    }

    const elseProperty = readObjectPropertyInitializer(options, "else");
    if (elseProperty !== undefined) {
      const elseObject = unwrapExpression(elseProperty);
      if (ts.isObjectLiteralExpression(elseObject)) {
        branches.push({
          kind: "else",
          label: readStringLiteralObjectProperty(elseObject, "label") ?? "else",
          description: readStringLiteralObjectProperty(elseObject, "description"),
          location: createLocation(cwd, filePath, sourceFile, elseObject),
          children: describeRunIfRunChildren(elseObject),
        });
      }
    }

    return branches;
  }

  function readRunIfName(optionsExpression: ts.Expression | undefined): string | undefined {
    if (optionsExpression === undefined) {
      return undefined;
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return undefined;
    }

    return readStringLiteralObjectProperty(options, "name");
  }

  function readLoopName(optionsExpression: ts.Expression | undefined): string | undefined {
    if (optionsExpression === undefined) {
      return undefined;
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return undefined;
    }

    return readStringLiteralObjectProperty(options, "name");
  }

  function readLoopOptionSource(
    optionsExpression: ts.Expression | undefined,
    name: "condition" | "items",
  ): string | undefined {
    if (optionsExpression === undefined) {
      return undefined;
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return undefined;
    }

    const value = readObjectPropertyInitializer(options, name);
    return value?.getText(sourceFile);
  }

  function readLoopMaxIterations(optionsExpression: ts.Expression | undefined): number | undefined {
    if (optionsExpression === undefined) {
      return undefined;
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return undefined;
    }

    const value = readObjectPropertyInitializer(options, "maxIterations");
    if (value === undefined || !ts.isNumericLiteral(value)) {
      return undefined;
    }

    return Number(value.text);
  }

  function readRunIfConditionSource(branchObject: ts.ObjectLiteralExpression): string | undefined {
    const condition = readObjectPropertyInitializer(branchObject, "condition");
    if (condition === undefined) {
      return undefined;
    }

    return condition.getText(sourceFile);
  }

  function describeRunIfRunChildren(
    branchObject: ts.ObjectLiteralExpression,
  ): StructureTreeItem[] {
    const runProperty = branchObject.properties.find((property) => {
      return hasPropertyName(property) && readStructurePropertyName(property.name) === "run";
    });

    if (runProperty === undefined) {
      return [];
    }

    if (ts.isMethodDeclaration(runProperty)) {
      return describeFunctionBodyChildren(runProperty.body);
    }

    if (ts.isPropertyAssignment(runProperty)) {
      const initializer = unwrapExpression(runProperty.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return describeFunctionBodyChildren(initializer.body);
      }
    }

    return [];
  }

  function describeLoopRunChildren(
    optionsExpression: ts.Expression | undefined,
  ): StructureTreeItem[] {
    if (optionsExpression === undefined) {
      return [];
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return [];
    }

    const runProperty = options.properties.find((property) => {
      return hasPropertyName(property) && readStructurePropertyName(property.name) === "run";
    });

    if (runProperty === undefined) {
      return [];
    }

    if (ts.isMethodDeclaration(runProperty)) {
      return describeFunctionBodyChildren(runProperty.body);
    }

    if (ts.isPropertyAssignment(runProperty)) {
      const initializer = unwrapExpression(runProperty.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return describeFunctionBodyChildren(initializer.body);
      }
    }

    return [];
  }

  function describeFunctionBodyChildren(
    body: ts.ConciseBody | undefined,
  ): StructureTreeItem[] {
    if (body === undefined) {
      return [];
    }

    if (ts.isBlock(body)) {
      return describeStatements(body.statements);
    }

    return collectCallTreeItems(body);
  }

  function readObjectPropertyInitializer(
    obj: ts.ObjectLiteralExpression,
    name: string,
  ): ts.Expression | undefined {
    const property = obj.properties.find((item): item is ts.PropertyAssignment => {
      return ts.isPropertyAssignment(item) && readStructurePropertyName(item.name) === name;
    });

    return property?.initializer;
  }

  function readStringLiteralObjectProperty(
    obj: ts.ObjectLiteralExpression,
    name: string,
  ): string | undefined {
    const value = readObjectPropertyInitializer(obj, name);
    if (value === undefined || !ts.isStringLiteralLike(value)) {
      return undefined;
    }

    return value.text;
  }

  function describeBranchChildren(statement: ts.Statement): StructureTreeItem[] {
    if (ts.isBlock(statement)) {
      return describeStatements(statement.statements);
    }

    return describeStatement(statement);
  }

  function collectCallTreeItems(node: ts.Node): StructureTreeItem[] {
    const items: StructureTreeItem[] = [];

    visitCallTreeNode(node);

    return items;

    function visitCallTreeNode(current: ts.Node): void {
      if (current !== node && createsTreeTraversalBoundary(current)) {
        return;
      }

      if (ts.isIfStatement(current)) {
        items.push(describeIfStatement(current));
        return;
      }

      if (ts.isCallExpression(current) && isRunNodeCall(current)) {
        items.push(createCallTreeItem(ensureRunNodeTreeCall(current)));
        return;
      }

      if (ts.isCallExpression(current) && isRunProjectCall(current)) {
        items.push(createCallTreeItem(ensureRunProjectTreeCall(current)));
        return;
      }

      if (ts.isCallExpression(current) && isRunIfCall(current)) {
        items.push({
          ...ensureRunIfTreeItem(current),
          order: nextTreeItemOrder(),
        });
        return;
      }

      if (ts.isCallExpression(current) && isRunLoopCall(current)) {
        items.push({
          ...ensureLoopTreeItem(current),
          order: nextTreeItemOrder(),
        });
        return;
      }

      ts.forEachChild(current, visitCallTreeNode);
    }
  }

  function createCallTreeItem(call: StructureCall): StructureCallTreeItem {
    return {
      kind: "call",
      order: nextTreeItemOrder(),
      callOrder: call.order,
      callee: call.callee,
      nodeRef: call.nodeRef,
      standardName: call.standardName,
      location: call.location,
      arguments: call.arguments,
      input: call.input,
      output: call.output,
    };
  }

  function nextTreeItemOrder(): number {
    treeItemOrder += 1;

    return treeItemOrder;
  }

  function readNodeOptions(node: ts.CallExpression): StructureValue {
    const firstArgument = node.arguments[0];

    if (firstArgument === undefined) {
      return {
        kind: "object",
        value: {},
      };
    }

    return evaluateExpression(firstArgument);
  }

  function evaluateExpression(expression: ts.Expression): StructureValue {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return evaluateExpression(expression.expression);
    }

    if (ts.isSatisfiesExpression(expression)) {
      return evaluateExpression(expression.expression);
    }

    if (ts.isStringLiteralLike(expression)) {
      return {
        kind: "literal",
        value: expression.text,
      };
    }

    if (ts.isNumericLiteral(expression)) {
      return {
        kind: "literal",
        value: Number(expression.text),
      };
    }

    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      return {
        kind: "literal",
        value: true,
      };
    }

    if (expression.kind === ts.SyntaxKind.FalseKeyword) {
      return {
        kind: "literal",
        value: false,
      };
    }

    if (expression.kind === ts.SyntaxKind.NullKeyword) {
      return {
        kind: "literal",
        value: null,
      };
    }

    if (ts.isArrayLiteralExpression(expression)) {
      return {
        kind: "array",
        value: expression.elements.map((element) => evaluateExpression(element)),
      };
    }

    if (ts.isObjectLiteralExpression(expression)) {
      return {
        kind: "object",
        value: evaluateObjectLiteral(expression),
      };
    }

    if (
      ts.isFunctionExpression(expression) ||
      ts.isArrowFunction(expression)
    ) {
      return {
        kind: "function",
        source: expression.getText(sourceFile),
      };
    }

    if (ts.isIdentifier(expression)) {
      const resolved = constValues.get(expression.text);

      return {
        kind: "variable",
        name: expression.text,
        resolved,
      };
    }

    const joined = evaluateJoinCall(expression);
    if (joined !== undefined) {
      return joined;
    }

    return {
      kind: "expression",
      source: expression.getText(sourceFile),
    };
  }

  function evaluateObjectLiteral(
    expression: ts.ObjectLiteralExpression,
  ): Record<string, StructureValue> {
    const value: Record<string, StructureValue> = {};

    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = readStructurePropertyName(property.name);

        if (name !== undefined) {
          value[name] = evaluateExpression(property.initializer);
        }
        continue;
      }

      if (ts.isMethodDeclaration(property)) {
        const name = readStructurePropertyName(property.name);

        if (name !== undefined) {
          value[name] = {
            kind: "function",
            source: property.getText(sourceFile),
          };
        }
        continue;
      }

      if (ts.isShorthandPropertyAssignment(property)) {
        value[property.name.text] = {
          kind: "variable",
          name: property.name.text,
          resolved: constValues.get(property.name.text),
        };
        continue;
      }

      if (ts.isSpreadAssignment(property)) {
        value[`...${Object.keys(value).length + 1}`] = {
          kind: "expression",
          source: property.getText(sourceFile),
        };
      }
    }

    return value;
  }

  function evaluateJoinCall(
    expression: ts.Expression,
  ): StructureValue | undefined {
    if (
      !ts.isCallExpression(expression) ||
      !ts.isPropertyAccessExpression(expression.expression) ||
      expression.expression.name.text !== "join"
    ) {
      return undefined;
    }

    const target = evaluateExpression(expression.expression.expression);
    const separatorExpression = expression.arguments[0];
    const separator =
      separatorExpression !== undefined && ts.isStringLiteralLike(separatorExpression)
        ? separatorExpression.text
        : ",";

    const targetValue =
      target.kind === "variable" && target.resolved !== undefined
        ? target.resolved
        : target;

    if (targetValue.kind !== "array") {
      return undefined;
    }

    const values: string[] = [];

    for (const item of targetValue.value) {
      if (item.kind !== "literal" || typeof item.value !== "string") {
        return undefined;
      }

      values.push(item.value);
    }

    return {
      kind: "literal",
      value: values.join(separator),
    };
  }

  function describeNodeRef(expression: ts.Expression | undefined): {
    id: string;
    standardName?: string;
  } {
    if (expression !== undefined && ts.isIdentifier(expression)) {
      const id = nodeIdsByVariable.get(expression.text) ?? expression.text;

      return {
        id,
        standardName: nodeNamesById.get(id),
      };
    }

    return {
      id: expression === undefined ? "unknown" : expression.getText(sourceFile),
    };
  }

  function describeProjectRef(expression: ts.Expression | undefined): {
    id: string;
  } {
    if (expression !== undefined && ts.isIdentifier(expression)) {
      return {
        id: expression.text,
      };
    }

    return {
      id: expression === undefined ? "unknown-workflow" : expression.getText(sourceFile),
    };
  }

  function describeInputRef(
    expression: ts.Expression | undefined,
  ): StructureReference {
    if (expression === undefined) {
      return {
        kind: "expression",
        source: "undefined",
      };
    }

    if (ts.isIdentifier(expression)) {
      const nodeOutput = outputVariables.get(expression.text);

      if (nodeOutput !== undefined) {
        return nodeOutput;
      }

      if (projectInputNames.has(expression.text)) {
        return {
          kind: "workflow-input",
          name: expression.text,
        };
      }

      return {
        kind: "variable",
        name: expression.text,
      };
    }

    return {
      kind: "value",
      value: evaluateExpression(expression),
    };
  }

  function describeOutputRef(node: ts.CallExpression): StructureReference {
    const variableName = readAssignedVariableName(node);

    if (variableName !== undefined) {
      return {
        kind: "variable",
        name: variableName,
      };
    }

    if (isReturnedExpression(node)) {
      return {
        kind: "workflow-output",
      };
    }

    return {
      kind: "expression",
      source: "unused",
    };
  }
}

function findProjectScriptPaths(projectDir: string): string[] {
  if (!existsSync(projectDir)) {
    return [];
  }

  return collectProjectScriptPaths(projectDir).sort((left, right) => {
    return left.localeCompare(right);
  });
}

function collectProjectScriptPaths(directory: string): string[] {
  const entries = readdirSync(directory);
  const scriptPaths: string[] = [];

  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }

    const entryPath = path.join(directory, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      scriptPaths.push(...collectProjectScriptPaths(entryPath));
      continue;
    }

    if (
      stat.isFile() &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts")
    ) {
      scriptPaths.push(entryPath);
    }
  }

  return scriptPaths;
}

function findDuplicateDeclarations(
  declarations: ScriptNameOccurrence[],
): ScriptRuleViolation[] {
  const declarationsByScopeAndName = new Map<string, ScriptNameOccurrence[]>();

  for (const declaration of declarations) {
    const key = `${declaration.scopeKey}:${declaration.normalizedName}`;
    const existing = declarationsByScopeAndName.get(key);

    if (existing === undefined) {
      declarationsByScopeAndName.set(key, [declaration]);
      continue;
    }

    existing.push(declaration);
  }

  return [...declarationsByScopeAndName.values()]
    .filter((items) => items.length > 1)
    .map((items) => {
      const firstItem = items[0];

      return {
        type: "duplicate_script_declaration",
        name: firstItem?.name ?? "",
        message: `Duplicate script declaration "${firstItem?.name ?? ""}".`,
        locations: items.map((item) => item.location),
      };
    });
}

function findDuplicateNodeNames(
  nodeNames: NodeNameOccurrence[],
): ScriptRuleViolation[] {
  const nodeNamesByName = new Map<string, NodeNameOccurrence[]>();

  for (const nodeName of nodeNames) {
    const existing = nodeNamesByName.get(nodeName.normalizedName);

    if (existing === undefined) {
      nodeNamesByName.set(nodeName.normalizedName, [nodeName]);
      continue;
    }

    existing.push(nodeName);
  }

  return [...nodeNamesByName.values()]
    .filter((items) => items.length > 1)
    .map((items) => {
      const firstItem = items[0];

      return {
        type: "duplicate_node_name",
        name: firstItem?.name ?? "",
        message: `Duplicate node name "${firstItem?.name ?? ""}".`,
        locations: items.map((item) => item.location),
      };
    });
}

function findDeclarationNodeNameConflicts(
  declarations: ScriptNameOccurrence[],
  nodeNames: NodeNameOccurrence[],
): ScriptRuleViolation[] {
  const nodeNamesByName = new Map<string, NodeNameOccurrence[]>();
  const violations: ScriptRuleViolation[] = [];

  for (const nodeName of nodeNames) {
    const existing = nodeNamesByName.get(nodeName.normalizedName);

    if (existing === undefined) {
      nodeNamesByName.set(nodeName.normalizedName, [nodeName]);
      continue;
    }

    existing.push(nodeName);
  }

  for (const declaration of declarations) {
    if (!declaration.canConflictWithNode) {
      continue;
    }

    const conflictingNodes = nodeNamesByName.get(declaration.normalizedName);

    if (conflictingNodes === undefined) {
      continue;
    }

    violations.push({
      type: "declaration_conflicts_with_node",
      name: declaration.name,
      message: `Script declaration "${declaration.name}" conflicts with node name "${conflictingNodes[0]?.name ?? ""}".`,
      locations: [
        declaration.location,
        ...conflictingNodes.map((nodeName) => nodeName.location),
      ],
    });
  }

  return violations;
}

function findProjectOutputTypeViolations(
  outputTypes: OutputTypeOccurrence[],
  options: {
    projectName?: string;
  },
): ScriptRuleViolation[] {
  if (options.projectName === undefined) {
    return [];
  }

  const expectedTypeName = createProjectOutputTypeName(options.projectName);
  const matchedOutputTypes = outputTypes.filter((outputType) => {
    return outputType.name === expectedTypeName;
  });

  return matchedOutputTypes
    .filter((outputType) => !outputType.extendsProjectExecutorResult)
    .map((outputType) => ({
      type: "project_output_type_not_executor_result",
      name: outputType.name,
      message: `Workflow output type "${outputType.name}" must extend ExecutorResult.`,
      locations: [outputType.location],
    }));
}

function canDeclarationConflictWithNode(node: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function readDeclarationNames(node: ts.Node): string[] {
  if (ts.isVariableDeclaration(node)) {
    return readBindingNames(node.name);
  }

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name === undefined ? [] : [node.name.text];
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return readPropertyName(node.name);
  }

  return [];
}

function readBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }

  const names: string[] = [];

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }

    names.push(...readBindingNames(element.name));
  }

  return names;
}

function readPropertyName(name: ts.PropertyName): string[] {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return [name.text];
  }

  return [];
}

function readNodeFactoryName(expression: ts.LeftHandSideExpression): string | undefined {
  const name = readProjectApiCallName(expression);

  if (name === undefined) {
    return undefined;
  }

  return NODE_FACTORY_NAMES.has(name) ? name : undefined;
}

function isRunNodeCall(node: ts.CallExpression): boolean {
  const name = readProjectApiCallName(node.expression);

  return name === "runNode" || name === "runStreamNode";
}

function isRunProjectCall(node: ts.CallExpression): boolean {
  return readProjectApiCallName(node.expression) === "runProject";
}

function isRunIfCall(node: ts.CallExpression): boolean {
  return readProjectApiCallName(node.expression) === "runIf";
}

function isRunLoopCall(node: ts.CallExpression): boolean {
  const name = readProjectApiCallName(node.expression);

  return name === "runFor" || name === "runWhile";
}

function readKnownProjectApiCallName(
  expression: ts.LeftHandSideExpression,
): string | undefined {
  const name = readProjectApiCallName(expression);

  if (name === undefined || !STEAMHARNESS_RUNTIME_API_NAMES.has(name)) {
    return undefined;
  }

  return name;
}

function isProjectRunMethod(node: ts.Node): node is ts.MethodDeclaration {
  if (
    !ts.isMethodDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    node.name.text !== "run"
  ) {
    return false;
  }

  return findProjectDefinitionCall(node) !== undefined;
}

function findProjectDefinitionCall(node: ts.MethodDeclaration): ts.CallExpression | undefined {
  const parent = node.parent;
  if (!ts.isObjectLiteralExpression(parent)) return undefined;

  let expression: ts.Expression = parent;
  while (isTransparentExpressionParent(expression.parent, expression)) {
    expression = expression.parent;
  }
  return isProjectDefineProjectCall(expression.parent) ? expression.parent : undefined;
}

function createsTreeTraversalBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

function readRunNodeCallee(node: ts.CallExpression): "runNode" | "runStreamNode" {
  if (readProjectApiCallName(node.expression) === "runStreamNode") {
    return "runStreamNode";
  }

  return "runNode";
}

function isProjectDefineExecutorCall(node: ts.CallExpression): boolean {
  return readProjectApiCallName(node.expression) === "defineExecutor" ||
    readProjectApiCallName(node.expression) === "defineProjectExecutor";
}

function isProjectDefineProjectCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && readProjectApiCallName(node.expression) === "defineProject";
}

function readProjectApiCallName(
  expression: ts.LeftHandSideExpression,
): string | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "steamharness"
  ) {
    return expression.name.text;
  }

  return undefined;
}

function readAssignedVariableName(node: ts.Node): string | undefined {
  let expression = node;
  while (
    (ts.isAwaitExpression(expression.parent) && expression.parent.expression === expression) ||
    isTransparentExpressionParent(expression.parent, expression)
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;

  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }

  return undefined;
}

function readProjectDefinitionBindingName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  const assignedName = readAssignedVariableName(node);
  if (assignedName !== undefined) return assignedName;

  let expression = node;
  while (isTransparentExpressionParent(expression.parent, expression)) {
    expression = expression.parent;
  }
  return ts.isExportAssignment(expression.parent) &&
    !expression.parent.isExportEquals &&
    expression.parent.expression === expression
    ? "default"
    : undefined;
}

function isTransparentExpressionParent(parent: ts.Node, expression: ts.Node): parent is (
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.NonNullExpression
  | ts.SatisfiesExpression
) {
  return (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) && parent.expression === expression;
}

function describeApiCallOutputRef(node: ts.CallExpression): StructureReference | undefined {
  const assignedName = readAssignedVariableName(node);
  if (assignedName !== undefined) {
    return {
      kind: "variable",
      name: assignedName,
    };
  }

  if (isReturnedExpression(node)) {
    return {
      kind: "workflow-output",
    };
  }

  return undefined;
}

function isReturnedExpression(node: ts.Node): boolean {
  const expression = ts.isAwaitExpression(node.parent) ? node.parent : node;

  return ts.isReturnStatement(expression.parent) && expression.parent.expression === expression;
}

function readStructurePropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function findStaticPropertyAssignment(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && readStructurePropertyName(property.name) === name
  );
}

function hasPropertyName(node: ts.ObjectLiteralElementLike): node is ts.ObjectLiteralElementLike & {
  name: ts.PropertyName;
} {
  return "name" in node && node.name !== undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function interfaceExtendsProjectExecutorResult(
  node: ts.InterfaceDeclaration,
): boolean {
  return (
    node.heritageClauses?.some((clause) => {
      return (
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some((type) => {
          return isProjectExecutorResultExpression(type.expression);
        })
      );
    }) ?? false
  );
}

function isProjectExecutorResultTypeNode(typeNode: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(typeNode)) {
    return isProjectExecutorResultEntityName(typeNode.typeName);
  }

  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some(isProjectExecutorResultTypeNode);
  }

  return false;
}

function isProjectExecutorResultExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "ExecutorResult";
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "ExecutorResult";
  }

  return false;
}

function isProjectExecutorResultEntityName(name: ts.EntityName): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === "ExecutorResult";
  }

  return name.right.text === "ExecutorResult";
}

function readNodeNameFromFactoryCall(
  node: ts.CallExpression,
  factoryName: string,
): string | undefined {
  const firstArgument = node.arguments[0];

  if (firstArgument !== undefined && ts.isObjectLiteralExpression(firstArgument)) {
    const nameProperty = firstArgument.properties.find((property) => {
      return (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "name"
      );
    });

    if (
      nameProperty !== undefined &&
      ts.isPropertyAssignment(nameProperty) &&
      ts.isStringLiteralLike(nameProperty.initializer)
    ) {
      return nameProperty.initializer.text;
    }

    if (nameProperty !== undefined) {
      return undefined;
    }
  }

  return NODE_FACTORY_DEFAULT_NAMES[
    factoryName as keyof typeof NODE_FACTORY_DEFAULT_NAMES
  ];
}

function createsDeclarationScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isObjectLiteralExpression(node)
  );
}

function createLocation(
  cwd: string,
  filePath: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): ScriptRuleLocation {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return {
    file: path.relative(cwd, filePath),
    line: location.line + 1,
    column: location.character + 1,
  };
}

function createScopeKey(filePath: string, kind: string, position: number): string {
  return `${filePath}:${kind}:${position}`;
}

function normalizeComparableName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  return normalized === "" ? name.trim().toLowerCase() : normalized;
}

function createProjectOutputTypeName(projectName: string): string {
  const words = projectName
    .split(/[^a-zA-Z0-9]+/g)
    .map((word) => word.trim())
    .filter((word) => word !== "");
  const prefix =
    words.length === 0
      ? projectName
      : words
          .map((word) => {
            return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
          })
          .join("");

  return `${prefix}Output`;
}
