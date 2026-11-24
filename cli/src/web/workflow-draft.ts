import { BOT_JSON_SUMMARY_TOOL, parseJsonSummaryDraftStep, type JsonSummaryDraftStep } from '../project-templates/workflow-draft/json-summary';
import type { ConversationMessage, ConversationSession } from './workflow-types';

export interface WorkflowDraftPreview { steps: JsonSummaryDraftStep[]; excluded: { tool: string; count: number }[] }

/** Only committed successful answers and Core's dedicated tool result can become a draft. */
export function previewRunDraft(session: ConversationSession | undefined, message: ConversationMessage | undefined): WorkflowDraftPreview | undefined {
  if (!session || session.origin || !message || message.role !== 'assistant' || message.status !== 'success' || message.error || message.recovering) return;
  const steps = new Map<string, JsonSummaryDraftStep>();
  const excluded = new Map<string, number>();
  for (const item of message.items ?? []) {
    const type = item.metadata?.partType;
    const value = item.content as { tool?: unknown; status?: unknown; output?: { details?: { workflowDraftOperation?: unknown } } } | undefined;
    if (item.metadata?.kind === 'agent-part' && type === 'tool' && value?.tool === BOT_JSON_SUMMARY_TOOL && value.status === 'success') {
      try {
        const step = parseJsonSummaryDraftStep(value.output?.details?.workflowDraftOperation);
        if (steps.size < 24) { steps.set(step.id, step); continue; }
      } catch { /* A legacy or incomplete result is not evidence. */ }
    }
    const tool = type === 'tool' && typeof value?.tool === 'string' && /^[\w.-]{1,80}$/u.test(value.tool) ? value.tool
      : item.metadata?.kind === 'agent-answer' || type === 'text' ? 'model-response' : 'other-output';
    if (excluded.size < 30 || excluded.has(tool)) excluded.set(tool, (excluded.get(tool) ?? 0) + 1);
    else excluded.set('other-output', (excluded.get('other-output') ?? 0) + 1);
  }
  return { steps: [...steps.values()], excluded: [...excluded].map(([tool, count]) => ({ tool, count })) };
}
