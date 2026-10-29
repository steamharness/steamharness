// Type-only bridge; no OpenClaw or native dependencies enter the host SDK.
export interface ConversationMessage { id: string; role: string; content: string; timestamp: number; }
export interface ExtractedMemory { content: string; type: string; priority: number; source_message_ids?: string[]; scene_name?: string; }
export interface MemoryRecord extends ExtractedMemory { id: string; scene_name?: string; timestamps?: unknown; }
