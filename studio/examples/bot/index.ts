import type { RuntimeApi } from 'steamharness/runtime-api';
declare const steamharness: RuntimeApi;

export const executor = steamharness.defineBot({
  name: 'studio-bot',
  agent: { systemPrompt: 'You are a helpful project assistant. Answer using the available context and tools.' },
});
export default executor;
