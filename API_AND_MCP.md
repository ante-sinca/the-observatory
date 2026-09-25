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

`POST /api/projects/:projectId/ask` accepts `{ "question": "..." }` and is
the same `AskProjectService` used by MCP. It is bounded to 2,000 question
characters and returns an evidence-backed answer, current repository revision,
provenance, explicit status, and relevant unresolved conflicts.

## Remote MCP

The stable production endpoint is `POST https://<deployment>/mcp`. It accepts
JSON-RPC 2.0 requests for `initialize`, `tools/list`, and `tools/call`, and
returns standard MCP tool content plus `structuredContent`. The existing
`node dist/index.js --mcp` stdio transport remains available for local MCP
clients with its established local read-tool catalogue. The restricted remote
catalogue below applies only to HTTP MCP. Compatibility paths `GET /mcp/tools`
and `POST /mcp/call` use the same read authentication but are not the ChatGPT
connection endpoint.

Every remote request needs:

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

The remote tool catalogue is deliberately limited to read-only tools:

- `list_projects`
- `get_project_state`
- `search_project`
- `get_evidence`
- `get_file_excerpt`
- `get_recent_movements`
- `ask_project`

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
only credential class, tool name, outcome, and timestamp. Questions, queries,
tokens, HTML, source configuration, and credential values are never written to
that event.

### Stable remote error data

JSON-RPC errors use `error.data.code` with one of:

`unauthorized`, `project_not_found`, `invalid_question`, `invalid_query`,
`evidence_not_found`, `evidence_not_in_project`, `invalid_path`,
`excerpt_range_too_large`, `insufficient_evidence`, or `internal_error`.

Unauthorized requests use HTTP 401 and the same `unauthorized` code whether
the credential is absent, malformed, wrong, unconfigured, or presented over a
non-HTTPS production request. Tool execution errors preserve JSON-RPC's 200
response semantics and put their stable code in `error.data.code`.

## Connect from ChatGPT

1. Set a new long random `OBSERVATORY_MCP_READ_TOKEN` in the Vercel Production
   environment. Do not reuse or expose the operator token. Redeploy after
   adding it.
2. Confirm `POST /mcp` rejects an absent bearer token, then initialize it with
   the read token over the public HTTPS deployment URL.
3. In ChatGPT developer mode, create a custom MCP connection and supply the
   public HTTPS URL including `/mcp`; configure its connection authentication
   to send the read-only bearer token. Scan/refresh the catalogue and verify
   only the seven read-only tools above appear.
4. Run project-scoped prompts for HomeGift and HomeBound, then verify a
   cross-project artifact ID, traversal path, blank question, and oversized
   excerpt fail with the documented machine codes.

ChatGPT connection controls and availability can vary by account/workspace.
Follow the current [OpenAI connection and test guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt): it calls for a public HTTPS `/mcp` endpoint, tool discovery, authentication validation, and a refresh after server metadata changes.
