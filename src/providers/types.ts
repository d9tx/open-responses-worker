import type { Obj } from '../utils/runtime';

export interface ResponsesTool {
  name: string;
  description: string;
  schema: Obj;
  custom: boolean;
  namespace?: string;
}

export interface HistoryToolCall {
  callId: string;
  name: string;
  namespace?: string;
  arguments: string;
}

type HistoryRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface HistoryMessage {
  role: HistoryRole;
  content: string | null;
  reasoning?: string;
  toolCallId?: string;
  toolCalls?: HistoryToolCall[];
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string; namespace?: string };

export type ReasoningEffort = 'low' | 'high' | 'max';

export interface ResponsesRequest {
  model: string;
  history: HistoryMessage[];
  tools: ResponsesTool[];
  stream: boolean;
  toolChoice: ToolChoice;
  tokens: number;
  effort?: ReasoningEffort;
  outputSchema?: Obj;
  affinity?: string;
}

export interface ModelDescriptor {
  id: string;
  aliases: readonly string[];
  context: number;
  displayName: string;
  description: string;
}

export interface UpstreamRequest {
  model: string;
  input: unknown;
  stream: boolean;
  structuredSchema?: Obj;
  toolMap: ReadonlyMap<string, ResponsesTool>;
  options?: {
    extraHeaders?: Record<string, string>;
  };
}

export interface NormalizedToolCallDelta {
  index: number;
  name?: string;
  arguments?: string;
}

export type NormalizedFinishReason = 'stop' | 'tool_calls' | 'length';

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface NormalizedChunk {
  text?: string;
  reasoning?: string;
  toolCalls?: NormalizedToolCallDelta[];
  finish?: NormalizedFinishReason;
  usage?: NormalizedUsage;
  structuredValue?: unknown;
}

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProviderAdapter {
  model: ModelDescriptor;
  normalizeRequest(request: ResponsesRequest): UpstreamRequest;
  normalizeChunk(chunk: unknown): NormalizedChunk;
  normalizeError?(error: unknown): NormalizedError;
}
