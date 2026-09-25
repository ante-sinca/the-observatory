import { FilesystemAdapter } from "./adapters/filesystem.js";
import { GitHubAdapter } from "./adapters/github.js";
import { VercelAdapter } from "./adapters/vercel.js";
import { ConfigCipher } from "./core/security.js";
import { PostgresStore } from "./core/postgres-store.js";
import { databaseUrlFromEnvironment, MemoryStore, type ObservatoryStore } from "./core/store.js";
import { createHttpServer } from "./http/server.js";
import { runMcpStdioServer } from "./mcp/server.js";
import { ObservatoryToolService } from "./mcp/tools.js";
import { ProjectRegistry } from "./services/project-registry.js";
import { ProjectQueryService } from "./services/query.js";
import { AskProjectService } from "./services/ask-project.js";
import { AdapterRegistry, RefreshOrchestrator } from "./services/refresh.js";

export async function createObservatory(options: { store?: ObservatoryStore } = {}) {
  const cipher = ConfigCipher.fromEnvironment();
  const store = options.store ?? (databaseUrlFromEnvironment() ? new PostgresStore(cipher) : process.env.NODE_ENV === "production" ? (() => { throw new Error("A provider-managed PostgreSQL connection is required in production (DATABASE_URL)."); })() : new MemoryStore());
  await store.ready();
  const adapters = new AdapterRegistry().registerRepository(new FilesystemAdapter()).registerRepository(new GitHubAdapter()).registerDeployment(new VercelAdapter());
  const registry = new ProjectRegistry(store, cipher);
  const refresh = new RefreshOrchestrator(store, adapters);
  const queries = new ProjectQueryService(store);
  const ask = new AskProjectService(store, queries);
  const tools = new ObservatoryToolService(queries, ask);
  const stdioTools = new ObservatoryToolService(queries, ask, "local");
  return { store, adapters, registry, refresh, queries, ask, tools, stdioTools };
}

if (process.argv[1] && new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href === import.meta.url) {
  createObservatory().then((observatory) => {
    if (process.argv.includes("--mcp")) {
      runMcpStdioServer(observatory.stdioTools);
    } else {
      const port = Number(process.env.PORT ?? 3000);
      createHttpServer(observatory).listen(port, () => console.log(`Project Observatory listening on http://localhost:${port}`));
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Unable to start Project Observatory.");
    process.exitCode = 1;
  });
}
