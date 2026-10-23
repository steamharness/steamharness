import type { ConversationMessage, Project } from '../workflow-types';

/** Agent output also supplies the default for projects that compose their own executor. */
export function collapseIntermediateDefault(project: Project, messages: ConversationMessage[]): boolean {
  return project.conversation?.collapseIntermediate ?? messages.some(message => message.role === 'assistant'
    && message.items?.some(item => ['agent-part', 'agent-answer', 'agent-session'].includes(String(item.metadata?.kind))));
}
