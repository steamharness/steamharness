import type { RuntimeApi } from 'steamharness/runtime-api';

const steamharness = (globalThis as unknown as { steamharness: RuntimeApi }).steamharness;
const answer = steamharness.createOutputNode({
  name: 'hello', async *stream() { yield 'Hello'; },
  format: stream => steamharness.createOutputPayload({ items: stream.items }),
});
const helloProject = steamharness.defineProject({
  name: 'hello',
  async run(input, context) {
    return (await steamharness.runStreamNode(answer, input, context)).output;
  },
});
export const executor = steamharness.defineExecutor({
  projectType: 'workflow', defaultEntrypoint: 'main',
  entrypoints: [steamharness.defineEntrypoint({ id: 'main', title: 'Hello', workflow: helloProject, createInput: () => ({ errCode: 0, errMessage: '' }) })],
});
