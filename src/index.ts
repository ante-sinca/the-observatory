import { FilesystemAdapter } from "./adapters/filesystem.js";
import { GitHubAdapter } from "./adapters/github.js";
import { VercelAdapter } from "./adapters/vercel.js";
import { ConfigCipher } from "./core/security.js";
import { MemoryStore } from "./core/store.js";
import { createHttpServer } from "./http/server.js";
import { runMcpStdioServer } from "./mcp/server.js";
import { ObservatoryToolService } from "./mcp/tools.js";
import { ProjectRegistry } from "./services/project-registry.js";
import { ProjectQueryService } from "./services/query.js";
import { AdapterRegistry, RefreshOrchestrator } from "./services/refresh.js";

export function createObservatory() {
  const store = new MemoryStore();
  const adapters = new AdapterRegistry().registerRepository(new FilesystemAdapter()).registerRepository(new GitHubAdapter()).registerDeployment(new VercelAdapter());
  const registry = new ProjectRegistry(store, ConfigCipher.fromEnvironment());
  const refresh = new RefreshOrchestrator(store, adapters);
  const queries = new ProjectQueryService(store);
  const tools = new ObservatoryToolService(queries);
  return { store, adapters, registry, refresh, queries, tools };
}

if (process.argv[1] && new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href === import.meta.url) {
  const observatory = createObservatory();
  if (process.argv.includes("--mcp")) {
    runMcpStdioServer(observatory.tools);
  } else {
    const port = Number(process.env.PORT ?? 3000);
    createHttpServer(observatory).listen(port, () => console.log(`Project Observatory listening on http://localhost:${port}`));
  }
}
