import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { workflowRuntimeApi } from "../runtime-api";
import { WorkflowError } from "../workflow/index";
import type {
  WorkflowConversationDefinition,
  WorkflowEntrypointGroupDefinition,
  WorkflowNodeRegistryItem,
  WorkflowParamDeclaration,
  WorkflowParamDefinition,
  WorkflowParamLayout,
} from "./types";
import { assertWorkflowParamDeclarations, normalizeWorkflowParamDeclarations, readWorkflowParamDefinitionError } from "./param-definition";
import { assertConversationFooter } from "./conversation-footer";
import { assertConversationUserInput } from "./conversation-input";
import { assertConversationCommands } from "./conversation-commands";
import { WORKFLOW_ENTRYPOINT_ID_PATTERN } from "./definition";
import type { WorkflowTokenUsageDefinition } from "../token-usage/index";
import type { WorkflowToolPermissionDefinition } from "../tool-permissions/index";
import {
  WORKFLOW_PROJECT_TYPE_MIGRATION_EXAMPLE,
  assertNeverWorkflowExecutorProjectType,
  isWorkflowExecutorProjectType,
  type WorkflowExecutorProjectType,
} from "../project-types";

export type WorkflowScriptRuleViolationType =
  | "duplicate_script_declaration"
  | "duplicate_node_name"
  | "declaration_conflicts_with_node"
  | "workflow_output_type_not_executor_result"
  | "invalid_executor_project_type"
  | "legacy_conversation_enabled"
  | "invalid_workflow_entrypoints"
  | "legacy_workflow_executor_fields"
  | "invalid_executor_param_configuration"
  | "project_type_configuration_conflict";

export interface WorkflowScriptRuleLocation {
  file: string;
  line: number;
  column: number;
}

export interface WorkflowScriptRuleViolation {
  type: WorkflowScriptRuleViolationType;
  name: string;
  message: string;
  locations: WorkflowScriptRuleLocation[];
}

export interface WorkflowDefinedNode {
  order: number;
  name: string;
  location: WorkflowScriptRuleLocation;
}

export type WorkflowStructureValue =
  | {
      kind: "literal";
      value: string | number | boolean | null;
    }
  | {
      kind: "array";
      value: WorkflowStructureValue[];
    }
  | {
      kind: "object";
      value: Record<string, WorkflowStructureValue>;
    }
  | {
      kind: "function";
      source: string;
    }
  | {
      kind: "variable";
      name: string;
      resolved?: WorkflowStructureValue;
    }
  | {
      kind: "expression";
      source: string;
    };

export type WorkflowStructureReference =
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
      value: WorkflowStructureValue;
    }
  | {
      kind: "expression";
      source: string;
    };

export interface WorkflowStructureNode {
  id: string;
  order: number;
  standardName: string;
  configuredName?: string;
  factory: string;
  location: WorkflowScriptRuleLocation;
  options: WorkflowStructureValue;
}

export interface WorkflowStructureCall {
  order: number;
  callee: "runNode" | "runStreamNode" | "runIf" | "runFor" | "runWhile" | "runWorkflow";
  nodeRef: string;
  standardName?: string;
  location: WorkflowScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: WorkflowStructureReference | WorkflowStructureValue;
  }>;
  input: WorkflowStructureReference;
  output: WorkflowStructureReference;
}

export interface WorkflowStructureApiCall {
  order: number;
  method: string;
  location: WorkflowScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: WorkflowStructureValue;
  }>;
  output?: WorkflowStructureReference;
}

export interface WorkflowStructureEdge {
  order: number;
  from: WorkflowStructureReference;
  to: WorkflowStructureReference;
}

export type WorkflowStructureTreeItem =
  | WorkflowStructureCallTreeItem
  | WorkflowStructureIfTreeItem
  | WorkflowStructureRunIfTreeItem
  | WorkflowStructureLoopTreeItem;

export interface WorkflowStructureCallTreeItem {
  kind: "call";
  order: number;
  callOrder: number;
  callee: "runNode" | "runStreamNode" | "runIf" | "runFor" | "runWhile" | "runWorkflow";
  nodeRef: string;
  standardName?: string;
  location: WorkflowScriptRuleLocation;
  arguments: WorkflowStructureCall["arguments"];
  input: WorkflowStructureReference;
  output: WorkflowStructureReference;
}

export interface WorkflowStructureIfTreeItem {
  kind: "if";
  order: number;
  condition: string;
  location: WorkflowScriptRuleLocation;
  branches: WorkflowStructureIfBranch[];
}

export interface WorkflowStructureIfBranch {
  kind: "if" | "else-if" | "else";
  condition?: string;
  location: WorkflowScriptRuleLocation;
  children: WorkflowStructureTreeItem[];
}

export interface WorkflowStructureRunIfTreeItem {
  kind: "run-if";
  order: number;
  callOrder: number;
  callId: string;
  label?: string;
  location: WorkflowScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: WorkflowStructureReference | WorkflowStructureValue;
  }>;
  input: WorkflowStructureReference;
  output: WorkflowStructureReference;
  branches: WorkflowStructureRunIfBranch[];
}

export interface WorkflowStructureRunIfBranch {
  kind: "if" | "else-if" | "else";
  label?: string;
  description?: string;
  condition?: string;
  location: WorkflowScriptRuleLocation;
  children: WorkflowStructureTreeItem[];
}

export interface WorkflowStructureLoopTreeItem {
  kind: "loop";
  source: "run-for" | "run-while";
  order: number;
  callOrder: number;
  callId: string;
  label?: string;
  condition?: string;
  items?: string;
  maxIterations?: number;
  location: WorkflowScriptRuleLocation;
  arguments: Array<{
    position: number;
    source: string;
    value: WorkflowStructureReference | WorkflowStructureValue;
  }>;
  input: WorkflowStructureReference;
  output: WorkflowStructureReference;
  children: WorkflowStructureTreeItem[];
}

export interface WorkflowStructureTree {
  kind: "workflow-run";
  workflowRef?: string;
  workflowKey?: string;
  location: WorkflowScriptRuleLocation;
  children: WorkflowStructureTreeItem[];
}

export interface WorkflowStructureWorkflow {
  name: string;
  dir: string;
  files: string[];
}

