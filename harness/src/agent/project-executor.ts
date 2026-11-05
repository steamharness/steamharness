import type { BotExecutorDefinition, BotParamDeclaration, ExecutionDefinition, ExecutorContext, ParamResolveResult } from "../executor/types";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues } from "../executor/params";
import { HarnessError } from "../workflow/errors";
import { readAgentProjectContract, resolveAgentProjectParamValues } from "./project-params";
import { createAgentProjectParamResolver } from "./system-llm";

/** Resolve Agent aliases before constructing the shared executor context. */
export function parseExecutorParamValues(execution: ExecutionDefinition<unknown, unknown>, args: string[]) {
  const source = execution.workflow;
  const contract = "projectType" in execution && execution.projectType === "bot" ? readAgentProjectContract(source) : undefined;
  return contract ? resolveAgentProjectParamValues((execution.params ?? contract.params) as BotParamDeclaration[], args)
    : parseProjectParamValues(execution.params, args);
}

/** Bind only the selected project's contract; never infer from unrelated agents. */
export function inheritAgentProjectParams<Input>(definition: BotExecutorDefinition<Input>): void {
  const contract = readAgentProjectContract(definition.workflow);
  if (!contract) throw new HarnessError({ type: "input_validation", message: "Bot requires the Core Agent contract." });
  // The durable database retains unfinished work after a process exits. Hosts
  // must reconnect using the original run identity before admitting new input.
  definition.conversation = { ...definition.conversation, recovery: { ...definition.conversation?.recovery, enabled: true }, ...(contract.durable ? { durable: { enabled: true } } : {}) };
  const declarations = definition.params ??= structuredClone(contract.params);
  const fields = normalizeProjectParamDeclarations(declarations).params;
  const names = new Set(fields.map(field => field.name));
  const customResolver = definition.resolveParams;
  const resolver = createAgentProjectParamResolver({ modelSource: contract.modelSource });
  definition.resolveParams = async context => {
    const values = resolveAgentProjectParamValues(declarations, context.args, context.paramValues);
    const base = await resolver({ ...context, paramValues: values });
    const extra = await customResolver?.({ ...context, paramValues: values });
    const result = { params: { ...base.params, ...extra?.params } };
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
