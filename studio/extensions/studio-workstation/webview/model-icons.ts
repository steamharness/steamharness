/** Match the model identifier, not a user alias or the API compatibility protocol. */
const brands: ReadonlyArray<readonly [string, RegExp]> = [
  ['openai', /(?:^|[/:.])(?:gpt(?:-|$)|chatgpt(?:-|$)|o[134](?:-|$)|codex(?:-|$)|dall-e(?:-|$)|text-embedding(?:-|$))/i],
  ['claude', /(?:^|[/:.])claude(?:-|$)/i],
  ['gemini', /(?:^|[/:.])(?:gemini|gemma)(?:-|$)/i],
  ['deepseek', /(?:^|[/:.])deepseek(?:-|$)/i],
  ['qwen', /(?:^|[/:.])(?:qwen|qwq)(?:\d|-|$)/i],
  ['kimi', /(?:^|[/:.])(?:kimi|moonshot)(?:-|$)/i],
  ['minimax', /(?:^|[/:.])minimax(?:-|$)/i],
  ['doubao', /(?:^|[/:.])(?:doubao|seed)(?:-|$)/i],
  ['grok', /(?:^|[/:.])grok(?:-|$)/i],
  ['mistral', /(?:^|[/:.])(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)(?:-|$)/i],
  ['meta', /(?:^|[/:.])llama(?:\d|-|$)/i],
  ['zhipu', /(?:^|[/:.])(?:glm|chatglm)(?:\d|-|$)/i],
];

export function modelIcon(model: string, fallback: 'sparkle' | 'plug'): HTMLSpanElement {
  const brand = brands.find(([, pattern]) => pattern.test(model))?.[0];
  const result = document.createElement('span');
  result.className = brand ? `settings-model-brand settings-model-brand-${brand}` : `codicon codicon-${fallback}`;
  result.setAttribute('aria-hidden', 'true');
  return result;
}