export interface WorkflowStructureDefinitions {
  nodes: Record<string, WorkflowStructureNode>;
  apiCalls: WorkflowStructureApiCall[];
  variables: Record<string, Omit<WorkflowStructureVariable, "name">>;
  registry: Record<string, WorkflowNodeRegistryItem>;
}

export type WorkflowStructureExecutionItem =
  | WorkflowStructureExecutionNode
  | WorkflowStructureExecutionBranch
  | WorkflowStructureExecutionLoop;

export interface WorkflowStructureExecution {
  kind: "sequence";
  location?: WorkflowScriptRuleLocation;
  children: WorkflowStructureExecutionItem[];
}

export interface WorkflowStructureExecutionNode {
  kind: "node";
  order: number;
  callId: string;
  callOrder: number;
  callee: "runNode" | "runStreamNode" | "runIf" | "runFor" | "runWhile" | "runWorkflow";
  nodeId: string;
  standardName?: string;
  location: WorkflowScriptRuleLocation;
  arguments: WorkflowStructureCall["arguments"];
  input: WorkflowStructureReference;
  output: WorkflowStructureReference;
}

export interface WorkflowStructureExecutionBranch {
  kind: "branch";
  source: "if" | "run-if" | "question-classifier";
  order: number;
  branchId: string;
  condition?: string;
  decision?: WorkflowStructureExecutionNode;
  location: WorkflowScriptRuleLocation;
  branches: WorkflowStructureExecutionBranchPath[];
}

export interface WorkflowStructureExecutionBranchPath {
  kind: "if" | "else-if" | "else" | "case";
  value?: string;
  label?: string;
  description?: string;
  condition?: string;
  location: WorkflowScriptRuleLocation;
  children: WorkflowStructureExecutionItem[];
}

export interface WorkflowStructureExecutionLoop {
  kind: "loop";
  source: "run-for" | "run-while";
  order: number;
  loopId: string;
  label?: string;
  condition?: string;
  items?: string;
  maxIterations?: number;
  decision: WorkflowStructureExecutionNode;
  location: WorkflowScriptRuleLocation;
  children: WorkflowStructureExecutionItem[];
}

export interface WorkflowStructureDiagnostics {
  warnings: WorkflowStructureWarning[];
  violations: WorkflowScriptRuleViolation[];
}

export interface WorkflowStructureVariable {
  name: string;
  location: WorkflowScriptRuleLocation;
  value: WorkflowStructureValue;
}

export interface WorkflowStructureWarning {
  message: string;
  location?: WorkflowScriptRuleLocation;
}

export interface WorkflowStructureInspection {
  projectType?: WorkflowExecutorProjectType;
  workflow: WorkflowStructureWorkflow;
  definitions: WorkflowStructureDefinitions;
  diagnostics: WorkflowStructureDiagnostics;
  defaultEntrypoint?: string;
  entrypoints?: WorkflowStructureEntrypoint[];
  execution?: WorkflowStructureExecution;
  params?: WorkflowParamDefinition[];
  paramLayout?: WorkflowParamLayout;
  paramResolver?: { enabled: true };
  tools?: WorkflowToolPermissionDefinition[];
  conversation?: WorkflowConversationDefinition;
  tokenUsage?: WorkflowTokenUsageDefinition;
  registry?: WorkflowNodeRegistryItem[];
}

export interface WorkflowStructureEntrypoint {
  id: string;
  title: string;
  description?: string;
  group?: WorkflowEntrypointGroupDefinition;
  workflowName: string;
  execution: WorkflowStructureExecution;
  params?: WorkflowParamDefinition[];
  paramLayout?: WorkflowParamLayout;
  paramResolver?: { enabled: true };
  tools?: WorkflowToolPermissionDefinition[];
  tokenUsage?: WorkflowTokenUsageDefinition;
  registry?: WorkflowNodeRegistryItem[];
}

interface AnalyzedWorkflowEntrypoint extends Omit<WorkflowStructureEntrypoint, "execution" | "workflowName"> {
  workflowRef: string;
  workflowKey?: string;
  workflowName?: string;
  location: WorkflowScriptRuleLocation;
}

interface WorkflowModuleBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface WorkflowModuleExportBinding {
  importedName?: string;
  localName?: string;
  moduleSpecifier?: string;
}

interface WorkflowModuleBindings {
  imports: Record<string, WorkflowModuleBinding>;
  exports: Record<string, WorkflowModuleExportBinding>;
  exportAllModuleSpecifiers: string[];
}

interface AnalyzedWorkflowModule {
  analysis: ScriptAnalysis;
  bindings: WorkflowModuleBindings;
  filePath: string;
  sourceFile: ts.SourceFile;
}

interface ResolvedWorkflowDefinition {
  key: string;
  name: string;
}

export interface WorkflowScriptInspection {
  definedNodes: WorkflowDefinedNode[];
  violations: WorkflowScriptRuleViolation[];
}

export interface ValidateWorkflowScriptsOptions {
  cwd: string;
  workflowName: string;
  workflowDir: string;
}

export interface ScriptNameOccurrence {
  name: string;
  normalizedName: string;
  scopeKey: string;
  canConflictWithNode: boolean;
  location: WorkflowScriptRuleLocation;
}

export interface NodeNameOccurrence {
  name: string;
  normalizedName: string;
  location: WorkflowScriptRuleLocation;
}

export interface WorkflowOutputTypeOccurrence {
  name: string;
  extendsWorkflowExecutorResult: boolean;
  location: WorkflowScriptRuleLocation;
}

