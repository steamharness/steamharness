import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { BotFileWorkspace } from '../runtime-storage/bot-files';
import { BOT_JSON_SUMMARY_TOOL, JSON_SUMMARY_KIND, JSON_SUMMARY_MAX_BYTES, parseJsonSummaryOptions, summarizeJsonRows } from '../workflow/json-summary';
import { currentBotToolCallId } from './bot-lifecycle';

export const BOT_JSON_SUMMARY_DEFINITION = { name: BOT_JSON_SUMMARY_TOOL, label: 'Summarize JSON rows', enabled: true, autoApprove: true, approvalMode: 'always' as const };
export const BOT_JSON_SUMMARY_GUIDANCE = 'For deterministic row counts or grouping of a JSON array of objects, use bot_json_summary on the selected input in your Bot file workspace. Deliver the resulting file separately if the user asks. This operation can be saved as a Workflow; unrelated model or shell steps are not replayable.';

export function createBotJsonSummaryTool(workspace: BotFileWorkspace): AgentTool {
  return {
    name: BOT_JSON_SUMMARY_TOOL, label: BOT_JSON_SUMMARY_DEFINITION.label,
    description: 'Count rows in a JSON array of objects, optionally grouping by a top-level scalar field. Reads a JSON file already in this Bot workspace and writes a JSON report to its dated artifact folder.',
    parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 }, groupBy: { type: 'string', maxLength: 80 } }, required: ['path'], additionalProperties: false },
    replay: 'never',
    async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
      const failure = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {}, isError: true });
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'path' && key !== 'groupBy')) return failure('Invalid JSON summary input.');
      const { path, groupBy } = input as Record<string, unknown>;
      if (typeof path !== 'string' || !/\.json$/iu.test(path)) return failure('Select a .json file inside your Bot file workspace.');
      try {
        const options = parseJsonSummaryOptions({ groupBy });
        const input = await workspace.readSnapshot(path, JSON_SUMMARY_MAX_BYTES, signal);
        const summary = summarizeJsonRows(input, options.groupBy);
        const target = await workspace.list(undefined, 0, 1);
        const receiptId = createHash('sha256').update(currentBotToolCallId() ?? toolCallId).update(input).update(JSON.stringify(options)).digest('hex').slice(0, 24);
        const report = `${target.artifacts}/summary-${receiptId}.json`;
        signal?.throwIfAborted();
        await workspace.write(report, JSON.stringify(summary, null, 2) + '\n', true);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ report, rowCount: summary.rowCount }) }],
          details: { workflowDraftOperation: { kind: JSON_SUMMARY_KIND, id: receiptId, ...options } } };
      } catch (error) {
        signal?.throwIfAborted();
        // Never return failing filesystem paths or unparsed source contents to the model.
        return failure(error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error instanceof Error && !('code' in error) ? error.message : 'The JSON summary could not be created.');
      }
    },
  } as unknown as AgentTool;
}
