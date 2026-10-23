import { conversationModelName, type ConversationMessage, type ConversationSession, type Report } from './workflow-types';

type Event = Record<string, unknown>;
interface EventSummary { count: number; events: Event[]; starts: Map<string, number>; ends: Map<string, number> }

/** The live page needs output and trace timings, not every historical output delta. */
export class ConversationState {
  private readonly summaries = new WeakMap<Event[], EventSummary>();
  private readonly agents = new WeakMap<NonNullable<ConversationSession['agent']>, NonNullable<ConversationSession['agent']>>();
  private readonly reports = new WeakMap<Report, { report: Report; nodes: Map<unknown, Record<string, unknown>> }>();

  sessions(sessions: ConversationSession[]): ConversationSession[] {
    return sessions.map(session => {
      let input: ConversationMessage['input'];
      const messages = session.messages.map(message => {
        const view = this.message(message);
        if (message.role === 'user') input = message.input;
        // Histories can also arrive through cross-window refresh. Recover old
        // selection IDs from that turn's saved options, without changing storage.
        else if (input && (!message.model || message.model === input.params.model)) {
          view.model = conversationModelName(input) ?? message.model;
        }
        return view;
      });
      return { ...session, agent: this.agent(session.agent), messages };
    });
  }

  private agent(agent: ConversationSession['agent']): ConversationSession['agent'] {
    if (!agent) return;
    let result = this.agents.get(agent);
    if (!result) {
      // Turn output is already projected into messages. Scheduling and Trace use
      // turn identities/status, while raw turn output remains available in exports.
      result = { ...agent, turns: agent.turns.map(turn => ({ ...turn, items: [] })) };
      this.agents.set(agent, result);
    }
    return result;
  }

  private message(message: ConversationMessage): ConversationMessage {
    const summary = message.events && this.events(message.events);
    let report = message.report, events = summary;
    if (report) {
      let cached = this.reports.get(report);
      if (!cached) {
        const { status, durationMs, nodes, logs, output, resolvedUserInputs } = report;
        cached = { report: { status, durationMs, nodes, logs, output, resolvedUserInputs },
          nodes: new Map(nodes?.filter(node => node.executionId !== undefined).map(node => [node.executionId, node])) };
        this.reports.set(report, cached);
      }
      report = { ...cached.report, output: message.items ? undefined : cached.report.output,
        resolvedUserInputs: message.resolvedInputs ? undefined : cached.report.resolvedUserInputs };
      // Final node details are in report.nodes; do not transfer a second copy.
      if (cached.nodes.size && summary) events = summary.map(event => {
        const node = cached.nodes.get(event.executionId);
        if (!['node_started', 'node_finished'].includes(String(event.type)) || !node) return event;
        return { ...event, ...(node.input !== undefined ? { input: undefined } : {}), ...(node.output !== undefined ? { output: undefined } : {}) };
      });
    }
    return { ...message, events, report };
  }

  private events(source: Event[]): Event[] {
    let summary = this.summaries.get(source);
    if (!summary || source.length < summary.count) {
      summary = { count: 0, events: [], starts: new Map(), ends: new Map() };
      this.summaries.set(source, summary);
    }
    for (; summary.count < source.length; ++summary.count) {
      const event = source[summary.count];
      if (event.type === 'token_usage_updated') continue; // Latest usage has its own field.
      if (event.type !== 'node_chunk') { summary.events.push(event); continue; }
      const chunk = event.chunk as { type?: string; item?: { id?: string }; itemId?: string } | undefined;
      if (chunk?.type !== 'output_item_start' && chunk?.type !== 'output_item_end') continue;
      const itemId = chunk.item?.id ?? chunk.itemId;
      if (!itemId) continue;
      const timing = { type: event.type, timestamp: event.timestamp, chunk: { type: chunk.type, itemId } };
      const positions = chunk.type === 'output_item_start' ? summary.starts : summary.ends;
      const index = positions.get(itemId);
      if (index === undefined) { positions.set(itemId, summary.events.length); summary.events.push(timing); }
      else if (chunk.type === 'output_item_end' || !validTime(summary.events[index].timestamp)) summary.events[index] = timing;
    }
    return summary.events;
  }
}

function validTime(value: unknown): boolean {
  return Number.isFinite(typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
}
