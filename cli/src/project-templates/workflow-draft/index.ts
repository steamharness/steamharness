import type { RunOutputPayload } from 'steamharness';
import type { RuntimeApi } from 'steamharness/runtime-api';
import options from './draft-options.json';
import { JSON_SUMMARY_MAX_BYTES, parseJsonSummaryOptions, summarizeJsonRows } from './json-summary';

const steamharness = (globalThis as unknown as { steamharness: RuntimeApi }).steamharness;
interface Input { errCode: 0; errMessage: ''; source: unknown }
const inputFile = steamharness.createFileInputNode({ name: 'read-json', multiple: false, accept: ['.json', 'application/json'] });
const output = steamharness.createOutputNode<{ bytes: Uint8Array }, RunOutputPayload>({
  name: 'write-json-summary',
  async format({ bytes }, context) {
    const { groupBy, outputName } = parseJsonSummaryOptions(options);
    const summary = summarizeJsonRows(bytes, groupBy);
    if (!context.files?.createFile) throw new Error('The Workflow file output store is unavailable.');
    const file = await context.files.createFile({ name: outputName, mimeType: 'application/json', buffer: JSON.stringify(summary, null, 2) + '\n' });
    return steamharness.createOutputPayload({ items: [{ id: 'summary', title: outputName, contentType: 'markdown', content: `[${outputName}](${file.url ?? file.id})` }] });
  },
});
const summaryProject = steamharness.defineProject<Input, RunOutputPayload>({
  name: 'json-summary',
  async run(input, context) {
    const [file] = await steamharness.runNode(inputFile, input.source, context);
    if (!file || file.size > JSON_SUMMARY_MAX_BYTES) throw new Error('Select one JSON file of up to 2 MiB.');
    const bytes = await file.readBuffer();
    return steamharness.runNode(output, { bytes }, context);
  },
});
export const executor = steamharness.defineExecutor({ projectType: 'workflow', defaultEntrypoint: 'main', entrypoints: [
  steamharness.defineEntrypoint({ id: 'main', title: 'JSON summary', workflow: summaryProject,
    params: [{ name: 'source', flag: '--source', type: 'file', label: 'JSON input', required: true, multiple: false, accept: ['.json', 'application/json'] }],
    createInput: ({ paramValues }): Input => ({ errCode: 0, errMessage: '', source: paramValues.source }),
  }),
] });
