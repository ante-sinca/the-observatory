import { randomUUID } from "node:crypto";
import type { Project, ProjectSource, SourceConfig, SourceType } from "../domain/types.js";
import type { ObservatoryStore } from "../core/store.js";
import { ConfigCipher } from "../core/security.js";

export interface CreateProjectInput {
  slug: string;
  name: string;
  description?: string;
}

export interface CreateSourceInput {
  type: SourceType;
  provider: string;
  config: SourceConfig;
  enabled?: boolean;
}

export class ProjectRegistry {
  constructor(
    private readonly store: ObservatoryStore,
    private readonly cipher: ConfigCipher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  createProject(input: CreateProjectInput, actorId?: string): Project {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Project slug must be kebab-case.");
    if (!input.name.trim()) throw new Error("Project name is required.");
    if (this.store.projects.some((project) => project.slug === slug)) throw new Error(`Project slug '${slug}' already exists.`);
    const now = this.clock().toISOString();
    const project: Project = { id: randomUUID(), slug, name: input.name.trim(), description: input.description?.trim(), status: "active", createdAt: now, updatedAt: now };
    this.store.projects.push(project);
    this.audit("project.created", { slug }, project.id, actorId);
    return project;
  }

  updateProject(projectId: string, input: Partial<Pick<CreateProjectInput, "name" | "description">>, actorId?: string): Project {
    const project = this.getProject(projectId);
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new Error("Project name is required.");
      project.name = input.name.trim();
    }
    if (input.description !== undefined) project.description = input.description.trim() || undefined;
    project.updatedAt = this.clock().toISOString();
    this.audit("project.updated", { fields: Object.keys(input) }, project.id, actorId);
    return project;
  }

  getProject(projectRef: string): Project {
    const project = this.store.projects.find((item) => item.id === projectRef || item.slug === projectRef);
    if (!project) throw new Error(`Project '${projectRef}' was not found.`);
    return project;
  }

  listProjects(): Project[] {
    return [...this.store.projects].sort((a, b) => a.name.localeCompare(b.name));
  }

  addSource(projectId: string, input: CreateSourceInput, actorId?: string): ProjectSource {
    this.getProject(projectId);
    if (!input.provider.trim()) throw new Error("Source provider is required.");
    if (input.config.readOnly === false) throw new Error("Observed-project sources must be configured read-only.");
    const now = this.clock().toISOString();
    const source: ProjectSource = {
      id: randomUUID(),
      projectId,
      type: input.type,
      provider: input.provider.trim().toLowerCase(),
      config: { ...structuredClone(input.config), readOnly: true },
      encryptedConfig: this.cipher.encrypt({ ...input.config, readOnly: true }),
      enabled: input.enabled ?? true,
    };
    this.store.sources.push(source);
    this.audit("source.created", { sourceId: source.id, type: source.type, provider: source.provider, at: now }, projectId, actorId);
    return source;
  }

  getSources(projectId: string): ProjectSource[] {
    this.getProject(projectId);
    return this.store.sources.filter((source) => source.projectId === projectId);
  }

  private audit(action: string, metadata: Record<string, unknown>, projectId?: string, actorId?: string): void {
    this.store.auditEvents.push({ id: randomUUID(), actorId, projectId, action, metadata, createdAt: this.clock().toISOString() });
  }
}
