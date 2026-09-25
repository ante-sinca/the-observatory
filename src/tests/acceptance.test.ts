import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ArtifactContent, DeploymentAdapter, DeploymentRecord, HealthResult, SourceAdapter, SourceArtifactRef, SourceConfig, SourceRevision } from "../domain/types.js";
import { ConfigCipher, isAllowedArtifact } from "../core/security.js";
import { MemoryStore } from "../core/store.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import { createHttpServer } from "../http/server.js";
import { createVercelHandler, restoreVercelRequestUrl } from "../http/vercel.js";
import { createObservatory } from "../index.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { ProjectQueryService } from "../services/query.js";
import { AskProjectService } from "../services/ask-project.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";

class RepositoryFixture implements SourceAdapter {
  readonly kind: string;
  revision = "r1";
  files = new Map<string, string>();
  externalIds = new Map<string, string>();
  unavailable = false;
  failArtifactListing = false;
  constructor(kind = "fixture") { this.kind = kind; }
  async healthCheck(): Promise<HealthResult> { return this.unavailable ? { state: "unavailable", checkedAt: "2026-09-23T00:00:00.000Z", message: "fixture unavailable" } : { state: "healthy", checkedAt: "2026-09-23T00:00:00.000Z" }; }
  async getRevision(): Promise<SourceRevision> { return { value: this.revision, observedAt: "2026-09-23T00:00:00.000Z" }; }
  async listArtifacts(): Promise<SourceArtifactRef[]> { if (this.failArtifactListing) throw new Error("fixture artifact listing failed"); return [...this.files].map(([path, content]) => ({ externalId: this.externalIds.get(path) ?? `${this.revision}:${path}`, path, artifactType: "text", size: Buffer.byteLength(content) })); }
  async readArtifact(_config: SourceConfig, artifact: SourceArtifactRef): Promise<ArtifactContent> { const content = this.files.get(artifact.path); if (content === undefined) throw new Error("missing fixture content"); return { content, encoding: "utf8" }; }
}

class FailingDeploymentFixture implements DeploymentAdapter {
  readonly kind = "failing-deployment";
  async healthCheck(): Promise<HealthResult> { return { state: "healthy", checkedAt: "2026-09-23T00:00:00.000Z" }; }
  async getCurrentDeployment(): Promise<DeploymentRecord | null> { throw new Error("deployment API unavailable"); }
  async listRecentDeployments(): Promise<DeploymentRecord[]> { return []; }
}

function setup() {
  const store = new MemoryStore();
  const registry = new ProjectRegistry(store, ConfigCipher.fromEnvironment(), () => new Date("2026-09-23T00:00:00.000Z"));
  const repository = new RepositoryFixture();
  const github = new RepositoryFixture("github");
  const adapters = new AdapterRegistry().registerRepository(repository).registerRepository(github).registerDeployment(new FailingDeploymentFixture());
  const refresh = new RefreshOrchestrator(store, adapters, () => new Date("2026-09-23T00:00:00.000Z"));
  const queries = new ProjectQueryService(store);
  const ask = new AskProjectService(store, queries);
  return { store, registry, repository, github, refresh, queries, ask, tools: new ObservatoryToolService(queries, ask) };
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((item) => item.split(";", 1)[0]).filter((item): item is string => Boolean(item)).join("; ");
}

function combineCookies(...headers: string[]): string {
  return headers.flatMap((header) => header.split("; ")).filter(Boolean).join("; ");
}

function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match?.[1]);
  return match[1];
}

async function postForm(url: string, origin: string, cookies: string, fields: Record<string, string>, operatorToken?: string): Promise<Response> {
  return fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(cookies ? { cookie: cookies } : {}), ...(operatorToken ? { authorization: `Bearer ${operatorToken}` } : {}) }, body: new URLSearchParams(fields) });
}

