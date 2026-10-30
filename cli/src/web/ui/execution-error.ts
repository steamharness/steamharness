/** Request failures remain actionable even when another run happens to be active. */
export function isExecutionError(message: Record<string, any>): boolean {
  if (message.type !== 'error' || message.connectionError || message.errorScope === 'stop') return false;
  if (message.errorSource !== undefined) return message.errorSource === 'execution';
  // Older execution notifications have a run/message identity and no request type.
  return !message.requestType && !!(message.runId || message.messageId);
}
