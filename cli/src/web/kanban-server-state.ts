export interface KanbanServerIssue {
  kind: 'sign-in-required' | 'project-unavailable' | 'access-denied' | 'setup-required';
  serverUrl?: string;
}

/** These responses need a user action, rather than another connection attempt. */
export function kanbanServerIssue(status: number, serverUrl: string): KanbanServerIssue | undefined {
  if (status === 401) return { kind: 'sign-in-required', serverUrl };
  if (status === 403) return { kind: 'access-denied', serverUrl };
  if (status === 404) return { kind: 'project-unavailable', serverUrl };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'setup-required', serverUrl };
}
