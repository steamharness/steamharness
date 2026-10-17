export type OpenAIMessageRole = "user" | "assistant" | "system" | "developer";

export type OpenAIMessageContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string; annotations?: unknown[]; logprobs?: unknown[] }
  | { type: "input_image"; image_url: string };

export interface OpenAIConversationHostInput {
  kind: "openai.responses";
  requestId: string;
  responseId: string;
  projectId: string;
  model: string;
  instructions?: string;
  messages: Array<{
    id?: string;
    type: "message";
    role: OpenAIMessageRole;
    content: OpenAIMessageContentPart[];
    status?: "in_progress" | "completed" | "incomplete";
  }>;
  settings: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    verbosity?: "low" | "medium" | "high";
  };
  apiConversationId?: string;
}

declare module "workflow-code" {
  interface WorkflowConversationDefinition {
    openai?: {
      enabled: true;
      outputItemId: string;
    };
  }
}

export type DeveloperAssistantPermissionPolicy =
  | "read-only"
  | "workspace"
  | "auto";
