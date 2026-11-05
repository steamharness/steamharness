import type { RuntimeApi } from 'steamharness/runtime-api';
declare const steamharness: RuntimeApi;

export const executor = steamharness.defineBot({
  name: '__PROJECT_TITLE__',
  agent: {
    tools: [],
    systemPrompt: 'Answer questions and use current_time when the user needs the current time.',
    createTools() {
      return [{ name: 'current_time', label: 'Current time', description: 'Read the current UTC time.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() { return { content: [{ type: 'text' as const, text: new Date().toISOString() }], details: {} }; } }];
    },
  },
  tools: [{ name: 'current_time', label: 'Current time', enabled: true, autoApprove: true }],
});
export default executor;
