# Project Observatory v0.2B

## Implementation

This directory contains a runnable TypeScript implementation alongside the
v0.1 contract documents. It is an external, evidence-backed, read-only
observer: it never writes to an observed repository, deployment provider,
database, or financial system.

The canonical model is documented in [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md):

```text
read-only evidence → resolved knowledge with provenance → immutable snapshots
```

### Run locally

Requires Node 20+, the provider-managed Neon `POSTGRES_URL`, and a 32-byte
base64 `OBSERVATORY_CONFIG_KEY` for production. Production fails closed if any
of those required values is unavailable. Development uses a deliberately
non-production fallback encryption key and an in-memory store only when no
database URL is supplied. The operator token is required for administrative
HTTP calls in production.

```powershell
npm install
npm run check
npm test
npm run build
npm run migrate # guarded in production by OBSERVATORY_MIGRATE_PRODUCTION=true
$env:PORT = 3000
node dist/index.js
```

Open `http://localhost:3000` for the Projects dashboard. `GET /health` is the
health probe. Start the same state service as an MCP stdio process with:

```powershell
node dist/index.js --mcp
```

### Optional local Ollama / Qwen assistant

Ollama is an operator-managed local dependency; Observatory neither installs,
starts, nor deploys it. Install and run Ollama using its official instructions,
then choose a Qwen model, for example:

```powershell
ollama pull qwen2.5:7b
ollama serve
$env:OBSERVATORY_AI_ENABLED = "true"
$env:OBSERVATORY_AI_PROVIDER = "ollama"
$env:OBSERVATORY_AI_MODEL = "qwen2.5:7b"
$env:OBSERVATORY_AI_BASE_URL = "http://127.0.0.1:11434"
$env:OBSERVATORY_AI_TIMEOUT_MS = "20000"
$env:OBSERVATORY_ASSISTANT_UI_ENABLED = "true"
node dist/index.js
```

After registering and refreshing a project, exercise the assistant with:

```powershell
Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Uri "http://localhost:3000/api/projects/<project>/assistant" `
  -Body '{"question":"Where is this setting configured?"}'
```

Confirm that `status`, `revision`, and `evidence` identify the deterministic
snapshot sources; model prose is interpretation only. With AI disabled (the
default), this endpoint returns a controlled 503 while `/ask`, the browser,
ingestion, and MCP continue normally. Do not set a localhost base URL for a
production deployment. The adapter has no persisted conversational memory and
intentionally provides no write or execution capability.

#### Browser Assistant v0.2B smoke test

`OBSERVATORY_ASSISTANT_UI_ENABLED=true` independently exposes the browser
Assistant; it does not enable a provider. With the provider variables above and
a refreshed project, open:

```text
http://localhost:3000/projects/<project>/assistant
```

Ask a short sequence such as “Where is the platform fee configured?” followed
by “How much is it?” and inspect each answer's evidence status, answer
sufficiency, revision, expandable evidence, and retrieval activity. The second
turn may use the displayed concept only to resolve “it”; it is freshly grounded
against the current project snapshot and may validly return `incomplete` if no
current amount or rule is observed. Switch projects and confirm the transcript
and follow-up hints reset. Entering text that asks the assistant to ignore its
rules must not change its deterministic status, evidence, or available tools.

The page keeps at most four recent user messages, one short concept, and six
displayed evidence paths in browser memory for the open project page. It never
stores this context server-side or treats it as evidence. Leave the UI flag
unset in shared or production deployments unless an operator deliberately wants
this local browser surface. When the flag is off, the navigation item is hidden
and direct browser access returns a controlled unavailable page linking to Ask
Project. The API remains a separately composed read-only interface.

#### Optional HomeGift value-tracing smoke test

This is intentionally manual and is not part of CI. With a locally available
Ollama/Qwen instance, a refreshed local HomeGift snapshot, and the environment
above, run:

```powershell
$response = Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Uri "http://localhost:3000/api/projects/homegift/assistant" `
  -Body '{"question":"How much is the platform fee?"}'
$response | ConvertTo-Json -Depth 8
```