export interface ScriptAnalysis {
  declarations: ScriptNameOccurrence[];
  nodeNames: NodeNameOccurrence[];
  definedNodes: WorkflowDefinedNode[];
  workflowOutputTypes: WorkflowOutputTypeOccurrence[];
  structureNodes: WorkflowStructureNode[];
  structureCalls: WorkflowStructureCall[];
  structureApiCalls: WorkflowStructureApiCall[];
  structureEdges: WorkflowStructureEdge[];
  structureTrees: WorkflowStructureTree[];
  structureVariables: WorkflowStructureVariable[];
  structureWarnings: WorkflowStructureWarning[];
  executorDefinitionCount: number;
  executorProjectType?: WorkflowExecutorProjectType;
  executorConfigurationViolations: WorkflowScriptRuleViolation[];
  executorParams?: WorkflowParamDefinition[];
  executorParamLayout?: WorkflowParamLayout;
  executorParamResolver?: { enabled: true };
  executorTools?: WorkflowToolPermissionDefinition[];
  executorConversation?: WorkflowConversationDefinition;
  executorTokenUsage?: WorkflowTokenUsageDefinition;
  executorRegistry?: WorkflowNodeRegistryItem[];
  executorDefaultEntrypoint?: string;
  executorEntrypoints?: AnalyzedWorkflowEntrypoint[];
  workflowDefinitions: Record<string, string>;
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
const WORKFLOW_RUNTIME_API_NAMES = new Set([
  ...Object.keys(workflowRuntimeApi),
  "defineWorkflowExecutor",
]);

export function validateWorkflowScripts(
  options: ValidateWorkflowScriptsOptions,
): WorkflowScriptInspection {
  const inspection = inspectWorkflowScripts(options);

  if (inspection.violations.length === 0) {
    return inspection;
  }

  throw new WorkflowError({
    type: "input_validation",
    message: `Workflow "${options.workflowName}" script validation failed.`,
    metadata: {
      workflow: options.workflowName,
      violations: inspection.violations,
    },
  });
}

export function inspectWorkflowScripts(
  options: ValidateWorkflowScriptsOptions,
): WorkflowScriptInspection {
  const scriptPaths = findWorkflowScriptPaths(options.workflowDir);

  if (scriptPaths.length === 0) {
    return {
      definedNodes: [],
      violations: [createMissingExecutorViolation()],
    };
  }

  const analysis = analyzeWorkflowScripts(options.cwd, scriptPaths);

  return {
    definedNodes: analysis.definedNodes,
    violations: findWorkflowScriptRuleViolations(analysis, {
      workflowName: options.workflowName,
    }),
  };
}

export function inspectWorkflowStructure(
  options: ValidateWorkflowScriptsOptions,
): WorkflowStructureInspection {
  const scriptPaths = findWorkflowScriptPaths(options.workflowDir);

  if (scriptPaths.length === 0) {
    return {
      workflow: {
        name: options.workflowName,
        dir: options.workflowDir,
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

  const analysis = analyzeWorkflowScripts(options.cwd, scriptPaths);

  return createWorkflowStructureInspection({
    workflowName: options.workflowName,
    workflowDir: options.workflowDir,
    files: scriptPaths.map((scriptPath) => path.relative(options.cwd, scriptPath)),
    analysis,
  });
}

export function analyzeWorkflowScriptSource(
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

export function validateWorkflowScriptSource(
  sourceText: string,
  fileName = "index.ts",
): WorkflowScriptRuleViolation[] {
  return findWorkflowScriptRuleViolations(
    analyzeWorkflowScriptSource(sourceText, fileName),
  );
}

function createProjectTypeRuleMessage(reason: string): string {
  return `${reason}\n\nMigration example:\n${WORKFLOW_PROJECT_TYPE_MIGRATION_EXAMPLE}`;
}

function createMissingExecutorViolation(): WorkflowScriptRuleViolation {
  return {
    type: "invalid_executor_project_type",
    name: "executor",
    message: createProjectTypeRuleMessage(
      'Workflow must export workflow.defineExecutor({ projectType: "workflow" | "conversation", ... }).',
    ),
    locations: [],
  };
}

function findWorkflowScriptRuleViolations(
  analysis: ScriptAnalysis,
  options: {
    workflowName?: string;
  } = {},
): WorkflowScriptRuleViolation[] {
  return [
    ...(analysis.executorDefinitionCount === 0 ? [createMissingExecutorViolation()] : []),
    ...analysis.executorConfigurationViolations,
    ...findDuplicateDeclarations(analysis.declarations),
    ...findDuplicateNodeNames(analysis.nodeNames),
    ...findDeclarationNodeNameConflicts(
      analysis.declarations,
      analysis.nodeNames,
    ),
    ...findUnknownWorkflowEntrypointReferences(analysis),
    ...findWorkflowOutputTypeViolations(analysis.workflowOutputTypes, options),
  ];
}

function findUnknownWorkflowEntrypointReferences(
  analysis: ScriptAnalysis,
): WorkflowScriptRuleViolation[] {
  if (analysis.executorProjectType !== "workflow") return [];

  return (analysis.executorEntrypoints ?? []).flatMap((entrypoint) => (
    entrypoint.workflowKey !== undefined &&
    Object.hasOwn(analysis.workflowDefinitions, entrypoint.workflowKey)
      ? []
      : [{
          type: "invalid_workflow_entrypoints" as const,
          name: entrypoint.id,
          message: `Workflow entrypoint "${entrypoint.id}" must reference a workflow defined with workflow.defineWorkflow(...) in this project.`,
          locations: [entrypoint.location],
        }]
  ));
}

function createWorkflowStructureInspection(options: {
  workflowName: string;
  workflowDir: string;
  files: string[];
  analysis: ScriptAnalysis;
}): WorkflowStructureInspection {
  const nodeIds = new Set(options.analysis.structureNodes.map((node) => node.id));
  const nodesById = Object.fromEntries(
    options.analysis.structureNodes.map((node) => [node.id, node]),
  );
  const entrypoints = options.analysis.executorEntrypoints?.map((entrypoint) => ({
    id: entrypoint.id,
    title: entrypoint.title,
    ...(entrypoint.description === undefined ? {} : { description: entrypoint.description }),
    ...(entrypoint.group === undefined ? {} : { group: entrypoint.group }),
    workflowName: entrypoint.workflowName ??
      (entrypoint.workflowKey === undefined
        ? undefined
        : options.analysis.workflowDefinitions[entrypoint.workflowKey]) ??
      entrypoint.workflowRef,
    execution: createWorkflowStructureExecution(
      options.analysis.structureTrees.filter((tree) => (
        entrypoint.workflowKey !== undefined && tree.workflowKey === entrypoint.workflowKey
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
      name: options.workflowName,
      dir: options.workflowDir,
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
              variable.name !== "workflow" &&
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
      violations: findWorkflowScriptRuleViolations(options.analysis, {
        workflowName: options.workflowName,
      }),
    },
    ...(options.analysis.executorProjectType === "workflow"
      ? {
          defaultEntrypoint: options.analysis.executorDefaultEntrypoint,
          entrypoints: entrypoints ?? [],
        }
      : {
          execution: createWorkflowStructureExecution(
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

function createWorkflowStructureExecution(
  trees: WorkflowStructureTree[],
  nodesById: Record<string, WorkflowStructureNode>,
): WorkflowStructureExecution {
  const firstTree = trees[0];

  return {
    kind: "sequence",
    location: firstTree?.location,
    children: trees.flatMap((tree) => {
      return tree.children.map((item) => {
        return convertWorkflowStructureTreeItem(item, nodesById);
      });
    }),
  };
}

function convertWorkflowStructureTreeItem(
  item: WorkflowStructureTreeItem,
  nodesById: Record<string, WorkflowStructureNode>,
): WorkflowStructureExecutionItem {
  if (item.kind === "call") {
    const nodeItem: WorkflowStructureExecutionNode = {
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
    const decision: WorkflowStructureExecutionNode = {
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
          return convertWorkflowStructureTreeItem(child, nodesById);
        }),
      })),
    };
  }

  if (item.kind === "loop") {
    const standardName = item.source;
    const callee = item.source === "run-for" ? "runFor" : "runWhile";
    const decision: WorkflowStructureExecutionNode = {
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
        return convertWorkflowStructureTreeItem(child, nodesById);
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
        return convertWorkflowStructureTreeItem(child, nodesById);
      }),
    })),
  };
}

function createQuestionClassifierBranchItem(
  item: WorkflowStructureExecutionNode,
  nodesById: Record<string, WorkflowStructureNode>,
): WorkflowStructureExecutionBranch | undefined {
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
  options: WorkflowStructureValue,
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
  value: WorkflowStructureValue | undefined,
): WorkflowStructureValue | undefined {
  if (value?.kind === "variable" && value.resolved !== undefined) {
    return resolveStructureValue(value.resolved);
  }

  return value;
}

function analyzeWorkflowScripts(cwd: string, scriptPaths: string[]): ScriptAnalysis {
  const analysis: ScriptAnalysis = {
    declarations: [],
    nodeNames: [],
    definedNodes: [],
    workflowOutputTypes: [],
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
    workflowDefinitions: {},
  };

  const modules = scriptPaths.map((scriptPath): AnalyzedWorkflowModule => {
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
      bindings: collectWorkflowModuleBindings(sourceFile),
      filePath: path.resolve(scriptPath),
      sourceFile,
    };
  });
  const modulesByPath = new Map(modules.map((module) => [module.filePath, module]));

  for (const module of modules) {
    for (const entrypoint of module.analysis.executorEntrypoints ?? []) {
      const definition = resolveWorkflowDefinition({
        filePath: module.filePath,
        localName: entrypoint.workflowRef,
        modulesByPath,
      });
      entrypoint.workflowKey = definition?.key;
      entrypoint.workflowName = definition?.name;
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
    analysis.workflowOutputTypes.push(...fileAnalysis.workflowOutputTypes);
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
        return offsetWorkflowStructureTreeCallOrder(tree, structureCallOffset);
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
    for (const [workflowKey, workflowName] of Object.entries(fileAnalysis.workflowDefinitions)) {
      analysis.workflowDefinitions[workflowKey] = workflowName;
    }
  }

  return analysis;
}

function collectWorkflowModuleBindings(sourceFile: ts.SourceFile): WorkflowModuleBindings {
  const bindings: WorkflowModuleBindings = {
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
      } else if (isWorkflowDefineWorkflowCall(expression)) {
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

function resolveWorkflowDefinition(options: {
  filePath: string;
  localName: string;
  modulesByPath: Map<string, AnalyzedWorkflowModule>;
}): ResolvedWorkflowDefinition | undefined {
  return resolveLocal(options.filePath, options.localName, new Set<string>());

  function resolveLocal(
    filePath: string,
    localName: string,
    visited: Set<string>,
  ): ResolvedWorkflowDefinition | undefined {
    const visitKey = `local\0${filePath}\0${localName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    const module = options.modulesByPath.get(filePath);
    if (module === undefined) return undefined;
    const definitionKey = createWorkflowDefinitionKey(filePath, localName);
    const workflowName = module.analysis.workflowDefinitions[definitionKey];
    if (workflowName !== undefined) {
      return { key: definitionKey, name: workflowName };
    }

    const imported = module.bindings.imports[localName];
    if (imported === undefined) return undefined;
    const importedFilePath = resolveWorkflowModulePath(
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
  ): ResolvedWorkflowDefinition | undefined {
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
      const exportedFilePath = resolveWorkflowModulePath(
        filePath,
        exported.moduleSpecifier,
        options.modulesByPath,
      );
      return exportedFilePath === undefined
        ? undefined
        : resolveExport(exportedFilePath, exported.importedName, visited);
    }

    let resolved: ResolvedWorkflowDefinition | undefined;
    for (const moduleSpecifier of module.bindings.exportAllModuleSpecifiers) {
      const exportedFilePath = resolveWorkflowModulePath(
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

function resolveWorkflowModulePath(
  fromFilePath: string,
  moduleSpecifier: string,
  modulesByPath: Map<string, AnalyzedWorkflowModule>,
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

function createWorkflowDefinitionKey(filePath: string, localName: string): string {
  return `${path.resolve(filePath)}\0${localName}`;
}

function hasExportModifier(node: ts.VariableStatement): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function offsetStructureReferenceCallOrder<
  Value extends WorkflowStructureReference | WorkflowStructureValue,
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

function offsetWorkflowStructureTreeCallOrder(
  tree: WorkflowStructureTree,
  callOffset: number,
): WorkflowStructureTree {
  if (callOffset === 0) {
    return tree;
  }

  return {
    ...tree,
    children: tree.children.map((item) => {
      return offsetWorkflowStructureTreeItemCallOrder(item, callOffset);
    }),
  };
}

function offsetWorkflowStructureTreeItemCallOrder(
  item: WorkflowStructureTreeItem,
  callOffset: number,
): WorkflowStructureTreeItem {
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
          return offsetWorkflowStructureTreeItemCallOrder(child, callOffset);
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
        return offsetWorkflowStructureTreeItemCallOrder(child, callOffset);
      }),
    };
  }

  return {
    ...item,
    branches: item.branches.map((branch) => ({
      ...branch,
      children: branch.children.map((child) => {
        return offsetWorkflowStructureTreeItemCallOrder(child, callOffset);
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
    workflowOutputTypes: [],
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
    workflowDefinitions: {},
  };
  const scopeStack = [createScopeKey(filePath, "source", 0)];
  const constValues = new Map<string, WorkflowStructureValue>();
  const nodeIdsByVariable = new Map<string, string>();
  const nodeNamesById = new Map<string, string>();
  const outputVariables = new Map<string, WorkflowStructureReference>();
  const workflowInputNames = new Set<string>();
  const structureCallsByNode = new WeakMap<ts.CallExpression, WorkflowStructureCall>();
  const structureWorkflowCallsByNode = new WeakMap<ts.CallExpression, WorkflowStructureCall>();
  const structureRunIfByNode = new WeakMap<ts.CallExpression, WorkflowStructureRunIfTreeItem>();
  const structureLoopByNode = new WeakMap<ts.CallExpression, WorkflowStructureLoopTreeItem>();
  let treeItemOrder = 0;

  visitSourceFile(sourceFile);
  collectWorkflowRunTrees(sourceFile);

  return analysis;

  function visitSourceFile(node: ts.Node): void {
    collectDeclaration(node);
    collectTopLevelConst(node);
    collectWorkflowDefinitionMetadata(node);
    collectNodeName(node);
    collectWorkflowOutputType(node);
    collectWorkflowApiCall(node);
    collectRunNodeCall(node);
    collectRunWorkflowCall(node);
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
      collectWorkflowRunInputNames(node);
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

  function collectWorkflowOutputType(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node)) {
      analysis.workflowOutputTypes.push({
        name: node.name.text,
        extendsWorkflowExecutorResult: isWorkflowExecutorResultTypeNode(node.type),
        location: createLocation(cwd, filePath, sourceFile, node),
      });
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      analysis.workflowOutputTypes.push({
        name: node.name.text,
        extendsWorkflowExecutorResult: interfaceExtendsWorkflowExecutorResult(node),
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

  function collectWorkflowDefinitionMetadata(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      !isWorkflowDefineWorkflowCall(node) ||
      currentScopeKey() !== scopeStack[0]
    ) {
      return;
    }
    const variableName = readWorkflowDefinitionBindingName(node);
    const objectArg = node.arguments[0];
    if (variableName === undefined) return;
    const workflowOptions = objectArg === undefined ? undefined : unwrapExpression(objectArg);
    const workflowName = workflowOptions !== undefined && ts.isObjectLiteralExpression(workflowOptions)
      ? readStringProperty(workflowOptions, "name")
      : undefined;
    analysis.workflowDefinitions[createWorkflowDefinitionKey(filePath, variableName)] =
      workflowName ?? variableName;
  }

  function collectExecutorParams(node: ts.Node): void {
    if (
      !ts.isCallExpression(node) ||
      analysis.executorParams !== undefined
    ) {
      return;
    }

    if (!isWorkflowDefineExecutorCall(node)) {
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
    if (!isWorkflowDefineExecutorCall(node)) return;
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

    if (!isWorkflowDefineExecutorCall(node)) {
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

    const tools: WorkflowToolPermissionDefinition[] = [];

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

    if (!isWorkflowDefineExecutorCall(node)) {
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
    if (!ts.isCallExpression(node) || !isWorkflowDefineExecutorCall(node)) {
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
    const projectType = isWorkflowExecutorProjectType(declaredProjectType)
      ? declaredProjectType
      : inferStaticExecutorProjectType(objectArg);
    if (projectTypeProperty === undefined || !isWorkflowExecutorProjectType(declaredProjectType)) {
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
          assertNeverWorkflowExecutorProjectType(projectType);
      }
    }

    if (projectType === "workflow") {
      collectWorkflowEntrypoints(objectArg, location);
    }
  }

  function inferStaticExecutorProjectType(
    executorObject: ts.ObjectLiteralExpression,
  ): WorkflowExecutorProjectType | undefined {
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

  function collectWorkflowEntrypoints(
    executorObject: ts.ObjectLiteralExpression,
    executorLocation: WorkflowScriptRuleLocation,
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
          type: "legacy_workflow_executor_fields",
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
        type: "invalid_workflow_entrypoints",
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
        type: "invalid_workflow_entrypoints",
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
        type: "invalid_workflow_entrypoints",
        name: "entrypoints",
        message: "Workflow executor entrypoints must contain at least one entrypoint.",
        locations: [createLocation(cwd, filePath, sourceFile, entrypointsProperty)],
      });
      return;
    }

    const entrypoints: AnalyzedWorkflowEntrypoint[] = [];
    const ids = new Set<string>();
    const groups = new Map<string, {
      definition: WorkflowEntrypointGroupDefinition;
      location: WorkflowScriptRuleLocation;
    }>();
    for (const element of entrypointsProperty.initializer.elements) {
      if (
        !ts.isCallExpression(element) ||
        readWorkflowApiCallName(element.expression) !== "defineEntrypoint"
      ) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_workflow_entrypoints",
          name: "entrypoints",
          message: "Each entrypoints element must directly call workflow.defineEntrypoint({...}).",
          locations: [createLocation(cwd, filePath, sourceFile, element)],
        });
        continue;
      }
      const entrypointObject = element.arguments[0];
      if (entrypointObject === undefined || !ts.isObjectLiteralExpression(entrypointObject)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_workflow_entrypoints",
          name: "entrypoints",
          message: "workflow.defineEntrypoint(...) must receive an inline object literal.",
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
      const workflowRef = readIdentifierProperty(entrypointObject, "workflow");
      if (id === undefined || !WORKFLOW_ENTRYPOINT_ID_PATTERN.test(id)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_workflow_entrypoints",
          name: id ?? "id",
          message: `Workflow entrypoint id must match ${WORKFLOW_ENTRYPOINT_ID_PATTERN}.`,
          locations: [createLocation(cwd, filePath, sourceFile, entrypointObject)],
        });
        continue;
      }
      if (ids.has(id)) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_workflow_entrypoints",
          name: id,
          message: `Workflow executor declares duplicate entrypoint id "${id}".`,
          locations: [createLocation(cwd, filePath, sourceFile, entrypointObject)],
        });
        continue;
      }
      ids.add(id);
      if (title === undefined || title.trim() === "") {
        analysis.executorConfigurationViolations.push({
          type: "invalid_workflow_entrypoints",
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
          type: "invalid_workflow_entrypoints",
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
            type: "invalid_workflow_entrypoints",
            name: group.definition.id,
            message: `Workflow entrypoint group "${group.definition.id}" must use identical title and order in every entrypoint.`,
            locations: [existing.location, group.location],
          });
        } else if (existing === undefined) {
          groups.set(group.definition.id, group);
        }
      }
      if (workflowRef === undefined) {
        analysis.executorConfigurationViolations.push({
          type: "invalid_workflow_entrypoints",
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
        workflowRef,
        workflowKey: createWorkflowDefinitionKey(filePath, workflowRef),
        workflowName: analysis.workflowDefinitions[createWorkflowDefinitionKey(filePath, workflowRef)],
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
        type: "invalid_workflow_entrypoints",
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

    if (!isWorkflowDefineExecutorCall(node)) {
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

    if (!isWorkflowDefineExecutorCall(node)) {
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

    const registry: WorkflowNodeRegistryItem[] = [];

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
    definition: WorkflowEntrypointGroupDefinition;
    location: WorkflowScriptRuleLocation;
  } | undefined {
    if (property === undefined) return undefined;
    if (!ts.isPropertyAssignment(property)) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_workflow_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group must be an inline object literal.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }
    const initializer = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) {
      analysis.executorConfigurationViolations.push({
        type: "invalid_workflow_entrypoints",
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
        type: "invalid_workflow_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group must contain only one static id, title, and optional order property.`,
        locations: [createLocation(cwd, filePath, sourceFile, invalidProperty)],
      });
      return undefined;
    }

    const id = readStringProperty(initializer, "id");
    if (id === undefined || id.trim() === "") {
      analysis.executorConfigurationViolations.push({
        type: "invalid_workflow_entrypoints",
        name: entrypointId,
        message: `Workflow entrypoint "${entrypointId}" group id must be a non-empty static string literal.`,
        locations: [createLocation(cwd, filePath, sourceFile, property)],
      });
      return undefined;
    }
    const title = readStringProperty(initializer, "title");
    if (title === undefined || title.trim() === "") {
      analysis.executorConfigurationViolations.push({
        type: "invalid_workflow_entrypoints",
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
          type: "invalid_workflow_entrypoints",
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
  ): { params: WorkflowParamDefinition[]; layout?: WorkflowParamLayout } | undefined {
    const property = findStaticPropertyAssignment(obj, "params");
    if (property === undefined) return undefined;
    return readExecutorParamDeclarations(property, "Workflow entrypoint");
  }

  function readExecutorParamDeclarations(
    property: ts.PropertyAssignment,
    owner: string,
  ): { params: WorkflowParamDefinition[]; layout?: WorkflowParamLayout } | undefined {
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
    const declarations: WorkflowParamDeclaration[] = [];
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
          .filter((field): field is WorkflowParamDefinition => field !== undefined);
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
            }) as WorkflowParamDeclaration);
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
      const error = readWorkflowParamDefinitionError(param, {
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
        declarations.push({ ...param, kind: "mode", options: param.options ?? [] } as WorkflowParamDeclaration);
      } else if (kind === "slash") {
        const { control: _control, panel: _panel, multiple: _multiple, ...field } = param;
        const properties = ["control", "panel", "multiple"].filter(name => findStaticPropertyAssignment(element, name) !== undefined);
        if (properties.length) {
          analysis.executorConfigurationViolations.push({ type: "invalid_executor_param_configuration", name: param.name,
            message: `Slash parameter "${param.name}" cannot declare ${properties.join(", ")}.`,
            locations: [createLocation(cwd, filePath, sourceFile, element)] });
        }
        declarations.push({ ...field, kind: "slash" } as WorkflowParamDeclaration);
      } else if (kind === undefined) {
        declarations.push(param as WorkflowParamDeclaration);
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
      assertWorkflowParamDeclarations(declarations, owner === "Conversation executor" ? "conversation" : "workflow");
      return normalizeWorkflowParamDeclarations(declarations);
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
  ): WorkflowToolPermissionDefinition[] | undefined {
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
  ): WorkflowTokenUsageDefinition | undefined {
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
  ): WorkflowNodeRegistryItem[] | undefined {
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
  ): WorkflowParamDefinition | undefined {
    const name = readStringProperty(obj, "name");
    const flag = readStringProperty(obj, "flag");

    if (name === undefined || flag === undefined) {
      return undefined;
    }

    const type = (readStringProperty(obj, "type") as WorkflowParamDefinition["type"]) ?? "string";

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
    } as WorkflowParamDefinition;
  }

  function readToolPermissionObject(
    obj: ts.ObjectLiteralExpression,
  ): WorkflowToolPermissionDefinition | undefined {
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
  ): WorkflowNodeRegistryItem | undefined {
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
  ): Partial<WorkflowNodeRegistryItem["metadata"]> | undefined {
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
  ): Partial<WorkflowNodeRegistryItem["metadata"]> | undefined {
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
    value: WorkflowStructureValue | undefined,
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
  ): WorkflowParamDefinition["control"] | undefined {
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

  function readParamAudioProperty(obj: ts.ObjectLiteralExpression): WorkflowParamDefinition["audio"] {
    const property = findStaticPropertyAssignment(obj, "audio");
    if (!property) return undefined;
    const initializer = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) return undefined;
    const limits: NonNullable<WorkflowParamDefinition["audio"]> = {};
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
  ): WorkflowParamDefinition["panel"] | undefined {
    const value = readStringProperty(obj, propertyName);
    return value === "main" || value === "auxiliary" || value === "quick" || value === "mode" || value === "slash" ? value : undefined;
  }

  function readParamOptionsProperty(
    obj: ts.ObjectLiteralExpression,
    propertyName: string,
  ): WorkflowParamDefinition["options"] | undefined {
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

  function readConversationUserInputProperty(obj: ts.ObjectLiteralExpression): WorkflowConversationDefinition["userInput"] {
    const property = findStaticPropertyAssignment(obj, "userInput");
    if (!property) return undefined;
    try {
      const literal = (value: WorkflowStructureValue): unknown => {
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

  function readConversationFooterProperty(obj: ts.ObjectLiteralExpression): WorkflowConversationDefinition["footer"] {
    const property = findStaticPropertyAssignment(obj, "footer");
    if (!property) return undefined;
    try {
      const literal = (value: WorkflowStructureValue): unknown => {
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

  function readConversationCommandsProperty(obj: ts.ObjectLiteralExpression): WorkflowConversationDefinition["commands"] {
    const property = findStaticPropertyAssignment(obj, "commands");
    if (!property) return undefined;
    try {
      const literal = (value: WorkflowStructureValue): unknown => {
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
  ): WorkflowConversationDefinition["attachments"] | undefined {
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
  ): WorkflowConversationDefinition["inputQueue"] | undefined {
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
  ): WorkflowConversationDefinition["openai"] | undefined {
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

  function collectWorkflowRunInputNames(node: ts.Node): void {
    if (!ts.isMethodDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "run") {
      return;
    }

    const firstParameter = node.parameters[0];

    if (firstParameter !== undefined && ts.isIdentifier(firstParameter.name)) {
      workflowInputNames.add(firstParameter.name.text);
    }
  }

  function collectRunNodeCall(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isRunNodeCall(node)) {
      return;
    }

    ensureRunNodeTreeCall(node);
  }

  function collectRunWorkflowCall(node: ts.Node): void {
    if (!ts.isCallExpression(node) || !isRunWorkflowCall(node)) {
      return;
    }

    ensureRunWorkflowTreeCall(node);
  }

  function ensureRunNodeTreeCall(node: ts.CallExpression): WorkflowStructureCall {
    const existing = structureCallsByNode.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const nodeRef = describeNodeRef(node.arguments[0]);
    const input = describeInputRef(node.arguments[1]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const call: WorkflowStructureCall = {
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

  function ensureRunWorkflowTreeCall(node: ts.CallExpression): WorkflowStructureCall {
    const existing = structureWorkflowCallsByNode.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const workflowRef = describeWorkflowRef(node.arguments[0]);
    const input = describeInputRef(node.arguments[1]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const call: WorkflowStructureCall = {
      order,
      callee: "runWorkflow",
      nodeRef: workflowRef.id,
      standardName: "run-workflow",
      location: createLocation(cwd, filePath, sourceFile, node),
      arguments: node.arguments.map((argument, index) => ({
        position: index,
        source: argument.getText(sourceFile),
        value:
          index === 0
            ? {
                kind: "node",
                nodeId: workflowRef.id,
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
    structureWorkflowCallsByNode.set(node, call);
    analysis.structureEdges.push({
      order: analysis.structureEdges.length + 1,
      from: input,
      to: {
        kind: "node",
        nodeId: workflowRef.id,
        standardName: "run-workflow",
        callOrder: order,
      },
    });

    if (output.kind !== "expression") {
      analysis.structureEdges.push({
        order: analysis.structureEdges.length + 1,
        from: {
          kind: "node",
          nodeId: workflowRef.id,
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
        nodeId: workflowRef.id,
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

  function ensureRunIfTreeItem(node: ts.CallExpression): WorkflowStructureRunIfTreeItem {
    const existing = structureRunIfByNode.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const input = describeInputRef(node.arguments[0]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const runIfItem: WorkflowStructureRunIfTreeItem = {
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

  function ensureLoopTreeItem(node: ts.CallExpression): WorkflowStructureLoopTreeItem {
    const existing = structureLoopByNode.get(node);
    if (existing !== undefined) {
      existing.children = describeLoopRunChildren(node.arguments[2]);
      return existing;
    }

    const source = readWorkflowApiCallName(node.expression) === "runFor" ? "run-for" : "run-while";
    const input = describeInputRef(node.arguments[0]);
    const output = describeOutputRef(node);
    const order = analysis.structureCalls.length + 1;
    const optionsExpression = node.arguments[2];
    const loopItem: WorkflowStructureLoopTreeItem = {
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

  function collectWorkflowApiCall(node: ts.Node): void {
    if (!ts.isCallExpression(node)) {
      return;
    }

    const method = readKnownWorkflowApiCallName(node.expression);
    if (method === undefined) {
      return;
    }

    const call: WorkflowStructureApiCall = {
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

  function collectWorkflowRunTrees(node: ts.Node): void {
    if (isWorkflowRunMethod(node) && node.body !== undefined) {
      // Only workflow definitions own the top-level execution tree; runIf branch handlers
      // are parsed from their branch object so they do not drift into the diagram root.
      const workflowRef = readWorkflowDefinitionBindingName(findWorkflowDefinitionCall(node));
      analysis.structureTrees.push({
        kind: "workflow-run",
        workflowRef,
        workflowKey: workflowRef === undefined
          ? undefined
          : createWorkflowDefinitionKey(filePath, workflowRef),
        location: createLocation(cwd, filePath, sourceFile, node),
        children: describeStatements(node.body.statements),
      });
    }

    ts.forEachChild(node, collectWorkflowRunTrees);
  }

  function describeStatements(
    statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  ): WorkflowStructureTreeItem[] {
    return statements.flatMap((statement) => describeStatement(statement));
  }

  function describeStatement(statement: ts.Statement): WorkflowStructureTreeItem[] {
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

  function describeIfStatement(statement: ts.IfStatement): WorkflowStructureIfTreeItem {
    return {
      kind: "if",
      order: nextTreeItemOrder(),
      condition: statement.expression.getText(sourceFile),
      location: createLocation(cwd, filePath, sourceFile, statement),
      branches: describeIfBranches(statement),
    };
  }

  function describeIfBranches(statement: ts.IfStatement): WorkflowStructureIfBranch[] {
    const branches: WorkflowStructureIfBranch[] = [];
    let current: ts.IfStatement | undefined = statement;
    let branchKind: WorkflowStructureIfBranch["kind"] = "if";

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
  ): WorkflowStructureRunIfBranch[] {
    if (optionsExpression === undefined) {
      return [];
    }

    const options = unwrapExpression(optionsExpression);
    if (!ts.isObjectLiteralExpression(options)) {
      return [];
    }

    const branchesProperty = readObjectPropertyInitializer(options, "branches");
    const branches: WorkflowStructureRunIfBranch[] = [];

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
  ): WorkflowStructureTreeItem[] {
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
  ): WorkflowStructureTreeItem[] {
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
  ): WorkflowStructureTreeItem[] {
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

  function describeBranchChildren(statement: ts.Statement): WorkflowStructureTreeItem[] {
    if (ts.isBlock(statement)) {
      return describeStatements(statement.statements);
    }

    return describeStatement(statement);
  }

  function collectCallTreeItems(node: ts.Node): WorkflowStructureTreeItem[] {
    const items: WorkflowStructureTreeItem[] = [];

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

      if (ts.isCallExpression(current) && isRunWorkflowCall(current)) {
        items.push(createCallTreeItem(ensureRunWorkflowTreeCall(current)));
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

  function createCallTreeItem(call: WorkflowStructureCall): WorkflowStructureCallTreeItem {
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

  function readNodeOptions(node: ts.CallExpression): WorkflowStructureValue {
    const firstArgument = node.arguments[0];

    if (firstArgument === undefined) {
      return {
        kind: "object",
        value: {},
      };
    }

    return evaluateExpression(firstArgument);
  }

  function evaluateExpression(expression: ts.Expression): WorkflowStructureValue {
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
  ): Record<string, WorkflowStructureValue> {
    const value: Record<string, WorkflowStructureValue> = {};

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
  ): WorkflowStructureValue | undefined {
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

  function describeWorkflowRef(expression: ts.Expression | undefined): {
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
  ): WorkflowStructureReference {
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

      if (workflowInputNames.has(expression.text)) {
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

  function describeOutputRef(node: ts.CallExpression): WorkflowStructureReference {
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

function findWorkflowScriptPaths(workflowDir: string): string[] {
  if (!existsSync(workflowDir)) {
    return [];
  }

  return collectWorkflowScriptPaths(workflowDir).sort((left, right) => {
    return left.localeCompare(right);
  });
}

function collectWorkflowScriptPaths(directory: string): string[] {
  const entries = readdirSync(directory);
  const scriptPaths: string[] = [];

  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }

    const entryPath = path.join(directory, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      scriptPaths.push(...collectWorkflowScriptPaths(entryPath));
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
): WorkflowScriptRuleViolation[] {
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
): WorkflowScriptRuleViolation[] {
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
): WorkflowScriptRuleViolation[] {
  const nodeNamesByName = new Map<string, NodeNameOccurrence[]>();
  const violations: WorkflowScriptRuleViolation[] = [];

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

function findWorkflowOutputTypeViolations(
  outputTypes: WorkflowOutputTypeOccurrence[],
  options: {
    workflowName?: string;
  },
): WorkflowScriptRuleViolation[] {
  if (options.workflowName === undefined) {
    return [];
  }

  const expectedTypeName = createWorkflowOutputTypeName(options.workflowName);
  const matchedOutputTypes = outputTypes.filter((outputType) => {
    return outputType.name === expectedTypeName;
  });

  return matchedOutputTypes
    .filter((outputType) => !outputType.extendsWorkflowExecutorResult)
    .map((outputType) => ({
      type: "workflow_output_type_not_executor_result",
      name: outputType.name,
      message: `Workflow output type "${outputType.name}" must extend WorkflowExecutorResult.`,
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
  const name = readWorkflowApiCallName(expression);

  if (name === undefined) {
    return undefined;
  }

  return NODE_FACTORY_NAMES.has(name) ? name : undefined;
}

function isRunNodeCall(node: ts.CallExpression): boolean {
  const name = readWorkflowApiCallName(node.expression);

  return name === "runNode" || name === "runStreamNode";
}

function isRunWorkflowCall(node: ts.CallExpression): boolean {
  return readWorkflowApiCallName(node.expression) === "runWorkflow";
}

function isRunIfCall(node: ts.CallExpression): boolean {
  return readWorkflowApiCallName(node.expression) === "runIf";
}

function isRunLoopCall(node: ts.CallExpression): boolean {
  const name = readWorkflowApiCallName(node.expression);

  return name === "runFor" || name === "runWhile";
}

function readKnownWorkflowApiCallName(
  expression: ts.LeftHandSideExpression,
): string | undefined {
  const name = readWorkflowApiCallName(expression);

  if (name === undefined || !WORKFLOW_RUNTIME_API_NAMES.has(name)) {
    return undefined;
  }

  return name;
}

function isWorkflowRunMethod(node: ts.Node): node is ts.MethodDeclaration {
  if (
    !ts.isMethodDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    node.name.text !== "run"
  ) {
    return false;
  }

  return findWorkflowDefinitionCall(node) !== undefined;
}

function findWorkflowDefinitionCall(node: ts.MethodDeclaration): ts.CallExpression | undefined {
  const parent = node.parent;
  if (!ts.isObjectLiteralExpression(parent)) return undefined;

  let expression: ts.Expression = parent;
  while (isTransparentExpressionParent(expression.parent, expression)) {
    expression = expression.parent;
  }
  return isWorkflowDefineWorkflowCall(expression.parent) ? expression.parent : undefined;
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
  if (readWorkflowApiCallName(node.expression) === "runStreamNode") {
    return "runStreamNode";
  }

  return "runNode";
}

function isWorkflowDefineExecutorCall(node: ts.CallExpression): boolean {
  return readWorkflowApiCallName(node.expression) === "defineExecutor" ||
    readWorkflowApiCallName(node.expression) === "defineWorkflowExecutor";
}

function isWorkflowDefineWorkflowCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && readWorkflowApiCallName(node.expression) === "defineWorkflow";
}

function readWorkflowApiCallName(
  expression: ts.LeftHandSideExpression,
): string | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "workflow"
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

function readWorkflowDefinitionBindingName(node: ts.Node | undefined): string | undefined {
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

function describeApiCallOutputRef(node: ts.CallExpression): WorkflowStructureReference | undefined {
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

function interfaceExtendsWorkflowExecutorResult(
  node: ts.InterfaceDeclaration,
): boolean {
  return (
    node.heritageClauses?.some((clause) => {
      return (
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some((type) => {
          return isWorkflowExecutorResultExpression(type.expression);
        })
      );
    }) ?? false
  );
}

function isWorkflowExecutorResultTypeNode(typeNode: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(typeNode)) {
    return isWorkflowExecutorResultEntityName(typeNode.typeName);
  }

  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some(isWorkflowExecutorResultTypeNode);
  }

  return false;
}

function isWorkflowExecutorResultExpression(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "WorkflowExecutorResult";
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "WorkflowExecutorResult";
  }

  return false;
}

function isWorkflowExecutorResultEntityName(name: ts.EntityName): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === "WorkflowExecutorResult";
  }

  return name.right.text === "WorkflowExecutorResult";
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
): WorkflowScriptRuleLocation {
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

function createWorkflowOutputTypeName(workflowName: string): string {
  const words = workflowName
    .split(/[^a-zA-Z0-9]+/g)
    .map((word) => word.trim())
    .filter((word) => word !== "");
  const prefix =
    words.length === 0
      ? workflowName
      : words
          .map((word) => {
            return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
          })
          .join("");

  return `${prefix}Output`;
}
