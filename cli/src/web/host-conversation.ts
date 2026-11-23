import type { EntryConversations } from './entry-conversations';
import type { ConversationController } from './conversation-controller';
import { sessionRunning, type ConversationSession, type Project, type Runtime } from './workflow-types';

const uuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s);

/** Operations on a particular background turn. Only the local host's stdio channel calls this. */
export async function hostConversation(
  controller: ConversationController,
  entries: EntryConversations,
  runtime: Runtime,
  project: Project,
  input: Record<string, unknown>,
  isolate = false,
) {
  const { conversationId, requestId, action } = input;
  if (!uuid(conversationId) || !uuid(requestId)) throw new Error('Invalid background turn.');
  let session = controller.sessions.find((row) => row.id === conversationId);
  if (isolate && session && session.origin !== 'host') throw new Error('This conversation is not owned by the background host.');
  const opening = action === 'ensure' || action === 'submit';
  if (!session && opening) {
    await controller.navigate(
      conversationId,
      [{ id: conversationId, create: true, draft: { text: '', attachments: [] } }],
      false,
      'host',
    );
    session = controller.sessions.find((row) => row.id === conversationId);
    if (typeof input.title === 'string') await controller.rename(conversationId, input.title);
  } else if (session && opening && !session.origin) {
    // Older hosts did not mark their sessions. Match the stdio host's stable ID
    // and require a submission receipt if the conversation already has turns.
    const hasReceipt = session.messages.some(message => message.role === 'user' && message.input?.entrySubmission) ||
      session.queuedInputs?.some(input => input.entrySubmission);
    if (session.agentOwnerId || session.forkSource || !hasReceipt && (session.messages.length || session.queuedInputs?.length)) {
      throw new Error('This conversation is not owned by the background host.');
    }
    session.origin = 'host';
    await controller.persist();
  }
  if (!session) return { status: 'missing' };
  const hosted = session.origin === 'host';
  const answer = session.messages.find(
    (m) => m.role === 'assistant' && (m.sessionRequestId ?? m.id) === requestId,
  );
  const queued = session.queuedInputs?.some((q) => (q.requestId ?? q.id) === requestId);
  const unfinished = (message: ConversationSession['messages'][number]) => message.role === 'assistant' &&
    (message.status === 'running' || message.recovering || message.pendingInput || message.cancelRequested);
  if (isolate && ['submit', 'recover', 'resolve', 'stop'].includes(String(action)) && (
    session.messages.some(message => message !== answer && unfinished(message)) ||
    session.queuedInputs?.some(input => (input.requestId ?? input.id) !== requestId) && !(action === 'stop' && queued)
  )) throw new Error('Another background request owns this conversation.');
  if (action === 'ensure') return { status: 'ready' };
  if (action === 'turn') {
    if (!answer) return { status: queued ? 'queued' : 'missing', ...(hosted && queued ? { recovering: !sessionRunning(session) } : {}) };
    const pending = answer.pendingInput;
    // Do not project trace data, tool arguments, model requests, report data or parameter defaults.
    return {
      status: session.recoveryPaused && answer.recovering ? 'paused' : answer.status,
      ...(hosted && answer.recovering && !session.activeRunId && !session.recoveryPaused ? { recovering: true } : {}),
      ...(hosted && answer.cancelRequested ? { stopping: true } : {}),
      messageId: answer.id,
      items: (answer.items ?? []).map(({ id, content, contentType, collapsed, metadata, display }) => ({
        id,
        content:
          typeof content === 'string' && !display && (!contentType || ['text', 'markdown'].includes(contentType))
            ? content
            : undefined,
        contentType,
        collapsed,
        kind: metadata?.kind,
        activity:
          collapsed && metadata?.kind === 'agent-part' && ['tool', 'reasoning'].includes(String(metadata.partType))
            ? metadata.partType
            : undefined,
        complete: ['success', 'completed', 'done', 'failed'].includes(String(metadata?.status)),
      })),
      pending: pending && {
        id: pending.requestId,
        title: pending.title,
        kind: pending.metadata?.type,
        tool: pending.metadata?.toolName,
        fields: pending.params.map(
          ({ name, label, type, control, format, multiple, required, options, userSetting, command, panel }) => ({
            name,
            label,
            type,
            control,
            format,
            multiple,
            required,
            panel,
            disabled: !!(userSetting || command || options?.some((o) => o.command)),
            options: options?.map((o) => o.value),
          }),
        ),
      },
    };
  }
  if (hosted && action === 'recover' && (answer?.recovering && !session.recoveryPaused && !answer.pendingInput || queued)) {
    if (queued && !answer) await controller.runQueued(session);
    else controller.recover(session);
    return { status: 'ready' };
  }
  if (action === 'submit') {
    if (
      !answer &&
      !queued &&
      (sessionRunning(session) || session.messages.some((m) => m.pendingInput) || session.queuedInputs?.length)
    )
      throw new Error('Conversation is busy.');
    const images = input.images;
    if (
      images !== undefined &&
      (!project.conversation?.attachments?.images ||
        !Array.isArray(images) ||
        images.length > 8 ||
        !images.every(
          (f) =>
            f &&
            typeof f.key === 'string' &&
            typeof f.path === 'string' &&
            /^image\/(jpeg|png|gif|webp)$/.test(f.mimeType),
        ))
    )
      throw new Error('Invalid host images.');
    const files =
      Array.isArray(images) && images.length
        ? {
            keys: images.map((f) => f.key),
            load: () =>
              runtime.uploadFiles(
                project,
                conversationId,
                images.map((f) => ({
                  name: `image.${f.mimeType.split('/')[1]}`,
                  mimeType: f.mimeType,
                  path: f.path,
                })),
              ),
          }
        : undefined;
    return entries.invoke(
      'submit',
      { conversationId, requestId, text: input.text, params: input.params },
      undefined,
      files,
    );
  }
  if (
    action === 'resolve' &&
    answer?.id &&
    answer.pendingInput?.requestId === input.pendingId &&
    input.messageId === answer.id
  ) {
    if (isolate && answer.pendingInput?.metadata?.type === 'tool-approval') throw new Error('This tool approval must not be resolved by the background host.');
    await controller.resume(
      answer.id,
      answer.pendingInput!.requestId,
      input.values as Record<string, unknown>,
      session,
    );
    return { status: 'resolved' };
  }
  if (action === 'stop' && answer && (hosted ? unfinished(answer) : answer.status === 'running' || answer.pendingInput)) {
    await controller.stop(session);
    return { status: 'stopped' };
  }
  if (action === 'stop' && queued) {
    await controller.removeQueued(requestId, session);
    return { status: 'stopped' };
  }
  throw new Error('The background request has changed.');
}
