/** Provider-neutral message and tool contract for Observatory intelligence. */
export type IntelligenceRole = "system" | "user" | "assistant" | "tool";

export interface IntelligenceToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface IntelligenceToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface IntelligenceMessage {
  role: IntelligenceRole;
  content: string;
  toolCalls?: IntelligenceToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface IntelligenceCompletionRequest {
  model: string;
  messages: IntelligenceMessage[];
  tools?: IntelligenceToolDefinition[];
}

export interface IntelligenceCompletion {
  message: IntelligenceMessage;
  finishReason: "stop" | "tool_calls";
}

/** A completion-only seam. Application services never depend on a vendor SDK. */
export interface IntelligenceProvider {
  complete(request: IntelligenceCompletionRequest): Promise<IntelligenceCompletion>;
}

export type IntelligenceProviderErrorCode = "unavailable" | "timeout" | "malformed_response" | "invalid_tool_call";

/** Deliberately stable, non-sensitive errors suitable for controlled responses. */
export class IntelligenceProviderError extends Error {
  constructor(public readonly code: IntelligenceProviderErrorCode) {
    super(code);
    this.name = "IntelligenceProviderError";
  }
}
