import type { ArtifactContent, HealthResult, SourceAdapter, SourceArtifactRef, SourceConfig, SourceRevision } from "../domain/types.js";

interface GitHubConfig extends SourceConfig {
  repository: string;
  token?: string;
  defaultBranch?: string;
  apiBaseUrl?: string;
}

function configOf(config: SourceConfig): GitHubConfig {
  if (typeof config.repository !== "string" || !/^[^/]+\/[^/]+$/.test(config.repository)) throw new Error("GitHub source requires config.repository in owner/repository form.");
  return config as GitHubConfig;
}

/** GitHub adapter deliberately calls only GET endpoints and accepts read-only tokens. */
export class GitHubAdapter implements SourceAdapter {
  readonly kind = "github";

  private async request<T>(config: GitHubConfig, pathname: string): Promise<T> {
    const response = await fetch(`${config.apiBaseUrl ?? "https://api.github.com"}${pathname}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}) for ${pathname}.`);
    return response.json() as Promise<T>;
  }

  async healthCheck(config: SourceConfig): Promise<HealthResult> {
    try {
      const source = configOf(config);
      await this.request(source, `/repos/${source.repository}`);
      return { state: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { state: "unavailable", checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : "GitHub source unavailable." };
    }
  }

  async getRevision(config: SourceConfig): Promise<SourceRevision> {
    const source = configOf(config);
    const repository = await this.request<{ default_branch: string }>(source, `/repos/${source.repository}`);
    const branch = source.defaultBranch ?? repository.default_branch;
    const ref = await this.request<{ object: { sha: string } }>(source, `/repos/${source.repository}/git/ref/heads/${encodeURIComponent(branch)}`);
    return { value: ref.object.sha, observedAt: new Date().toISOString() };
  }

  async listArtifacts(config: SourceConfig): Promise<SourceArtifactRef[]> {
    const source = configOf(config);
    const revision = await this.getRevision(source);
    const tree = await this.request<{ tree: Array<{ path: string; type: string; sha: string; size?: number }> }>(source, `/repos/${source.repository}/git/trees/${revision.value}?recursive=1`);
    return tree.tree.filter((entry) => entry.type === "blob").map((entry) => ({ externalId: entry.sha, path: entry.path, artifactType: "text", size: entry.size }));
  }

  async readArtifact(config: SourceConfig, artifact: SourceArtifactRef): Promise<ArtifactContent> {
    const source = configOf(config);
    const response = await fetch(`${source.apiBaseUrl ?? "https://api.github.com"}/repos/${source.repository}/contents/${artifact.path}`, {
      method: "GET",
      headers: { Accept: "application/vnd.github.raw", ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub artifact read failed (${response.status}) for ${artifact.path}.`);
    return { content: await response.text(), encoding: "utf8" };
  }
}