Inspect `answer`, `status`, `answerSufficiency`, `revision`, `evidence`, and
`toolCalls`. `verified_current` does not by itself establish that a fee amount
was found. If current evidence only propagates a field such as
`platformFeeMinor`, expect `answerSufficiency: "incomplete"` and a response
that says the amount/rule was not established. If a current literal or
calculation is found, the response must retain its provenance. Never treat a
model-supplied percentage or amount as evidence.

### Durable runtime and Vercel

`POSTGRES_URL` is the provider-managed pooled Vercel/Neon runtime variable.
`POSTGRES_URL_NON_POOLING` is reserved for the guarded migration runner. Source configurations are encrypted before they are persisted; they
are decrypted only while building the registered read-only adapter. The
PostgreSQL store hydrates all canonical state at process start, and browser,
HTTP, and MCP use the same query and `AskProjectService` layer over that store.
`api/index.ts` is a thin Vercel function adapter; the stdio MCP process remains
a local/server runtime.

### Secure remote MCP / ChatGPT

The production MCP endpoint is `POST /mcp` over public HTTPS. It accepts
authenticated JSON-RPC 2.0 MCP requests and exposes only seven bounded
read-only tools. Existing direct clients may retain the dedicated
`OBSERVATORY_MCP_READ_TOKEN`; it is not an operator credential and cannot
administer projects or refresh sources.

ChatGPT connections use an established OAuth/OIDC provider (for example,
Auth0) with Authorization Code + PKCE. Configure the issuer, resource audience,
owner subject allowlist, and optional JWKS URI in Vercel using the documented
`OBSERVATORY_OAUTH_*` variables. Observatory is only the OAuth resource server:
it discovers the provider through protected-resource metadata, verifies RS256
access tokens against JWKS, and never issues sessions, authorization codes, or
refresh tokens. In production, `/mcp` fails closed unless the request is HTTPS
and authenticated. It emits `Cache-Control: no-store`, redacts returned text,
and records minimal audit events without questions, queries, or tokens.

Use the detailed [remote MCP contract and ChatGPT connection steps](API_AND_MCP.md).

Migrations are ordered, checksummed, transactionally ledgered in
`observatory_schema_migrations`, and never reset or drop data automatically.
Run them only after verifying that `POSTGRES_URL_NON_POOLING` targets Observatory's
dedicated Neon database. In production the explicit migration guard is
required.

### HomeBound is deliberately not registered

No HomeBound repository, provider token, or deployment is configured by this
project. Registration remains blocked until the dedicated Neon database and
Vercel deployment pass the persistence release gate.

Project Observatory is an external, read-only project intelligence service. It connects to software projects without requiring Observatory-specific code inside those repositories, builds a normalized knowledge/state model, tracks changes, and exposes project state to humans and AI clients.

## v0.1 objective

Connect one project (HomeBound) as the proving adapter while keeping the core fully project-agnostic.

v0.1 must be able to:

1. Register a project and repository.
2. Read repository metadata, commits, branches, selected files, and documentation.
3. Ingest deployment metadata through an adapter.
4. Normalize project knowledge into typed records with provenance.
5. Build a current-state snapshot.
6. Record movements between snapshots.
7. Search project knowledge.
8. Expose the read-only state through HTTP and MCP-compatible tools.
9. Never modify project code, deployments, databases, or financial systems.

## Non-goals

- No automatic code changes.
- No merges or deployments.
- No database writes to observed projects.
- No financial execution.
- No autonomous production actions.
- No requirement for HomeBound to change its repository structure.
- No vector database in v0.1.

## Suggested stack

- TypeScript
- Next.js for UI and HTTP API
- PostgreSQL
- Prisma or equivalent ORM
- Background worker/cron for refresh jobs
- Adapter interfaces for GitHub, Vercel, filesystem and future providers
- MCP server layer backed by the same service methods as the HTTP API

See the remaining files in this package for the implementation contract.
