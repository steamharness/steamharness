import ts from "typescript";
import {
  STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE,
  assertNeverExecutorProjectKind,
  formatProjectKindMigrationMessage,
  isExecutorProjectKind,
  type ExecutorProjectType,
} from "./index";

export type ProjectTypeSourceViolationType =
  | "invalid_executor_project_type"
  | "legacy_conversation_enabled"
  | "project_type_configuration_conflict";

export interface ProjectTypeSourceViolation {
  type: ProjectTypeSourceViolationType;
  message: string;
  fileName: string;
}

export interface ProjectTypeSourceInspection {
  projectType?: ExecutorProjectType;
  violations: ProjectTypeSourceViolation[];
}

export class ProjectTypeMigrationError extends Error {
  constructor(violations: ProjectTypeSourceViolation[]) {
    super(`${violations.map((violation) => violation.message).join("\n")}\n\nMigration example:\n${STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE}`);
    this.name = "ProjectTypeMigrationError";
  }
}

export function inspectProjectTypeSources(
  sources: Array<{ fileName: string; sourceText: string }>,
): ProjectTypeSourceInspection {
  const violations: ProjectTypeSourceViolation[] = [];
  const projectTypes: ExecutorProjectType[] = [];
  let executorCount = 0;

  for (const source of sources) {
    const sourceFile = ts.createSourceFile(
      source.fileName,
      source.sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFileName(source.fileName),
    );

    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isDefineExecutorCall(node)) return;
      executorCount += 1;

      const objectArgument = node.arguments[0];
      if (!objectArgument || !ts.isObjectLiteralExpression(objectArgument)) {
        violations.push(createViolation(
          "invalid_executor_project_type",
          formatProjectKindMigrationMessage("project.defineExecutor must receive a static object with projectType"),
          source.fileName,
        ));
        return;
      }

      const projectTypeProperty = findProperty(objectArgument, "projectType");
      const conversationProperty = findProperty(objectArgument, "conversation");
      if (!projectTypeProperty || !ts.isStringLiteralLike(projectTypeProperty.initializer)) {
        violations.push(createViolation(
          "invalid_executor_project_type",
          formatProjectKindMigrationMessage("Executor projectType is missing or must be a string literal"),
          source.fileName,
        ));
        return;
      }

      const projectType = projectTypeProperty.initializer.text;
      if (!isExecutorProjectKind(projectType)) {
        violations.push(createViolation(
          "invalid_executor_project_type",
          formatProjectKindMigrationMessage(`Unknown executor projectType "${projectType}"`),
          source.fileName,
        ));
        return;
      }
      projectTypes.push(projectType);

      if (!conversationProperty) return;
      if (!ts.isObjectLiteralExpression(conversationProperty.initializer)) {
        violations.push(createViolation(
          "project_type_configuration_conflict",
          "Executor conversation settings must be a static object literal.",
          source.fileName,
        ));
        return;
      }

      if (findProperty(conversationProperty.initializer, "enabled")) {
        violations.push(createViolation(
          "legacy_conversation_enabled",
          'conversation.enabled was removed. Declare projectType: "conversation" and remove the outer enabled field.',
          source.fileName,
        ));
      }

      if (findProperty(conversationProperty.initializer, "defaultInput")) {
        violations.push(createViolation(
          "project_type_configuration_conflict",
          "conversation.defaultInput was removed. Conversation always uses the standard message input; declare attachment capabilities in conversation.attachments.",
          source.fileName,
        ));
      }

      switch (projectType) {
        case "conversation":
          break;
        case "workflow":
          violations.push(createViolation(
            "project_type_configuration_conflict",
            'projectType: "workflow" cannot declare conversation settings.',
            source.fileName,
          ));
          break;
        default:
          assertNeverExecutorProjectKind(projectType);
      }
    });
  }

  if (executorCount === 0) {
    violations.push(createViolation(
      "invalid_executor_project_type",
      formatProjectKindMigrationMessage("Workflow must define an executor with projectType"),
      sources[0]?.fileName ?? "index.ts",
    ));
  }

  const distinctProjectTypes = [...new Set(projectTypes)];
  if (distinctProjectTypes.length > 1) {
    violations.push(createViolation(
      "project_type_configuration_conflict",
      `Workflow sources declare conflicting executor project types: ${distinctProjectTypes.join(", ")}.`,
      sources[0]?.fileName ?? "index.ts",
    ));
  }

  return {
    projectType: distinctProjectTypes.length === 1 ? distinctProjectTypes[0] : undefined,
    violations,
  };
}

export function readProjectTypeFromSources(
  sources: Array<{ fileName: string; sourceText: string }>,
): ExecutorProjectType {
  const inspection = inspectProjectTypeSources(sources);
  if (inspection.violations.length > 0 || inspection.projectType === undefined) {
    throw new ProjectTypeMigrationError(inspection.violations);
  }
  return inspection.projectType;
}

function createViolation(
  type: ProjectTypeSourceViolationType,
  message: string,
  fileName: string,
): ProjectTypeSourceViolation {
  return { type, message, fileName };
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function isDefineExecutorCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "defineProjectExecutor";
  }
  return ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "workflow" &&
    (node.expression.name.text === "defineExecutor" ||
      node.expression.name.text === "defineProjectExecutor");
}

function findProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
    property.name.text === name
  );
}

function scriptKindForFileName(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
