# Project Observatory v0.1

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
