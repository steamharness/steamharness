import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import * as ai from '@earendil-works/pi-ai';
import { Agent } from '@earendil-works/pi-agent-core';

const task = steamharness.defineProject({
  name: 'assistant-workspace-proof',
  async run(input, context) {
    const workdir = process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR;
    const workspace = JSON.parse(await readFile(process.env.STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST, 'utf8'));
    const faux = ai.fauxProvider({ models: [{ id: 'offline', name: 'Offline', contextWindow: 4096, maxTokens: 100 }] });
    const models = ai.createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      () => ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: process.platform === 'win32' ? 'cd' : 'pwd' })]),
      () => ai.fauxAssistantMessage([ai.fauxToolCall('read', { path: 'scope.txt' })]),
      () => ai.fauxAssistantMessage([ai.fauxText('done')]),
    ]);
    const agent = await steamharness.createAgent({ workdir, pi: {
      Agent, Type: ai.Type, models, model: models.getModel('faux', 'offline'), streamFn: models.streamSimple.bind(models),
      providerId: 'faux', modelId: 'offline', supportedThinkingLevels: ['off'], clampThinkingLevel: () => 'off',
    } });
    const calls = [];
    for await (const event of agent.run({ errCode: 0, errMessage: '', prompt: 'Inspect the folder', workdir, permissionPolicy: 'auto' })) {
      if (event.type === 'tool' && event.phase === 'end') { calls.push(event); }
    }
    if (calls.length !== 2 || calls.some(call => call.isError)) { throw new Error(JSON.stringify(calls)); }
    const text = call => call.result.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    const cwd = text(calls[0]), file = text(calls[1]);
    await writeFile(path.join(workdir, 'tool-proof.json'), JSON.stringify({ workdir, cwd, file, workspace }));
    if (input.message === 'slow') {
      for (let count = 0; count < 200; count++) { context.abortSignal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    return steamharness.createOutputPayload({ items: [{ id: 'answer', contentType: 'markdown',
      content: `Folder: ${workdir}\n\n\`\`\`text\n${cwd}\n\`\`\`\n\nFile: ${file}\n\nInput: ${input.message}`,
    }] });
  },
});

export const executor = steamharness.defineExecutor({
  projectType: 'conversation', workflow: task,
  tools: [{ name: 'bash', enabled: true, autoApprove: true }, { name: 'read', enabled: true, autoApprove: true }],
  createInput(context) { return steamharness.parseConversationDefaultInputArgs(context.args); },
});
