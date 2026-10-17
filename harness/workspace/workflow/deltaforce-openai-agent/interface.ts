import type { OpenAIAgentsRunner } from "@workflow-code/openai-agents-workflow/interface";
import type {
  AgentToolResult,
  ConversationChatMessage,
  DeltaforeAgentInput,
  DeltaforeAgentOutputPayload,
  FinalAnswerInput,
  ParsedAgentInput,
  WorkflowPayload,
  WorkflowNodeContext,
} from "@workflow-code/deltafore-agent-workflow/interface";

export type DeltaforceOpenAIAgentInput = DeltaforeAgentInput & {
  agentRunner?: OpenAIAgentsRunner;
};

export interface DeltaforceOpenAIParsedInput extends ParsedAgentInput {
  agentRunner?: OpenAIAgentsRunner;
}

export interface DeltaforceOpenAIAgentRunPayload extends FinalAnswerInput {
  conversationId?: string;
}

export type DeltaforceOpenAIAgentOutputPayload = DeltaforeAgentOutputPayload;

export type {
  AgentToolResult,
  ConversationChatMessage,
  WorkflowPayload,
  WorkflowNodeContext,
};
