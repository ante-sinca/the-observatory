import type { DeploymentAdapter, DeploymentRecord, HealthResult, SourceConfig } from "../domain/types.js";

interface VercelConfig extends SourceConfig {
  projectId: string;
  teamId?: string;
  token?: string;
  apiBaseUrl?: string;
}

function configOf(config: SourceConfig): VercelConfig {
  if (typeof config.projectId !== "string" || !config.projectId) throw new Error("Vercel source requires config.projectId.");
  return config as VercelConfig;
}

/** Vercel adapter uses only read-only deployment listing endpoints. */
export class VercelAdapter implements DeploymentAdapter {
  readonly kind = "vercel";

  private async list(config: VercelConfig, limit: number): Promise<DeploymentRecord[]> {
    const params = new URLSearchParams({ projectId: config.projectId, limit: String(Math.min(Math.max(limit, 1), 100)) });
    if (config.teamId) params.set("teamId", config.teamId);
    const response = await fetch(`${config.apiBaseUrl ?? "https://api.vercel.com"}/v6/deployments?${params}`, {
      method: "GET",
      headers: { ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Vercel read failed (${response.status}).`);
    const payload = await response.json() as { deployments?: Array<Record<string, unknown>> };
    return (payload.deployments ?? []).map((deployment) => ({
      externalId: String(deployment.uid ?? deployment.id),
      environment: String(deployment.target ?? "preview"),
      revision: typeof deployment.meta === "object" && deployment.meta && typeof (deployment.meta as Record<string, unknown>).githubCommitSha === "string" ? String((deployment.meta as Record<string, unknown>).githubCommitSha) : undefined,
      status: String(deployment.state ?? "UNKNOWN"),
      deployedAt: new Date(Number(deployment.createdAt ?? Date.now())).toISOString(),
      metadata: { url: deployment.url },
    }));
  }

  async healthCheck(config: SourceConfig): Promise<HealthResult> {
    try {
      await this.list(configOf(config), 1);
      return { state: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { state: "unavailable", checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : "Vercel source unavailable." };
    }
  }

  async getCurrentDeployment(config: SourceConfig): Promise<DeploymentRecord | null> {
    const deployments = await this.list(configOf(config), 20);
    return deployments.find((deployment) => deployment.environment === "production") ?? null;
  }

  async listRecentDeployments(config: SourceConfig, limit: number): Promise<DeploymentRecord[]> {
    return this.list(configOf(config), limit);
  }
}
