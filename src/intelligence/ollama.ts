import type { IntelligenceCompletion, IntelligenceCompletionRequest, IntelligenceMessage, IntelligenceProvider, IntelligenceToolCall } from "./provider.js";
import { IntelligenceProviderError } from "./provider.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
}

/** Minimal Ollama /api/chat adapter; no Ollama types leave this module. */
export class OllamaProvider implements IntelligenceProvider {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: OllamaProviderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async complete(request: IntelligenceCompletionRequest): Promise<IntelligenceCompletion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.options.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: request.model,
            stream: false,
            messages: request.messages.map(ollamaMessage),
            tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
          }),
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new IntelligenceProviderError("timeout");
        throw new IntelligenceProviderError("unavailable");
      }
      if (!response.ok) throw new IntelligenceProviderError("unavailable");
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new IntelligenceProviderError("malformed_response"); }
      return parseCompletion(payload);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function ollamaMessage(message: IntelligenceMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { tool_name: message.name } : {}),
    ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : {}),
  };
}

function parseCompletion(payload: unknown): IntelligenceCompletion {
  if (!isRecord(payload) || !isRecord(payload.message) || payload.message.role !== "assistant") throw new IntelligenceProviderError("malformed_response");
  const rawMessage = payload.message;
  if (rawMessage.content !== undefined && typeof rawMessage.content !== "string") throw new IntelligenceProviderError("malformed_response");
  const calls = rawMessage.tool_calls === undefined ? [] : parseToolCalls(rawMessage.tool_calls);
  return {
    message: { role: "assistant", content: rawMessage.content ?? "", ...(calls.length ? { toolCalls: calls } : {}) },
    finishReason: calls.length ? "tool_calls" : "stop",
  };
}

function parseToolCalls(value: unknown): IntelligenceToolCall[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new IntelligenceProviderError("invalid_tool_call");
  return value.map((call, index) => {
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string" || !isRecord(call.function.arguments)) {
      throw new IntelligenceProviderError("invalid_tool_call");
    }
    return { id: typeof call.id === "string" && call.id.length <= 128 ? call.id : `ollama-${index + 1}`, name: call.function.name, arguments: call.function.arguments };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
