# HTTP and secure MCP contract — v0.1

Project Observatory is read-only with respect to every observed project,
provider, deployment, database, and payment system. Its resolved snapshots are
the only source exposed to browser, HTTP, and MCP callers.

## HTTP API

Read endpoints are available under `/api/projects`. Project and source
administration remain separate HTTP-only operations protected by
`OBSERVATORY_OPERATOR_TOKEN`:

- `GET /api/projects`
- `POST /api/projects`
- `GET|PATCH /api/projects/:projectId`
- `GET|POST /api/projects/:projectId/sources`
- `POST /api/projects/:projectId/sources/:sourceId/health`
- `POST /api/projects/:projectId/refresh`
- `GET /api/projects/:projectId/refresh-runs`
- `GET /api/projects/:projectId/state`
- `GET /api/projects/:projectId/snapshots`
- `GET /api/projects/:projectId/movements`
- `GET /api/projects/:projectId/conflicts`
- `GET /api/projects/:projectId/knowledge`
- `GET /api/projects/:projectId/search?q=...`
- `GET /api/projects/:projectId/deployments`
- `POST /api/projects/:projectId/ask`
- `POST /api/projects/:projectId/assistant`

`POST /api/projects/:projectId/ask` accepts `{ "question": "..." }` and is
the same `AskProjectService` used by MCP. It is bounded to 2,000 question
characters and returns an evidence-backed answer, current repository revision,
provenance, explicit status, and relevant unresolved conflicts.

`POST /api/projects/:projectId/assistant` accepts the same bounded body and is
the optional v0.2B model interpretation endpoint. It may additionally accept
an optional browser-only `conversation` object:

```json
{
  "question": "Which tests cover it?",
  "conversation": {
    "referencedConcept": "release flag",
    "referencedPaths": ["src/config/release-flags.ts"],
    "recentUserMessages": ["Where is the release flag configured?"]
  }
}
```

The server accepts at most one 160-character concept, six 512-character paths,
and four 400-character user messages. This object is untrusted linguistic
context only: it is not persisted, returned as evidence, or used to bypass the
fresh deterministic Ask Project grounding pass. It returns:

```json
{
  "answer": "...",
  "status": "verified_current | partial | conflicted | insufficient_evidence",
  "answerSufficiency": "sufficient | incomplete | insufficient | conflicted",
  "project": "project-slug",
  "revision": "observed-repository-revision",
  "evidence": [],
  "toolCalls": [],
  "availability": "available | unavailable"
}
```

`status`, `answerSufficiency`, `revision`, and `evidence` are code-governed,
not model-selected. `status` describes the provenance/currentness of selected
evidence. `answerSufficiency` separately states whether it establishes the
fact requested by the question. Thus `verified_current` plus `incomplete` is a
valid and important result for a value that is referenced but not assigned,
calculated, configured, or otherwise established. Value tracing follows only
bounded current Observatory evidence and returns a concise tool trace, never
hidden model reasoning. The endpoint uses the same
read-only HTTP convention as Ask Project; it never changes a project or an
observed system. If AI is disabled, malformed, or unreachable it returns a
generic controlled `503` response with `availability: "unavailable"`; it never
exposes model configuration, base URLs, secrets, or transport details. This is
not an MCP tool and does not alter the established MCP catalogue or scopes.

The opt-in browser page is `GET /projects/:projectId/assistant`. It is exposed
only when `OBSERVATORY_ASSISTANT_UI_ENABLED=true`; otherwise the Assistant nav
is hidden and direct browser navigation returns a controlled 503 page with a
link to `/projects/:projectId/ask`. This browser gate does not grant provider
access, change the API contract, or add conversational state to MCP.

## Remote MCP

The stable production endpoint is `POST https://<deployment>/mcp`. It accepts
JSON-RPC 2.0 requests for `initialize`, `tools/list`, and `tools/call`, and
returns standard MCP tool content plus `structuredContent`. The existing
`node dist/index.js --mcp` stdio transport remains available for local MCP
clients with its established local read-tool catalogue. The restricted remote
catalogue below applies only to HTTP MCP. Compatibility paths `GET /mcp/tools`
and `POST /mcp/call` use the same read authentication but are not the ChatGPT
connection endpoint.

