import type { ConversationExecutorDefinition, ConversationParamDeclaration, ExecutionDefinition, ExecutorContext, ParamResolveResult } from "../executor/types";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues } from "../executor/params";
import { HarnessError } from "../workflow/errors";
import { readAgentProjectContract, resolveAgentProjectParamValues } from "./project-params";
import { createAgentProjectParamResolver } from "./system-llm";

/** Resolve Agent aliases before constructing the shared executor context. */
export function parseExecutorParamValues(execution: ExecutionDefinition<unknown, unknown>, args: string[]) {
  const source = "coreAgent" in execution ? execution.coreAgent ?? execution.workflow : execution.workflow;
  const contract = "projectType" in execution && execution.projectType === "conversation" ? readAgentProjectContract(source) : undefined;
  return contract ? resolveAgentProjectParamValues((execution.params ?? contract.params) as ConversationParamDeclaration[], args)
    : parseProjectParamValues(execution.params, args);
}

/** Bind only the selected project's contract; never infer from unrelated agents. */
export function inheritAgentProjectParams<Input, Output>(definition: ConversationExecutorDefinition<Input, Output>): void {
  const contract = readAgentProjectContract(definition.coreAgent ?? definition.workflow);
  if (!contract) {
    if (definition.coreAgent !== undefined) throw new HarnessError({ type: "input_validation", message: "coreAgent must reference a Core Agent conversation project." });
    return;
  }
  // The durable database retains unfinished work after a process exits. Hosts
  // must reconnect using the original run identity before admitting new input.
  definition.conversation = { ...definition.conversation, recovery: { enabled: true } };
  const declarations = definition.params ??= structuredClone(contract.params);
  const fields = normalizeProjectParamDeclarations(declarations).params;
  const names = new Set(fields.map(field => field.name));
  const customResolver = definition.resolveParams;
  const resolver = customResolver ?? createAgentProjectParamResolver({ modelSource: contract.modelSource });
  definition.resolveParams = async context => {
    const values = resolveAgentProjectParamValues(declarations, context.args, context.paramValues);
    const result = await resolver({ ...context, paramValues: values });
    const params: NonNullable<ParamResolveResult["params"]> = Object.fromEntries(Object.entries(result.params ?? {}).filter(([name]) => customResolver || names.has(name)));
    for (const field of fields) {
      if (field.visible !== undefined || field.fixedValue !== undefined) params[field.name] = {
        ...params[field.name], ...(field.visible === undefined ? {} : { visible: field.visible }),
        ...(field.fixedValue !== undefined ? { value: values[field.name], disabled: true } : {}),
      };
    }
    return { params };
  };
  const createInput = definition.createInput;
  definition.createInput = context => createInput(fixedContext(context));
  if (definition.createContext) {
    const createContext = definition.createContext;
    definition.createContext = context => createContext(fixedContext(context));
  }
  function fixedContext(context: ExecutorContext): ExecutorContext {
    return { ...context, paramValues: resolveAgentProjectParamValues(declarations, context.args, context.paramValues) };
  }
}
