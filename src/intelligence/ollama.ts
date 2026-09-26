import type { IntelligenceCompletion, IntelligenceCompletionRequest, IntelligenceMessage, IntelligenceProvider, IntelligenceToolCall } from "./provider.js";
import { IntelligenceProviderError } from "./provider.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Server-side only. Never log or return this value. */
  bearerToken?: string;
  fetchImplementation?: typeof fetch;
}

/** Minimal Ollama /api/chat adapter; no Ollama types leave this module. */
export class OllamaProvider implements IntelligenceProvider {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: OllamaProviderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async complete(request: IntelligenceCompletionRequest): Promise<IntelligenceCompletion> {
    let response: Response;
    try {
      response = await this.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          stream: false,
          messages: request.messages.map(ollamaMessage),
          tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        }),
      });
      this.assertSuccessful(response);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new IntelligenceProviderError("malformed_response"); }
      return parseCompletion(payload);
    } catch (error) { throw toProviderError(error); }
  }

  /** Lightweight endpoint deliberately separate from model generation. */
  async health(): Promise<void> {
    try {
      const response = await this.request("/api/version", { method: "GET" });
      this.assertSuccessful(response);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new IntelligenceProviderError("malformed_response"); }
      if (!isRecord(payload) || typeof payload.version !== "string" || !payload.version.trim()) throw new IntelligenceProviderError("malformed_response");
    } catch (error) { throw toProviderError(error); }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (this.options.bearerToken) headers.set("authorization", `Bearer ${this.options.bearerToken}`);
      return await this.fetchImplementation(`${this.options.baseUrl}${path}`, { ...init, headers, signal: controller.signal, redirect: "error" });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new IntelligenceProviderError("timeout");
      if (error instanceof IntelligenceProviderError) throw error;
      throw new IntelligenceProviderError("unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertSuccessful(response: Response): void {
    if (response.status === 401 || response.status === 403) throw new IntelligenceProviderError("unauthorized");
    if (!response.ok) throw new IntelligenceProviderError("unavailable");
  }
}

function toProviderError(error: unknown): IntelligenceProviderError {
  return error instanceof IntelligenceProviderError ? error : new IntelligenceProviderError("unavailable");
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
