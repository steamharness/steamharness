import type { ConversationExecutorDefinition, ExecutorContext, ParamResolveResult, ParamValues } from "../executor/types";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues } from "../executor/params";
import { HarnessError } from "../workflow/errors";
import { readAgentProjectContract } from "./project-params";
import { createAgentProjectParamResolver } from "./system-llm";

/** Bind only the selected project's contract; never infer from unrelated agents. */
export function inheritAgentProjectParams<Input, Output>(definition: ConversationExecutorDefinition<Input, Output>): void {
  const contract = readAgentProjectContract(definition.coreAgent ?? definition.workflow);
  if (!contract) {
    if (definition.coreAgent !== undefined) throw new HarnessError({ type: "input_validation", message: "coreAgent must reference a Core Agent conversation project." });
    return;
  }
  definition.params ??= structuredClone(contract.params);
  const fields = normalizeProjectParamDeclarations(definition.params).params;
  const names = new Set(fields.map(field => field.name));
  const customResolver = definition.resolveParams;
  const resolver = customResolver ?? createAgentProjectParamResolver({ modelSource: contract.modelSource });
  definition.resolveParams = async context => {
    const values = fixedValues(context.paramValues);
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
  function fixedValues(values: ParamValues): ParamValues {
    const defaults = parseProjectParamValues(definition.params, []);
    return { ...values, ...Object.fromEntries(fields.filter(field => field.fixedValue !== undefined).map(field => [field.name, defaults[field.name]])) };
  }
  function fixedContext(context: ExecutorContext): ExecutorContext {
    return { ...context, paramValues: fixedValues({ ...parseProjectParamValues(definition.params, context.args ?? []), ...context.paramValues }) };
  }
}
