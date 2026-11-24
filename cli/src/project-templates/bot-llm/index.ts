import type { RuntimeApi } from 'steamharness/runtime-api';
declare const steamharness: RuntimeApi;

export const executor = steamharness.defineBot({
  engine: "llm",
  llm: { systemPrompt: 'You are a helpful assistant.' },
});
export default executor;
