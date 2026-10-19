import { HarnessError } from "../workflow/index";
import type {
  EntrypointDefinition,
  EntrypointGroupDefinition,
  ExecutorDefinition,
} from "./types";
import { assertProjectParamDeclarations, normalizeProjectParamDeclarations } from "./param-definition";
import { assertConversationFooter } from "./conversation-footer";
import { assertConversationCommands } from "./conversation-commands";
import { assertConversationUserInput } from "./conversation-input";

export const STEAMHARNESS_ENTRYPOINT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function defineProjectEntrypoint<Input, Output>(
  definition: EntrypointDefinition<Input, Output>,
): EntrypointDefinition<Input, Output> {
  assertProjectEntrypointDefinition(definition);
  return definition;
}

export function defineProjectExecutor<Input = unknown, Output = unknown>(
  definition: ExecutorDefinition<Input, Output>,
): ExecutorDefinition<Input, Output> {
  if (definition.projectType === "workflow") {
    if (!Array.isArray(definition.entrypoints) || definition.entrypoints.length === 0) {
      throw new HarnessError({
        type: "input_validation",
        message: "Workflow executor entrypoints must contain at least one entrypoint.",
      });
    }
    const ids = new Set<string>();
    const groups = new Map<string, EntrypointGroupDefinition>();
    for (const entrypoint of definition.entrypoints) {
      assertProjectEntrypointDefinition(entrypoint);
      if (ids.has(entrypoint.id)) {
        throw new HarnessError({
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
          throw new HarnessError({
            type: "input_validation",
            message: `Workflow entrypoint group "${entrypoint.group.id}" must use identical title and order in every entrypoint.`,
          });
        }
        groups.set(entrypoint.group.id, entrypoint.group);
      }
    }
    if (typeof definition.defaultEntrypoint !== "string" || !ids.has(definition.defaultEntrypoint)) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow executor defaultEntrypoint "${String(definition.defaultEntrypoint)}" does not match a declared entrypoint.`,
      });
    }
  } else {
    if (definition.conversation && "defaultInput" in definition.conversation) {
      throw new HarnessError({
        type: "input_validation",
        message: "conversation.defaultInput was removed. Conversation always uses the standard message input; declare attachment capabilities in conversation.attachments.",
      });
    }
    assertProjectParamDeclarations(definition.params, "conversation");
    assertConversationFooter(definition.conversation?.footer, normalizeProjectParamDeclarations(definition.params).params);
    assertConversationCommands(definition.conversation?.commands, normalizeProjectParamDeclarations(definition.params).params);
    assertConversationUserInput(definition.conversation?.userInput, normalizeProjectParamDeclarations(definition.params).params);
  }
  return definition;
}

function assertProjectEntrypointDefinition(
  definition: EntrypointDefinition<any, any>,
): void {
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof definition.id !== "string" ||
    !STEAMHARNESS_ENTRYPOINT_ID_PATTERN.test(definition.id)
  ) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint id "${String(definition?.id)}" must match ${STEAMHARNESS_ENTRYPOINT_ID_PATTERN}.`,
    });
  }
  if (typeof definition.title !== "string" || definition.title.trim() === "") {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint "${definition.id}" must declare a non-empty title.`,
    });
  }
  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint "${definition.id}" description must be a string when provided.`,
    });
  }
  assertProjectEntrypointGroupDefinition(definition.id, definition.group);
  assertProjectParamDeclarations(definition.params, "workflow");
}

function assertProjectEntrypointGroupDefinition(
  entrypointId: string,
  group: EntrypointGroupDefinition | undefined,
): void {
  if (group === undefined) return;
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group must be an object when provided.`,
    });
  }
  if (typeof group.id !== "string" || group.id.trim() === "") {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group must declare a non-empty id.`,
    });
  }
  if (typeof group.title !== "string" || group.title.trim() === "") {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group must declare a non-empty title.`,
    });
  }
  if (
    Object.hasOwn(group, "order") &&
    (typeof group.order !== "number" || !Number.isInteger(group.order) || group.order < 0)
  ) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow entrypoint "${entrypointId}" group order must be a non-negative integer when provided.`,
    });
  }
}
