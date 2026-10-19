import type { RuntimeApi } from 'steamharness/runtime-api';

const steamharness = (globalThis as unknown as { steamharness: RuntimeApi }).steamharness;
const main = steamharness.defineProject({
  name: 'main',
  async run() {
    return steamharness.createOutputPayload({ items: [{ id: 'output', title: 'Output', contentType: 'text', content: 'Ready' }] });
  },
});
export const executor = steamharness.defineExecutor({
  projectType: 'workflow', defaultEntrypoint: 'main',
  entrypoints: [steamharness.defineEntrypoint({ id: 'main', title: 'Main', workflow: main, createInput: () => ({ errCode: 0, errMessage: '' }) })],
});
