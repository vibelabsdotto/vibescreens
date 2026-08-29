declare const projectIdBrand: unique symbol;

export type ProjectId = `prj_${string}` & {
  readonly [projectIdBrand]: "ProjectId";
};

export interface ProjectMeta {
  id: ProjectId;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRegistry {
  schemaVersion: 1;
  revision: number;
  activeProjectId: ProjectId | null;
  projectOrder: ProjectId[];
  projectsById: Record<ProjectId, ProjectMeta>;
}

export const MAX_PROJECTS = 100;
export const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9_-]{1,64}$/;

export function createEmptyWorkspace(): WorkspaceRegistry {
  return {
    schemaVersion: 1,
    revision: 0,
    activeProjectId: null,
    projectOrder: [],
    projectsById: {},
  };
}

export class WorkspaceRevisionConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super(`Workspace revision conflict: current revision is ${currentRevision}`);
    this.name = "WorkspaceRevisionConflictError";
  }
}

export function mutateWorkspace(
  workspace: WorkspaceRegistry,
  baseRevision: number,
  mutator: (draft: WorkspaceRegistry) => void,
): WorkspaceRegistry {
  if (baseRevision !== workspace.revision) {
    throw new WorkspaceRevisionConflictError(workspace.revision);
  }

  const projectsById = {} as Record<ProjectId, ProjectMeta>;
  for (const projectId of Object.keys(workspace.projectsById) as ProjectId[]) {
    projectsById[projectId] = { ...workspace.projectsById[projectId] };
  }

  const nextWorkspace: WorkspaceRegistry = {
    ...workspace,
    projectOrder: [...workspace.projectOrder],
    projectsById,
  };

  mutator(nextWorkspace);
  nextWorkspace.revision = workspace.revision + 1;
  return nextWorkspace;
}

export function createProjectId(): ProjectId {
  return `prj_${globalThis.crypto.randomUUID()}` as ProjectId;
}

export function isProjectId(value: unknown): value is ProjectId {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

export function assertProjectId(value: unknown): asserts value is ProjectId {
  if (!isProjectId(value)) {
    throw new TypeError(`Invalid project ID: ${String(value)}`);
  }
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "project";
}

export function uniqueProjectSlug(
  name: string,
  existingSlugs: Iterable<string>,
): string {
  const baseSlug = slugifyProjectName(name);
  const usedSlugs = new Set(
    Array.from(existingSlugs, (slug) => slug.toLocaleLowerCase("en-US")),
  );

  if (!usedSlugs.has(baseSlug)) {
    return baseSlug;
  }

  let suffix = 2;
  while (usedSlugs.has(`${baseSlug}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseSlug}-${suffix}`;
}
