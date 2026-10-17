// Slim type slice for the knowledge-base inlined subset of run-workspace-input.
// Keep this list aligned with the references reachable from the files under
// ./markdown, ./ui, ./utils, and ./hooks. New fields belong here only when a
// retained file needs them.

export interface WorkflowManagedFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  storage: "local" | "server";
  workflowId?: string;
  conversationId?: string;
  createdAt: string;
}
