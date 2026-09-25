import { createRemoteJWKSet, jwtVerify } from "jose";

export const MCP_READ_SCOPES = [
  "projects:list",
  "project:read",
  "project:ask",
  "knowledge:search",
  "evidence:read",
  "movements:read",
] as const;

export type McpReadScope = typeof MCP_READ_SCOPES[number];

export const MCP_TOOL_SCOPES: Record<string, McpReadScope> = {
  list_projects: "projects:list",
  get_project_state: "project:read",
  ask_project: "project:ask",
  search_project: "knowledge:search",
  get_evidence: "evidence:read",
  get_file_excerpt: "evidence:read",
  get_recent_movements: "movements:read",
};

export interface OAuthMcpConfiguration {
  issuer: string;
  audience: string;
  allowedSubject: string;
  jwksUri: string;
}

export interface OAuthMcpPrincipal {
  credentialClass: "mcp_read";
  authMethod: "oauth";
  scopes: ReadonlySet<McpReadScope>;
}

const ALLOWED_ACCESS_TOKEN_ALGORITHMS = ["RS256"] as const;
const remoteJwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Loads an Auth0-compatible OAuth/OIDC resource-server configuration. The
 * authorization server remains provider-hosted; Observatory only verifies
 * access tokens and does not issue codes, sessions, or refresh tokens.
 */
export function oauthMcpConfiguration(resource: string, environment: NodeJS.ProcessEnv = process.env): OAuthMcpConfiguration | undefined {
  const configuredIssuer = environment.OBSERVATORY_OAUTH_ISSUER;
  const allowedSubject = environment.OBSERVATORY_OAUTH_ALLOWED_SUBJECT;
  if (!configuredIssuer && !allowedSubject && !environment.OBSERVATORY_OAUTH_JWKS_URI && !environment.OBSERVATORY_OAUTH_AUDIENCE) return undefined;
  if (!configuredIssuer || !allowedSubject) return undefined;
  // Keep the configured issuer's trailing slash: Auth0 typically includes it
  // in the token `iss` claim.
  const issuer = validatedUrl(configuredIssuer, environment.NODE_ENV === "production");
  const audience = environment.OBSERVATORY_OAUTH_AUDIENCE ?? resource;
  if (audience !== resource) return undefined;
  const jwksUri = environment.OBSERVATORY_OAUTH_JWKS_URI ?? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  validatedUrl(jwksUri, environment.NODE_ENV === "production");
  return { issuer, audience, allowedSubject, jwksUri };
}

export function protectedResourceMetadata(resource: string, configuration: OAuthMcpConfiguration) {
  return {
    resource,
    authorization_servers: [configuration.issuer],
    scopes_supported: [...MCP_READ_SCOPES],
    resource_documentation: resource,
  };
}

/** Returns undefined for every malformed, stale, foreign, or insufficiently identified token. */
export async function verifyOAuthMcpAccessToken(authorization: string | undefined, configuration: OAuthMcpConfiguration): Promise<OAuthMcpPrincipal | undefined> {
  const token = bearerToken(authorization);
  if (!token) return undefined;
  try {
    const jwks = remoteJwksByUri.get(configuration.jwksUri) ?? createRemoteJWKSet(new URL(configuration.jwksUri));
    remoteJwksByUri.set(configuration.jwksUri, jwks);
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: configuration.issuer,
      audience: configuration.audience,
      algorithms: [...ALLOWED_ACCESS_TOKEN_ALGORITHMS],
      clockTolerance: 0,
    });
    if (protectedHeader.typ !== "at+jwt" && protectedHeader.typ !== "JWT") return undefined;
    if (typeof payload.exp !== "number" || typeof payload.sub !== "string" || payload.sub !== configuration.allowedSubject) return undefined;
    const scopes = scopesFromClaim(payload.scope);
    return { credentialClass: "mcp_read", authMethod: "oauth", scopes };
  } catch {
    return undefined;
  }
}

export function oauthScopeForTool(name: unknown): McpReadScope | undefined {
  return typeof name === "string" ? MCP_TOOL_SCOPES[name] : undefined;
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~+\/-]+)$/);
  return match?.[1];
}

function scopesFromClaim(value: unknown): ReadonlySet<McpReadScope> {
  const requested = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
  return new Set(requested.filter((scope): scope is McpReadScope => (MCP_READ_SCOPES as readonly string[]).includes(scope)));
}

function validatedUrl(value: string, requireHttps: boolean): string {
  const parsed = new URL(value);
  if (requireHttps && parsed.protocol !== "https:") throw new Error("OAuth URLs must use HTTPS in production.");
  return parsed.toString();
}