Remote access has two separate, non-interchangeable authentication paths:

```http
Authorization: Bearer <OBSERVATORY_MCP_READ_TOKEN>
Content-Type: application/json
```

`OBSERVATORY_MCP_READ_TOKEN` is an explicit `mcp_read` credential class. It
is never interchangeable with `OBSERVATORY_OPERATOR_TOKEN`, cannot call a
refresh or administrative route, and must be stored only as a deployment
secret. The server compares bearer values using `timingSafeEqual`, logs neither
the token nor tool arguments, sends `Cache-Control: no-store`, and rejects
remote MCP traffic in production unless Vercel forwards HTTPS.

This fixed bearer path remains for existing direct clients. ChatGPT uses OAuth
2.1 with an established provider (Auth0-compatible OIDC/OAuth) instead. The
provider owns Authorization Code + PKCE (`S256`), consent, login, and token
issuance. Observatory is only a resource server: it has no authorization-code
route, browser session, refresh-token store, or custom token signing key.

Configure the following Vercel Production variables before enabling OAuth:

| Variable | Classification | Required value |
| --- | --- | --- |
| `OBSERVATORY_MCP_PUBLIC_ORIGIN` | Server configuration, not secret | `https://the-observatory-blue.vercel.app` |
| `OBSERVATORY_OAUTH_ISSUER` | Server configuration, public provider identifier | Exact issuer from the provider, including its canonical trailing slash if supplied |
| `OBSERVATORY_OAUTH_AUDIENCE` | Server configuration, not secret | Exactly the same canonical resource origin |
| `OBSERVATORY_OAUTH_JWKS_URI` | Server configuration, public endpoint | Optional; defaults to `<issuer>/.well-known/jwks.json` |
| `OBSERVATORY_OAUTH_ALLOWED_SUBJECT` | Server-only access-control allowlist | The exact provider `sub` for the Observatory owner |
| `OBSERVATORY_MCP_READ_TOKEN` | Deployment secret | Optional legacy fixed bearer credential; never the operator token |
| `OBSERVATORY_OPERATOR_TOKEN` | Deployment secret | Operator-only administration credential; never an OAuth or MCP-read token |

Use the provider's documented OIDC/OAuth discovery and Universal Login setup.
Create a ChatGPT client/application at that provider with Authorization Code,
PKCE `S256`, the scopes below, and the redirect URI shown by ChatGPT during
connection. Do not add a local OAuth issuer or substitute a HomeGift/HomeBound
credential for any of these values.

### OAuth protected-resource discovery and enforcement

`GET /.well-known/oauth-protected-resource` returns no-store protected-resource
metadata for the canonical resource
`https://the-observatory-blue.vercel.app`, including its `authorization_servers`
issuer and supported scopes. It is available only after the complete OAuth
resource-server configuration above is present; incomplete configuration returns
a generic 503 rather than partial metadata.

Unauthenticated `POST /mcp` requests receive HTTP 401 with a stable JSON-RPC
`unauthorized` error and this form of challenge:

```http
WWW-Authenticate: Bearer resource_metadata="https://the-observatory-blue.vercel.app/.well-known/oauth-protected-resource", scope="projects:list project:read project:ask knowledge:search evidence:read movements:read", error="invalid_token", error_description="Authentication is required."
Cache-Control: no-store
```

For an unauthenticated or under-scoped `tools/call`, the HTTP 401 is paired
with an MCP error result whose `_meta["mcp/www_authenticate"]` contains the
same challenge (with `invalid_token` or `insufficient_scope`). This is the
runtime signal ChatGPT uses to show its OAuth-linking UI.

OAuth access tokens must be bearer JWT access tokens with `typ` `at+jwt` or
`JWT`, algorithm `RS256`, a signature from the configured JWKS, the exact
configured issuer, the canonical resource audience, an unexpired `exp`, any
applicable valid `nbf`, and the allowlisted owner `sub`. Tokens that are
malformed, expired, premature, wrong-issuer, wrong-audience, wrongly signed,
wrong-type, or missing the required scope fail closed. The token and its claims
are never logged.

The remote tool catalogue is deliberately limited to read-only tools:

