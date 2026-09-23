import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactContent, HealthResult, SourceAdapter, SourceArtifactRef, SourceConfig, SourceRevision } from "../domain/types.js";

const execFileAsync = promisify(execFile);

interface FilesystemConfig extends SourceConfig {
  rootPath: string;
}

function configOf(config: SourceConfig): FilesystemConfig {
  if (typeof config.rootPath !== "string" || !config.rootPath) throw new Error("Filesystem source requires config.rootPath.");
  return config as FilesystemConfig;
}

async function walk(root: string, directory = root): Promise<SourceArtifactRef[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const results: SourceArtifactRef[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".next", "coverage", "build", "dist"].includes(entry.name)) continue;
      results.push(...await walk(root, absolute));
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolute);
      results.push({ externalId: path.relative(root, absolute).replaceAll("\\", "/"), path: path.relative(root, absolute).replaceAll("\\", "/"), artifactType: "text", size: stat.size });
    }
  }
  return results;
}

/** A local, strictly read-only development adapter. */
export class FilesystemAdapter implements SourceAdapter {
  readonly kind = "filesystem";

  async healthCheck(config: SourceConfig): Promise<HealthResult> {
    const { rootPath } = configOf(config);
    try {
      const stats = await fs.stat(rootPath);
      return { state: stats.isDirectory() ? "healthy" : "unavailable", checkedAt: new Date().toISOString(), message: stats.isDirectory() ? undefined : "Configured path is not a directory." };
    } catch (error) {
      return { state: "unavailable", checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : "Unable to read configured path." };
    }
  }

  async getRevision(config: SourceConfig): Promise<SourceRevision> {
    const { rootPath } = configOf(config);
    try {
      const { stdout } = await execFileAsync("git", ["-C", rootPath, "rev-parse", "HEAD"], { windowsHide: true });
      return { value: stdout.trim(), observedAt: new Date().toISOString() };
    } catch {
      const files = await walk(rootPath);
      const hash = createHash("sha256");
      for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}:${file.size ?? 0};`);
      return { value: `filesystem:${hash.digest("hex")}`, observedAt: new Date().toISOString() };
    }
  }

  async listArtifacts(config: SourceConfig): Promise<SourceArtifactRef[]> {
    return walk(configOf(config).rootPath);
  }

  async readArtifact(config: SourceConfig, artifact: SourceArtifactRef): Promise<ArtifactContent> {
    const { rootPath } = configOf(config);
    const target = path.resolve(rootPath, artifact.path);
    const base = path.resolve(rootPath) + path.sep;
    if (!target.startsWith(base)) throw new Error("Artifact path escapes configured filesystem root.");
    return { content: await fs.readFile(target, "utf8"), encoding: "utf8" };
  }
}
