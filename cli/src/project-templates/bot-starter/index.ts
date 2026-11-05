import type { RuntimeApi } from 'steamharness/runtime-api';
declare const steamharness: RuntimeApi;

export const executor = steamharness.defineBot({
  name: '__PROJECT_TITLE__',
  agent: { systemPrompt: 'You are a helpful assistant. Use your tools when appropriate and report actual results.' },
});
export default executor;
