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

  async createProject(input: CreateProjectInput, actorId?: string): Promise<Project> {
    const project = this.newProject(input);
    this.store.projects.push(project);
    this.audit("project.created", { slug: project.slug }, project.id, actorId);
    await this.store.flush();
    return project;
  }

  /**
   * Persists the first source with its project in one store flush. This keeps
   * onboarding from exposing a project that was never configured to observe.
   */
  async createProjectWithSource(projectInput: CreateProjectInput, sourceInput: CreateSourceInput, actorId?: string): Promise<{ project: Project; source: ProjectSource }> {
    const project = this.newProject(projectInput);
    const source = this.newSource(project.id, sourceInput);
    const projectCount = this.store.projects.length;
    const sourceCount = this.store.sources.length;
    const auditCount = this.store.auditEvents.length;
    this.store.projects.push(project);
    this.store.sources.push(source);
    this.audit("project.created", { slug: project.slug }, project.id, actorId);
    this.audit("source.created", { sourceId: source.id, type: source.type, provider: source.provider, at: this.clock().toISOString() }, project.id, actorId);
    try {
      await this.store.flush();
    } catch (error) {
      this.store.projects.splice(projectCount);
      this.store.sources.splice(sourceCount);
      this.store.auditEvents.splice(auditCount);
      throw error;
    }
    return { project, source };
  }

  async updateProject(projectId: string, input: Partial<Pick<CreateProjectInput, "name" | "description">>, actorId?: string): Promise<Project> {
    const project = this.getProject(projectId);
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new Error("Project name is required.");
      project.name = input.name.trim();
    }
    if (input.description !== undefined) project.description = input.description.trim() || undefined;
    project.updatedAt = this.clock().toISOString();
    this.audit("project.updated", { fields: Object.keys(input) }, project.id, actorId);
    await this.store.flush();
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

  async addSource(projectId: string, input: CreateSourceInput, actorId?: string): Promise<ProjectSource> {
    this.getProject(projectId);
    const source = this.newSource(projectId, input);
    this.store.sources.push(source);
    this.audit("source.created", { sourceId: source.id, type: source.type, provider: source.provider, at: this.clock().toISOString() }, projectId, actorId);
    await this.store.flush();
    return source;
  }

  /** Re-encrypts a provider credential without returning or auditing either value. */
  async replaceSourceCredential(projectId: string, sourceId: string, credential: string, actorId?: string): Promise<ProjectSource> {
    const source = this.store.sources.find((candidate) => candidate.id === sourceId && candidate.projectId === projectId);
    if (!source) throw new Error(`Source '${sourceId}' was not found.`);
    if (!credential.trim()) throw new Error("A replacement credential is required.");
    const config = { ...structuredClone(source.config), token: credential.trim(), readOnly: true };
    source.config = config;
    source.encryptedConfig = this.cipher.encrypt(config);
    this.audit("source.credential_replaced", { sourceId: source.id }, projectId, actorId);
    await this.store.flush();
    return source;
  }

  getSources(projectId: string): ProjectSource[] {
    this.getProject(projectId);
    return this.store.sources.filter((source) => source.projectId === projectId);
  }

  private newProject(input: CreateProjectInput): Project {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Project slug must be kebab-case.");
    if (!input.name.trim()) throw new Error("Project name is required.");
    if (this.store.projects.some((project) => project.slug === slug)) throw new Error(`Project slug '${slug}' already exists.`);
    const now = this.clock().toISOString();
    return { id: randomUUID(), slug, name: input.name.trim(), description: input.description?.trim(), status: "active", createdAt: now, updatedAt: now };
  }

  private newSource(projectId: string, input: CreateSourceInput): ProjectSource {
    if (!input.provider.trim()) throw new Error("Source provider is required.");
    if (input.config.readOnly === false) throw new Error("Observed-project sources must be configured read-only.");
    const config = { ...structuredClone(input.config), readOnly: true };
    return { id: randomUUID(), projectId, type: input.type, provider: input.provider.trim().toLowerCase(), config, encryptedConfig: this.cipher.encrypt(config), enabled: input.enabled ?? true };
  }

  private audit(action: string, metadata: Record<string, unknown>, projectId?: string, actorId?: string): void {
    this.store.auditEvents.push({ id: randomUUID(), actorId, projectId, action, metadata, createdAt: this.clock().toISOString() });
  }
}