- `list_projects`
- `get_project_state`
- `search_project`
- `get_evidence`
- `get_file_excerpt`
- `get_recent_movements`
- `ask_project`

Each remote tool advertises the matching OAuth 2.1 `securitySchemes` scope and
the server independently enforces it at invocation time:

| Tool | Required scope |
| --- | --- |
| `list_projects` | `projects:list` |
| `get_project_state` | `project:read` |
| `ask_project` | `project:ask` |
| `search_project` | `knowledge:search` |
| `get_evidence` | `evidence:read` |
| `get_file_excerpt` | `evidence:read` |
| `get_recent_movements` | `movements:read` |

All tool annotations declare `readOnlyHint: true` and no destructive/open-world
capability. No tool can register a project, change a source, refresh evidence,
write a file, deploy, execute SQL, or invoke an observed provider mutation.

### Snapshot, evidence, and isolation rules

`search_project` and `ask_project` use the current durable snapshot for the
selected project. `get_evidence` and `get_file_excerpt` only return an artifact
at the current repository revision. File paths are exact, repository-relative,
case-sensitive observed paths; absolute paths, backslashes, and traversal
segments are rejected. Artifact IDs are scoped to the requested project, and a
cross-project ID returns `evidence_not_in_project` with no artifact content or
metadata.

Search results, file excerpts, evidence, movements, and question input have
strict output/input limits. Text is redacted with the shared safe-text policy.
Excerpts are capped at 80 lines and 6,000 characters; list/search/movement
responses are capped as advertised by their schemas. Tool responses include
the repository revision and artifact path/line range when evidence is present.
`ask_project` deliberately omits the supplied question from its remote result.

Authenticated `tools/call` events write a durable `mcp.read` audit event with
only credential class, authentication method, granted scope names, tool name,
outcome, and timestamp. Failed OAuth validation is recorded as a separate
minimal event. Questions, queries, tokens, token claims, HTML, source
configuration, and credential values are never written to either event.

### Stable remote error data

JSON-RPC errors use `error.data.code` with one of:

`unauthorized`, `project_not_found`, `invalid_question`, `invalid_query`,
`evidence_not_found`, `evidence_not_in_project`, `invalid_path`,
`excerpt_range_too_large`, `insufficient_evidence`, or `internal_error`.

Unauthorized requests use HTTP 401 and the same `unauthorized` code whether
the credential is absent, malformed, wrong, unconfigured, under-scoped, or
presented over a non-HTTPS production request. OAuth-related 401s include the
protected-resource `WWW-Authenticate` challenge. Tool execution errors preserve
JSON-RPC's 200 response semantics and put their stable code in `error.data.code`.

## Connect from ChatGPT

1. In the OAuth provider, register the exact production resource audience,
   permit Authorization Code with PKCE `S256`, request only the seven scopes
   above, and add the redirect URI ChatGPT shows when the connection is created.
   Restrict access to the owner subject configured in
   `OBSERVATORY_OAUTH_ALLOWED_SUBJECT`.
2. Set the complete `OBSERVATORY_OAUTH_*` configuration in Vercel Production
   and redeploy. Keep any legacy `OBSERVATORY_MCP_READ_TOKEN` separate; never
   reuse `OBSERVATORY_OPERATOR_TOKEN`.
3. Check the protected-resource metadata endpoint, then confirm a bearer-less
   `POST /mcp` returns HTTP 401 with the `resource_metadata` challenge and no
   stack trace.
4. Open the existing ChatGPT MCP connection, use
   `https://the-observatory-blue.vercel.app/mcp`, complete the provider login,
   and refresh its tool catalogue. Verify only the seven read-only tools and
   their scopes appear.
5. Make project-scoped authenticated tool calls for the registered project(s),
   then verify a cross-project artifact ID, traversal path, blank question,
   oversized excerpt, and missing-scope call fail with the documented machine
   codes.

ChatGPT connection controls and availability can vary by account/workspace.
Follow the current [OpenAI MCP authentication guidance](https://developers.openai.com/plugins/build/auth) and [connection/test guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt): they cover protected-resource discovery, provider-hosted OAuth, a public HTTPS `/mcp` endpoint, authentication validation, and a refresh after server metadata changes.
