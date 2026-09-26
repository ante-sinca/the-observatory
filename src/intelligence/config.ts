export interface IntelligenceConfig {
  enabled: boolean;
  provider?: "ollama";
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  authMode?: "bearer";
  /** Secret retained only in server-side composition/provider options. */
  authToken?: string;
  /** Safe, generic state only. Do not expose the rejected value. */
  reason?: "disabled" | "invalid_configuration";
}

type Environment = Record<string, string | undefined>;

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Reads process configuration once at composition time. Invalid AI settings
 * fail closed into an unavailable service and are never sent to a client.
 */
export function intelligenceConfigFromEnvironment(environment: Environment = process.env): IntelligenceConfig {
  const enabled = environment.OBSERVATORY_AI_ENABLED;
  if (enabled === undefined || enabled === "false") return { enabled: false, reason: "disabled" };
  if (enabled !== "true") return { enabled: false, reason: "invalid_configuration" };

  const provider = environment.OBSERVATORY_AI_PROVIDER;
  const model = environment.OBSERVATORY_AI_MODEL;
  const baseUrl = environment.OBSERVATORY_AI_BASE_URL ?? DEFAULT_BASE_URL;
  const timeoutMs = parseTimeout(environment.OBSERVATORY_AI_TIMEOUT_MS);
  const auth = authenticationFromEnvironment(environment);
  if (provider !== "ollama" || !validModel(model) || !validBaseUrl(baseUrl) || timeoutMs === undefined || !auth || (environment.NODE_ENV === "production" && (!auth.authToken || !isHttps(baseUrl)))) {
    return { enabled: false, reason: "invalid_configuration" };
  }
  return { enabled: true, provider, model, baseUrl: canonicalBaseUrl(baseUrl), timeoutMs, ...auth };
}

/** UI exposure is deliberately independent from provider configuration. */
export function assistantUiEnabledFromEnvironment(environment: Environment = process.env): boolean {
  return environment.OBSERVATORY_ASSISTANT_UI_ENABLED === "true";
}

function validModel(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}

function validBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function isHttps(value: string): boolean { return new URL(value).protocol === "https:"; }

function authenticationFromEnvironment(environment: Environment): { authMode?: "bearer"; authToken?: string } | undefined {
  const mode = environment.OBSERVATORY_AI_AUTH_MODE;
  const token = environment.OBSERVATORY_AI_AUTH_TOKEN;
  if (mode === undefined && token === undefined) return {};
  if (mode !== "bearer" || !validBearerToken(token)) return undefined;
  return { authMode: "bearer", authToken: token };
}

function validBearerToken(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~+\/=:-]{32,512}$/.test(value);
}

function canonicalBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 120_000 ? parsed : undefined;
}
