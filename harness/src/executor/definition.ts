import { WorkflowError } from "../workflow/index";
import type {
  WorkflowEntrypointDefinition,
  WorkflowEntrypointGroupDefinition,
  WorkflowExecutorDefinition,
} from "./types";
import { assertWorkflowParamDeclarations, normalizeWorkflowParamDeclarations } from "./param-definition";
import { assertConversationFooter } from "./conversation-footer";
import { assertConversationCommands } from "./conversation-commands";
import { assertConversationUserInput } from "./conversation-input";

export const STEAMHARNESS_ENTRYPOINT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function defineWorkflowEntrypoint<Input, Output>(
  definition: WorkflowEntrypointDefinition<Input, Output>,
): WorkflowEntrypointDefinition<Input, Output> {
  assertWorkflowEntrypointDefinition(definition);
  return definition;
}

export function defineWorkflowExecutor<Input = unknown, Output = unknown>(
  definition: WorkflowExecutorDefinition<Input, Output>,
): WorkflowExecutorDefinition<Input, Output> {
  if (definition.projectType === "workflow") {
    if (!Array.isArray(definition.entrypoints) || definition.entrypoints.length === 0) {
      throw new WorkflowError({
        type: "input_validation",
        message: "Workflow executor entrypoints must contain at least one entrypoint.",
      });
    }
    const ids = new Set<string>();
    const groups = new Map<string, WorkflowEntrypointGroupDefinition>();
    for (const entrypoint of definition.entrypoints) {
      assertWorkflowEntrypointDefinition(entrypoint);
      if (ids.has(entrypoint.id)) {
        throw new WorkflowError({
          type: "input_validation",
          message: `Workflow executor declares duplicate entrypoint id "${entrypoint.id}".`,
        });
      }
      ids.add(entrypoint.id);
      if (entrypoint.group !== undefined) {
        const existing = groups.get(entrypoint.group.id);
        if (
          existing !== undefined &&
          (
            existing.title !== entrypoint.group.title ||
            existing.order !== entrypoint.group.order
          )
        ) {
          throw new WorkflowError({
            type: "input_validation",
            message: `Workflow entrypoint group "${entrypoint.group.id}" must use identical title and order in every entrypoint.`,
          });
        }
        groups.set(entrypoint.group.id, entrypoint.group);
      }
    }
    if (typeof definition.defaultEntrypoint !== "string" || !ids.has(definition.defaultEntrypoint)) {
      throw new WorkflowError({
        type: "input_validation",
        message: `Workflow executor defaultEntrypoint "${String(definition.defaultEntrypoint)}" does not match a declared entrypoint.`,
      });
    }
  } else {
    if (definition.conversation && "defaultInput" in definition.conversation) {
      throw new WorkflowError({
        type: "input_validation",
        message: "conversation.defaultInput was removed. Conversation always uses the standard message input; declare attachment capabilities in conversation.attachments.",
      });
    }
    assertWorkflowParamDeclarations(definition.params, "conversation");
    assertConversationFooter(definition.conversation?.footer, normalizeWorkflowParamDeclarations(definition.params).params);
    assertConversationCommands(definition.conversation?.commands, normalizeWorkflowParamDeclarations(definition.params).params);
    assertConversationUserInput(definition.conversation?.userInput, normalizeWorkflowParamDeclarations(definition.params).params);
  }
  return definition;
}

function assertWorkflowEntrypointDefinition(
  definition: WorkflowEntrypointDefinition<any, any>,
): void {
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof definition.id !== "string" ||
    !STEAMHARNESS_ENTRYPOINT_ID_PATTERN.test(definition.id)
  ) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint id "${String(definition?.id)}" must match ${STEAMHARNESS_ENTRYPOINT_ID_PATTERN}.`,
    });
  }
  if (typeof definition.title !== "string" || definition.title.trim() === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint "${definition.id}" must declare a non-empty title.`,
    });
  }
  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint "${definition.id}" description must be a string when provided.`,
    });
  }
  assertWorkflowEntrypointGroupDefinition(definition.id, definition.group);
  assertWorkflowParamDeclarations(definition.params, "workflow");
}

function assertWorkflowEntrypointGroupDefinition(
  entrypointId: string,
  group: WorkflowEntrypointGroupDefinition | undefined,
): void {
  if (group === undefined) return;
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group must be an object when provided.`,
    });
  }
  if (typeof group.id !== "string" || group.id.trim() === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group must declare a non-empty id.`,
    });
  }
  if (typeof group.title !== "string" || group.title.trim() === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group must declare a non-empty title.`,
    });
  }
  if (
    Object.hasOwn(group, "order") &&
    (typeof group.order !== "number" || !Number.isInteger(group.order) || group.order < 0)
  ) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group order must be a non-negative integer when provided.`,
    });
  }
}