test("a second project uses the same project-agnostic core", async () => {
  const { registry, refresh, queries, repository } = setup();
  repository.files.set("README.md", "# Shared project\nA document.");
  const first = await registry.createProject({ slug: "alpha", name: "Alpha" });
  const second = await registry.createProject({ slug: "beta", name: "Beta" });
  await registry.addSource(first.id, { type: "repository", provider: "fixture", config: { include: ["README.md"] } });
  await registry.addSource(second.id, { type: "repository", provider: "fixture", config: { include: ["README.md"] } });
  await refresh.refresh(first.id);
  await refresh.refresh(second.id);
  assert.equal(queries.listProjects().length, 2);
  assert.equal(queries.searchProject(second.id, "shared").length, 1);
});

test("an unchanged refresh is idempotent and produces no movement noise", async () => {
  const { store, registry, refresh, repository } = setup();
  repository.files.set("README.md", "# Current state\nObserved evidence.");
  const project = await registry.createProject({ slug: "one", name: "One" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  const first = await refresh.refresh(project.id);
  const second = await refresh.refresh(project.id);
  assert.ok(first.snapshot);
  assert.equal(second.idempotent, true);
  assert.equal(store.snapshots.length, 1);
  assert.equal(store.movements.length, 1);
});

test("shared Git blobs at separate paths retain distinct artifact provenance", async () => {
  const { store, registry, refresh, repository, queries } = setup();
  const shared = "# Shared blob\nEvidence with independent path provenance.";
  repository.files.set("docs/alpha.md", shared);
  repository.files.set("docs/beta.md", shared);
  repository.externalIds.set("docs/alpha.md", "git-blob-sha");
  repository.externalIds.set("docs/beta.md", "git-blob-sha");
  const project = await registry.createProject({ slug: "shared-blob", name: "Shared Blob" });
  const source = await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  const first = await refresh.refresh(project.id);
  assert.ok(first.snapshot);
  assert.equal(store.artifacts.filter((artifact) => artifact.sourceId === source.id).length, 2);
  assert.deepEqual(store.artifacts.filter((artifact) => artifact.sourceId === source.id).map((artifact) => artifact.path).sort(), ["docs/alpha.md", "docs/beta.md"]);
  assert.deepEqual(queries.getKnowledge(project.id).flatMap((record) => record.provenance.map((provenance) => provenance.path)).filter((path): path is string => Boolean(path)).sort(), ["docs/alpha.md", "docs/beta.md"]);
  const second = await refresh.refresh(project.id);
  assert.equal(second.idempotent, true);
  assert.equal(store.artifacts.filter((artifact) => artifact.sourceId === source.id).length, 2);
  assert.equal(store.snapshots.filter((snapshot) => snapshot.projectId === project.id).length, 1);
});

test("secret-pattern files can never be ingested", async () => {
  const { store, registry, refresh, repository } = setup();
  repository.files.set("README.md", "# Safe\nNormal knowledge.");
  repository.files.set(".env.production", "TOKEN=should-not-index");
  repository.files.set("credentials/service.json", "not safe");
  const project = await registry.createProject({ slug: "safe", name: "Safe" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  await refresh.refresh(project.id);
  assert.deepEqual(store.artifacts.map((artifact) => artifact.path), ["README.md"]);
  assert.equal(isAllowedArtifact(".env"), false);
  assert.equal(isAllowedArtifact("credentials/token.json"), false);
});

test("search results retain file and revision provenance", async () => {
  const { registry, refresh, repository, queries } = setup();
  repository.files.set("docs/decision.md", "# Rate policy\nA fixed daily rate is documented.");
  const project = await registry.createProject({ slug: "proof", name: "Proof" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: { include: ["docs/**"] } });
  await refresh.refresh(project.id);
  const [result] = queries.searchProject(project.id, "fixed daily");
  assert.equal(result?.provenance[0]?.path, "docs/decision.md");
  assert.equal(result?.provenance[0]?.repositoryCommit, "r1");
});

test("a deployment failure does not block repository ingestion", async () => {
  const { registry, refresh, repository, queries } = setup();
  repository.files.set("README.md", "# Repository evidence\nStill refresh this.");
  const project = await registry.createProject({ slug: "partial", name: "Partial" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  await registry.addSource(project.id, { type: "deployment", provider: "failing-deployment", config: {} });
  const result = await refresh.refresh(project.id);
  assert.equal(result.run.status, "partial");
  assert.equal(queries.searchProject(project.id, "repository").length, 1);
  assert.ok(queries.getConflicts(project.id).some((conflict) => conflict.type === "source_unavailable"));
});

test("changed evidence produces immutable snapshots and a changed movement", async () => {
  const { store, registry, refresh, repository, queries } = setup();
  repository.files.set("README.md", "# Policy\nInitial policy.");
  const project = await registry.createProject({ slug: "changes", name: "Changes" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  const first = await refresh.refresh(project.id);
  repository.revision = "r2";
  repository.files.set("README.md", "# Policy\nUpdated policy.");
  const second = await refresh.refresh(project.id);
  assert.ok(first.snapshot && second.snapshot);
  assert.equal(store.snapshots.length, 2);
  assert.ok(queries.compareSnapshots(project.id, first.snapshot!.id, second.snapshot!.id).some((movement) => movement.movementType === "changed"));
  assert.equal(first.snapshot!.knowledgeItemIds.length, 1);
});

test("explicit contradictory documentation and implementation evidence creates a conflict", async () => {
  const { registry, refresh, repository, queries } = setup();
  repository.files.set("docs/flow.md", "# Flow\n<!-- observatory:assert historical-replay = disabled -->");
  repository.files.set("lib/flow.ts", "// observatory:assert historical-replay = enabled");
  const project = await registry.createProject({ slug: "conflicts", name: "Conflicts" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  await refresh.refresh(project.id);
  const conflict = queries.getConflicts(project.id).find((item) => item.type === "evidence_mismatch");
  assert.ok(conflict);
  assert.equal(conflict?.evidence.key, "historical-replay");
});

test("MCP registry contains only documented read-only tools and delegates queries", async () => {
  const { registry, refresh, repository, tools, queries, ask } = setup();
  repository.files.set("README.md", "# Read only\nEvidence.");
  const project = await registry.createProject({ slug: "tools", name: "Tools" });
  await registry.addSource(project.id, { type: "repository", provider: "fixture", config: {} });
  await refresh.refresh(project.id);
  const names = tools.listTools().map((tool) => tool.name);
  assert.deepEqual(names, ["list_projects", "get_project_state", "search_project", "get_evidence", "get_file_excerpt", "get_recent_movements", "ask_project"]);
  assert.equal((tools.call("search_project", { project: project.id, query: "evidence" }) as { results: unknown[] }).results.length, 1);
  assert.equal(tools.listTools().every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), true);
  assert.equal(names.some((name) => ["edit_file", "commit", "merge", "deploy", "execute_sql", "send_payment", "mutate_production"].includes(name)), false);

  const localTools = new ObservatoryToolService(queries, ask, "local");
  assert.deepEqual(localTools.listTools().map((tool) => tool.name), ["list_projects", "get_project_state", "search_project", "get_recent_changes", "get_deployments", "get_decisions", "get_known_risks", "get_knowledge_item", "compare_snapshots", "get_source_artifact", "ask_project"]);
  assert.equal((localTools.call("search_project", { project: project.id, query: "evidence" }) as unknown[]).length, 1);
});

test("HTTP project administration and read-only MCP discovery use the shared services", async () => {
  const { registry, refresh, queries, ask, tools } = setup();
  const server = createHttpServer({ registry, refresh, queries, ask, tools });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "http-project", name: "HTTP Project" }) });
    assert.equal(created.status, 201);
    const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json() as Array<{ slug: string }>;
    assert.deepEqual(projects.map((project) => project.slug), ["http-project"]);
    const toolCatalog = await fetch(`http://127.0.0.1:${port}/mcp/tools`);
    assert.equal(toolCatalog.status, 401);
    assert.equal((await toolCatalog.json() as { error: { code: string } }).error.code, "unauthorized");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("browser navigation renders the dashboard and projects index from shared project queries", async () => {
  const { registry, refresh, queries, ask, tools } = setup();
  await registry.createProject({ slug: "homebound", name: "HomeBound" });
  await registry.createProject({ slug: "homegift", name: "HomeGift" });
  const server = createHttpServer({ registry, refresh, queries, ask, tools });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const dashboard = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type") ?? "", /text\/html/);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /Project Observatory/);
    assert.match(dashboardHtml, /href="\/projects"/);

    const projects = await fetch(`http://127.0.0.1:${port}/projects`);
    assert.equal(projects.status, 200);
    assert.match(projects.headers.get("content-type") ?? "", /text\/html/);
    const projectsHtml = await projects.text();
    assert.match(projectsHtml, /HomeBound/);
    assert.match(projectsHtml, /HomeGift/);
    assert.match(projectsHtml, /href="\/projects\/homebound"/);
    assert.match(projectsHtml, /href="\/projects\/homegift"/);

    const project = await fetch(`http://127.0.0.1:${port}/projects/homebound`);
    assert.equal(project.status, 200);
    const projectHtml = await project.text();
    assert.match(projectHtml, /href="\/">Home<\/a>/);
    assert.match(projectHtml, /href="\/projects">Projects<\/a>/);
    assert.match(projectHtml, /Overview/);
    assert.match(projectHtml, /State/);
    assert.match(projectHtml, /Knowledge/);
    assert.match(projectHtml, /Movements/);
    assert.match(projectHtml, /Sources/);

    const projectState = await fetch(`http://127.0.0.1:${port}/projects/homebound/state`);
    assert.equal(projectState.status, 200);
    assert.match(projectState.headers.get("content-type") ?? "", /text\/html/);

    const apiProjects = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(apiProjects.status, 200);
    assert.match(apiProjects.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual((await apiProjects.json() as Array<{ slug: string }>).map((project) => project.slug), ["homebound", "homegift"]);

    const unknownApi = await fetch(`http://127.0.0.1:${port}/api/not-a-route`);
    assert.equal(unknownApi.status, 404);
    assert.match(unknownApi.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await unknownApi.json(), { error: "Route not found." });

    const unknownBrowser = await fetch(`http://127.0.0.1:${port}/not-a-route`);
    assert.equal(unknownBrowser.status, 404);
    assert.match(unknownBrowser.headers.get("content-type") ?? "", /text\/html/);
    const unknownBrowserHtml = await unknownBrowser.text();
    assert.match(unknownBrowserHtml, /Page not found/);
    assert.match(unknownBrowserHtml, /href="\/">Home<\/a>/);
    assert.match(unknownBrowserHtml, /href="\/projects">Projects<\/a>/);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "project-observatory", version: "0.1.0" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("guided GitHub onboarding validates before persistence and never renders credentials", async () => {
  const previousOperatorToken = process.env.OBSERVATORY_OPERATOR_TOKEN;
  const operatorToken = "operator-token-for-test";
  const providerToken = "github-token-must-never-appear";
  process.env.OBSERVATORY_OPERATOR_TOKEN = operatorToken;
  const { store, registry, github, refresh, queries, ask, tools } = setup();
  github.files.set("README.md", "# New project\nEvidence from GitHub.");
  const server = createHttpServer({ registry, refresh, queries, ask, tools });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const direct = await fetch(`${origin}/projects/new`);
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /Operator authorization required/);

    const start = await fetch(`${origin}/projects/new`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(start.status, 200);
    const startHtml = await start.text();
    assert.match(startHtml, /Add project/);
    assert.match(startHtml, /Fine-grained GitHub token/);
    assert.match(startHtml, /Metadata: Read-only/);
    const initialCookies = cookieHeader(start);
    const csrf = csrfFrom(startHtml);

    const unauthorized = await postForm(`${origin}/projects/new/test`, origin, initialCookies, { csrf, name: "Unauthorised", slug: "", repository: "acme/unauthorised", branch: "main", token: providerToken });
    assert.equal(unauthorized.status, 403);
    assert.equal(store.projects.length, 0);

    const unauthorizedCreate = await postForm(`${origin}/projects/new/create`, origin, initialCookies, { csrf });
    assert.equal(unauthorizedCreate.status, 403);
    assert.equal(store.projects.length, 0);

    const malformed = await postForm(`${origin}/projects/new/test`, origin, initialCookies, { csrf, name: "Malformed", slug: "", repository: "not-a-repository", branch: "main", token: providerToken }, operatorToken);
    assert.equal(malformed.status, 400);
    const malformedHtml = await malformed.text();
    assert.match(malformedHtml, /owner\/repository/);
    assert.equal(malformedHtml.includes(providerToken), false);
    assert.equal(store.projects.length, 0);

    github.unavailable = true;
    const inaccessible = await postForm(`${origin}/projects/new/test`, origin, initialCookies, { csrf, name: "Inaccessible", slug: "", repository: "acme/inaccessible", branch: "main", token: providerToken }, operatorToken);
    assert.equal(inaccessible.status, 400);
    assert.match(await inaccessible.text(), /Repository not accessible with supplied credential/);
    assert.equal(store.projects.length, 0);
    github.unavailable = false;

    const tested = await postForm(`${origin}/projects/new/test`, origin, initialCookies, { csrf, name: "A Sensible New Project", slug: "", description: "Read-only onboarding proof", repository: "acme/new-project", branch: "main", token: providerToken }, operatorToken);
    assert.equal(tested.status, 200);
    const testedHtml = await tested.text();
    assert.match(testedHtml, /Connection healthy/);
    assert.match(testedHtml, /Repository accessible/);
    assert.match(testedHtml, /Branch: main/);
    assert.equal(testedHtml.includes(providerToken), false);
    assert.equal(store.projects.length, 0);

    const onboardingCookies = combineCookies(initialCookies, cookieHeader(tested));
    const created = await postForm(`${origin}/projects/new/create`, origin, onboardingCookies, { csrf }, operatorToken);
    assert.equal(created.status, 303);
    assert.equal(created.headers.get("location"), "/projects/a-sensible-new-project?onboarding=complete");
    assert.equal(store.projects.length, 1);
    assert.equal(store.sources.length, 1);
    assert.equal(store.sources[0]?.config.token, providerToken);
    assert.equal(store.sources[0]?.encryptedConfig.includes(providerToken), false);
    assert.equal(store.snapshots.length, 1);

    const projectPage = await fetch(`${origin}/projects/a-sensible-new-project?onboarding=complete`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(projectPage.status, 200);
    const projectHtml = await projectPage.text();
    assert.match(projectHtml, /A Sensible New Project onboarded/);
    assert.match(projectHtml, /Snapshot ID/);
    assert.equal(projectHtml.includes(providerToken), false);

    const publicSources = await fetch(`${origin}/api/projects/a-sensible-new-project/sources`);
    assert.equal(publicSources.status, 200);
    const publicSourceBody = await publicSources.text();
    assert.equal(publicSourceBody.includes(providerToken), false);
    assert.equal(publicSourceBody.includes("encryptedConfig"), false);

    const sourcesPage = await fetch(`${origin}/projects/a-sensible-new-project/sources`, { headers: { authorization: `Bearer ${operatorToken}`, cookie: initialCookies } });
    assert.equal(sourcesPage.status, 200);
    const sourcesHtml = await sourcesPage.text();
    assert.match(sourcesHtml, /Test connection/);
    assert.match(sourcesHtml, /Replace credential/);
    assert.match(sourcesHtml, /Source type/);
    assert.match(sourcesHtml, /Last checked/);
    assert.equal(sourcesHtml.includes(providerToken), false);

    const unauthorizedRefresh = await postForm(`${origin}/projects/a-sensible-new-project/refresh`, origin, initialCookies, { csrf });
    assert.equal(unauthorizedRefresh.status, 403);

    const replacementToken = "replacement-token-must-never-appear";
    const sourceId = store.sources[0]?.id;
    assert.ok(sourceId);
    const replaced = await postForm(`${origin}/projects/a-sensible-new-project/sources/${sourceId}/credential`, origin, initialCookies, { csrf, token: replacementToken }, operatorToken);
    assert.equal(replaced.status, 200);
    const replacedHtml = await replaced.text();
    assert.match(replacedHtml, /Credential replaced securely/);
    assert.equal(replacedHtml.includes(providerToken), false);
    assert.equal(replacedHtml.includes(replacementToken), false);
    assert.equal(store.sources[0]?.config.token, replacementToken);

    const duplicate = await postForm(`${origin}/projects/new/test`, origin, initialCookies, { csrf, name: "Duplicate", slug: "a-sensible-new-project", repository: "acme/new-project", branch: "main", token: providerToken }, operatorToken);
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /already exists/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousOperatorToken === undefined) delete process.env.OBSERVATORY_OPERATOR_TOKEN;
    else process.env.OBSERVATORY_OPERATOR_TOKEN = previousOperatorToken;
  }
});

test("failed first onboarding refresh preserves a retryable project and source", async () => {
  const previousOperatorToken = process.env.OBSERVATORY_OPERATOR_TOKEN;
  const operatorToken = "operator-token-for-retry-test";
  process.env.OBSERVATORY_OPERATOR_TOKEN = operatorToken;
  const { store, registry, github, refresh, queries, ask, tools } = setup();
  github.files.set("README.md", "# Retry project\nEvidence.");
  github.failArtifactListing = true;
  const server = createHttpServer({ registry, refresh, queries, ask, tools });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const start = await fetch(`${origin}/projects/new`, { headers: { authorization: `Bearer ${operatorToken}` } });
    const startHtml = await start.text();
    const csrf = csrfFrom(startHtml);
    const initialCookies = cookieHeader(start);
    const tested = await postForm(`${origin}/projects/new/test`, origin, initialCookies, { csrf, name: "Retry Project", slug: "retry-project", repository: "acme/retry-project", branch: "main", token: "retry-token" }, operatorToken);
    assert.equal(tested.status, 200);
    const created = await postForm(`${origin}/projects/new/create`, origin, combineCookies(initialCookies, cookieHeader(tested)), { csrf }, operatorToken);
    assert.equal(created.status, 202);
    assert.match(await created.text(), /Onboarding incomplete — refresh failed/);
    assert.equal(store.projects.length, 1);
    assert.equal(store.sources.length, 1);
    assert.equal(store.refreshRuns.at(-1)?.status, "failed");

    github.failArtifactListing = false;
    const retried = await postForm(`${origin}/projects/retry-project/refresh`, origin, initialCookies, { csrf }, operatorToken);
    assert.equal(retried.status, 200);
    assert.match(await retried.text(), /Refresh success/);
    assert.ok(store.snapshots.length > 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousOperatorToken === undefined) delete process.env.OBSERVATORY_OPERATOR_TOKEN;
    else process.env.OBSERVATORY_OPERATOR_TOKEN = previousOperatorToken;
  }
});

test("the Vercel adapter preserves the public route for the shared HTTP router", async () => {
  // The Vercel handler is intentionally a thin function, not a replacement
  // HTTP implementation. This uses Node's adapter shape to exercise its path
  // restoration and pre-request state reload before the shared router handles
  // /health.
  const store = new MemoryStore();
  let reloads = 0;
  store.reload = async () => { reloads += 1; };
  const handler = createVercelHandler(createObservatory({ store }));
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    assert.equal(restoreVercelRequestUrl("/api?__observatory_path=/"), "/");
    assert.equal(restoreVercelRequestUrl("/api?__observatory_path=%2Fprojects%2Fhomebound%2Fstate&since=snapshot-1&limit=2"), "/projects/homebound/state?since=snapshot-1&limit=2");

    const root = await fetch(`http://127.0.0.1:${port}/api?__observatory_path=/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await root.text(), /Project Observatory/);

    const health = await fetch(`http://127.0.0.1:${port}/api?__observatory_path=/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { status: string }).status, "ok");
    assert.equal(reloads, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
