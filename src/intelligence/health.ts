import type { IntelligenceConfig } from "./config.js";
import { IntelligenceProviderError, type IntelligenceProvider } from "./provider.js";

export type AssistantProviderHealthStatus = "disabled" | "configured" | "reachable" | "unauthorized" | "unavailable" | "timeout" | "malformed_response";

/** A safe, small operational view: it intentionally contains no URL, token, prompt, or evidence. */
export interface AssistantProviderHealth {
  status: AssistantProviderHealthStatus;
  availability: "available" | "unavailable";
  /** Safe operational identity; endpoint location and credentials are omitted. */
  provider?: "ollama";
  model?: string;
  latencyMs?: number;
}

/**
 * Keeps provider reachability outside deterministic Observatory operations and
 * caches it briefly so browser renders do not create a health-check storm.
 */
export class AssistantProviderHealthService {
  private cached?: { expiresAt: number; value: AssistantProviderHealth };

  constructor(
    private readonly config: IntelligenceConfig,
    private readonly provider?: IntelligenceProvider,
    private readonly cacheMs = 15_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async check(): Promise<AssistantProviderHealth> {
    if (!this.config.enabled) return { status: "disabled", availability: "unavailable" };
    const cached = this.cached;
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (!this.provider?.health) return this.cache(this.withIdentity({ status: "configured", availability: "unavailable" }));

    const startedAt = this.now();
    try {
      await this.provider.health();
      return this.cache(this.withIdentity({ status: "reachable", availability: "available", latencyMs: Math.max(0, this.now() - startedAt) }));
    } catch (error) {
      const status = error instanceof IntelligenceProviderError
        ? healthStatus(error.code)
        : "unavailable";
      return this.cache(this.withIdentity({ status, availability: "unavailable", latencyMs: Math.max(0, this.now() - startedAt) }));
    }
  }

  private cache(value: AssistantProviderHealth): AssistantProviderHealth {
    this.cached = { value, expiresAt: this.now() + this.cacheMs };
    return value;
  }

  private withIdentity(value: AssistantProviderHealth): AssistantProviderHealth {
    return { ...value, ...(this.config.provider ? { provider: this.config.provider } : {}), ...(this.config.model ? { model: this.config.model } : {}) };
  }
}

function healthStatus(code: IntelligenceProviderError["code"]): Exclude<AssistantProviderHealthStatus, "disabled" | "configured" | "reachable"> {
  switch (code) {
    case "unauthorized": return "unauthorized";
    case "timeout": return "timeout";
    case "malformed_response": return "malformed_response";
    default: return "unavailable";
  }
}
