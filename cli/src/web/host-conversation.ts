import type { EntryConversations } from './entry-conversations';
import type { ConversationController } from './conversation-controller';
import { sessionRunning, type Project, type Runtime } from './workflow-types';

const uuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s);

/** Operations on a particular background turn. Only the local host's stdio channel calls this. */
export async function hostConversation(
  controller: ConversationController,
  entries: EntryConversations,
  runtime: Runtime,
  project: Project,
  input: Record<string, unknown>,
) {
  const { conversationId, requestId, action } = input;
  if (!uuid(conversationId) || !uuid(requestId)) throw new Error('Invalid background turn.');
  let session = controller.sessions.find((row) => row.id === conversationId);
  if (!session && (action === 'ensure' || action === 'submit')) {
    await controller.navigate(
      conversationId,
      [{ id: conversationId, create: true, draft: { text: '', attachments: [] } }],
      false,
    );
    session = controller.sessions.find((row) => row.id === conversationId);
    if (typeof input.title === 'string') await controller.rename(conversationId, input.title);
  }
  if (!session) return { status: 'missing' };
  const answer = session.messages.find(
    (m) => m.role === 'assistant' && (m.sessionRequestId ?? m.id) === requestId,
  );
  const queued = session.queuedInputs?.some((q) => (q.requestId ?? q.id) === requestId);
  if (action === 'ensure') return { status: 'ready' };
  if (action === 'turn') {
    if (!answer) return { status: queued ? 'queued' : 'missing' };
    const pending = answer.pendingInput;
    // Do not project trace data, tool arguments, model requests, report data or parameter defaults.
    return {
      status: session.recoveryPaused && answer.recovering ? 'paused' : answer.status,
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
    await controller.resume(
      answer.id,
      answer.pendingInput!.requestId,
      input.values as Record<string, unknown>,
      session,
    );
    return { status: 'resolved' };
  }
  if (action === 'stop' && answer && (answer.status === 'running' || answer.pendingInput)) {
    await controller.stop(session);
    return { status: 'stopped' };
  }
  if (action === 'stop' && queued) {
    await controller.removeQueued(requestId, session);
    return { status: 'stopped' };
  }
  throw new Error('The background request has changed.');
}
