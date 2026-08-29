import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteJson } from "./atomic-write";
import {
  detectProjectContent,
  materializeLegacyAssets,
  migrateProject,
  type AssetMigrationWarning,
  type LegacySourceFile,
  type MigrationIssue,
} from "./project-migrations";
import {
  ProjectAlreadyExistsError,
  ProjectIdentityMismatchError,
  createProjectRepository,
  type ProjectRepository,
  type TrashProjectResult,
} from "./project-repository";
import { workspaceRoot } from "./project-paths";
import type { ProjectDocumentV3 } from "./project-schema";
import {
  MAX_PROJECTS,
  WorkspaceRevisionConflictError,
  createEmptyWorkspace,
  createProjectId,
  isProjectId,
  mutateWorkspace,
  uniqueProjectSlug,
  type ProjectId,
  type WorkspaceRegistry,
} from "./workspace";

export interface NewProjectIdentity {
  projectId: ProjectId;
  name: string;
  now: string;
}

export type InitialProjectFactory = (
  identity: NewProjectIdentity,
) => ProjectDocumentV3 | Promise<ProjectDocumentV3>;

export interface CreateWorkspaceProjectInput {
  baseRevision: number;
  name: string;
  now?: string;
}

export interface SwitchWorkspaceProjectInput {
  baseRevision: number;
  projectId: ProjectId;
}

export interface RenameWorkspaceProjectInput {
  baseWorkspaceRevision: number;
  baseProjectRevision: number;
  projectId: ProjectId;
  name: string;
  now?: string;
}

export interface DeleteWorkspaceProjectInput {
  baseRevision: number;
  projectId: ProjectId;
  trashTimestamp: string;
}

export interface ImportLegacyProjectInput {
  baseRevision: number;
  migratedAt?: string;
}

export type ImportLegacyProjectResult =
  | {
      status: "imported";
      workspace: WorkspaceRegistry;
      project: ProjectDocumentV3;
      sourceFile: LegacySourceFile;
      backupPath: string;
      warnings: Array<MigrationIssue | AssetMigrationWarning>;
    }
  | { status: "not_needed"; workspace: WorkspaceRegistry }
  | { status: "no_source"; workspace: WorkspaceRegistry }
  | {
      status: "unsupported";
      schemaVersion: number;
      readOnly: true;
      sourceFile: LegacySourceFile;
    }
  | {
      status: "blocked";
      sourceFile: LegacySourceFile;
      blockers: MigrationIssue[];
      warnings: MigrationIssue[];
    };

export interface WorkspaceRepository {
  load(): Promise<WorkspaceRegistry>;
  readProject(projectId: ProjectId): Promise<ProjectDocumentV3>;
  findOrphanedProjects(): Promise<ProjectId[]>;
  createProject(
    input: CreateWorkspaceProjectInput,
  ): Promise<{ workspace: WorkspaceRegistry; project: ProjectDocumentV3 }>;
  switchProject(input: SwitchWorkspaceProjectInput): Promise<WorkspaceRegistry>;
  renameProject(
    input: RenameWorkspaceProjectInput,
  ): Promise<{ workspace: WorkspaceRegistry; project: ProjectDocumentV3 }>;
  deleteProject(input: DeleteWorkspaceProjectInput): Promise<{
    workspace: WorkspaceRegistry;
    trash: TrashProjectResult;
  }>;
  importLegacyProject(input: ImportLegacyProjectInput): Promise<ImportLegacyProjectResult>;
}

export interface WorkspaceRepositoryOptions {
  rootDir: string;
  projectRepository?: ProjectRepository;
  createInitialProject?: InitialProjectFactory;
  createProjectId?: () => ProjectId;
  now?: () => string;
  writeJson?: (targetPath: string, data: unknown) => Promise<void>;
}

export class WorkspaceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSchemaError";
  }
}

export class ProjectNotRegisteredError extends Error {
  constructor(public readonly projectId: ProjectId) {
    super(`Project ${projectId} is not registered in this workspace`);
    this.name = "ProjectNotRegisteredError";
  }
}

export class OrphanedProjectError extends Error {
  constructor(public readonly projectId: ProjectId) {
    super(`Registered project ${projectId} has no project document`);
    this.name = "OrphanedProjectError";
  }
}

export class WorkspaceProjectLimitError extends Error {
  constructor() {
    super(`A workspace cannot contain more than ${MAX_PROJECTS} projects`);
    this.name = "WorkspaceProjectLimitError";
  }
}

export class PartialWorkspaceCommitError extends Error {
  constructor(
    public readonly operation: "create" | "rename" | "delete" | "import",
    public readonly projectId: ProjectId,
    public readonly cause: unknown,
  ) {
    super(
      `${operation} changed project storage for ${projectId}, but workspace registration failed`,
    );
    this.name = "PartialWorkspaceCommitError";
  }
}

const workspaceOperationTails = new Map<string, Promise<void>>();

async function withWorkspaceQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = workspaceOperationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  workspaceOperationTails.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (workspaceOperationTails.get(key) === tail) {
      workspaceOperationTails.delete(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function assertValidWorkspaceRegistry(
  value: unknown,
): asserts value is WorkspaceRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new WorkspaceSchemaError("Workspace schemaVersion must be 1");
  }
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) {
    throw new WorkspaceSchemaError("Workspace revision must be an integer >= 0");
  }
  if (!Array.isArray(value.projectOrder) || !isRecord(value.projectsById)) {
    throw new WorkspaceSchemaError("Workspace requires projectOrder and projectsById");
  }
  if (value.projectOrder.length > MAX_PROJECTS) {
    throw new WorkspaceSchemaError(`Workspace exceeds the ${MAX_PROJECTS} project limit`);
  }
  const order = value.projectOrder;
  const map = value.projectsById;
  const orderIds = new Set<string>();
  for (const id of order) {
    if (!isProjectId(id) || orderIds.has(id)) {
      throw new WorkspaceSchemaError("projectOrder contains an invalid or duplicate ID");
    }
    orderIds.add(id);
  }
  const mapIds = Object.keys(map);
  if (
    mapIds.length !== order.length ||
    mapIds.some((id) => !orderIds.has(id))
  ) {
    throw new WorkspaceSchemaError(
      "projectOrder must contain every projectsById key exactly once",
    );
  }
  const slugs = new Set<string>();
  for (const [id, rawMeta] of Object.entries(map)) {
    if (!isRecord(rawMeta) || rawMeta.id !== id || !isProjectId(id)) {
      throw new WorkspaceSchemaError(`Invalid project metadata for ${id}`);
    }
    if (
      typeof rawMeta.name !== "string" ||
      rawMeta.name.trim().length === 0 ||
      typeof rawMeta.slug !== "string" ||
      rawMeta.slug.trim().length === 0 ||
      !validTimestamp(rawMeta.createdAt) ||
      !validTimestamp(rawMeta.updatedAt)
    ) {
      throw new WorkspaceSchemaError(`Incomplete project metadata for ${id}`);
    }
    const slugKey = rawMeta.slug.toLocaleLowerCase("en-US");
    if (slugs.has(slugKey)) {
      throw new WorkspaceSchemaError("Project slugs must be unique case-insensitively");
    }
    slugs.add(slugKey);
  }
  if (order.length === 0) {
    if (value.activeProjectId !== null) {
      throw new WorkspaceSchemaError("An empty workspace cannot select a project");
    }
  } else if (
    !isProjectId(value.activeProjectId) ||
    !orderIds.has(value.activeProjectId)
  ) {
    throw new WorkspaceSchemaError(
      "activeProjectId must reference a registered project",
    );
  }
}

export function createWorkspaceRepository(
  options: WorkspaceRepositoryOptions,
): WorkspaceRepository {
  const workspacePath = join(workspaceRoot(options.rootDir), "workspace.json");
  const writeJson = options.writeJson ?? atomicWriteJson;
  const projectRepository =
    options.projectRepository ?? createProjectRepository({ rootDir: options.rootDir });
  const idFactory = options.createProjectId ?? createProjectId;
  const clock = options.now ?? (() => new Date().toISOString());

  const readWorkspaceUnsafe = async (): Promise<{
    workspace: WorkspaceRegistry;
    exists: boolean;
  }> => {
    try {
      const serialized = await readFile(workspacePath, "utf8");
      const parsed = JSON.parse(serialized) as unknown;
      assertValidWorkspaceRegistry(parsed);
      return { workspace: parsed, exists: true };
    } catch (error) {
      if (isNotFoundError(error)) {
        return { workspace: createEmptyWorkspace(), exists: false };
      }
      throw error;
    }
  };

  const assertWorkspaceRevision = (
    workspace: WorkspaceRegistry,
    baseRevision: number,
  ) => {
    if (workspace.revision !== baseRevision) {
      throw new WorkspaceRevisionConflictError(workspace.revision);
    }
  };

  const requireRegistered = (
    workspace: WorkspaceRegistry,
    projectId: ProjectId,
  ) => {
    if (workspace.projectsById[projectId] === undefined) {
      throw new ProjectNotRegisteredError(projectId);
    }
  };

  const writeWorkspace = async (workspace: WorkspaceRegistry) => {
    assertValidWorkspaceRegistry(workspace);
    await writeJson(workspacePath, workspace);
  };

  const registerProject = (
    workspace: WorkspaceRegistry,
    project: ProjectDocumentV3,
    timestamp: string,
  ): WorkspaceRegistry =>
    mutateWorkspace(workspace, workspace.revision, (draft) => {
      const existingSlugs = Object.values(draft.projectsById).map(({ slug }) => slug);
      draft.projectOrder.push(project.projectId);
      draft.projectsById[project.projectId] = {
        id: project.projectId,
        name: project.name,
        slug: uniqueProjectSlug(project.name, existingSlugs),
        createdAt: project.createdAt,
        updatedAt: timestamp,
      };
      draft.activeProjectId = project.projectId;
    });

  const writeExactBackup = async (
    relativeBackupPath: string,
    sourceBytes: string,
  ): Promise<void> => {
    const absolutePath = join(options.rootDir, relativeBackupPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, sourceBytes, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const existing = await readFile(absolutePath, "utf8");
      if (existing !== sourceBytes) {
        throw new Error(`Existing migration backup differs at ${relativeBackupPath}`);
      }
    }
  };

  const findLegacySource = async (): Promise<
    | { sourceFile: LegacySourceFile; sourceBytes: string }
    | undefined
  > => {
    for (const sourceFile of [
      "vibescreens.json",
      "app-store-screenshots.json",
    ] as const) {
      try {
        return {
          sourceFile,
          sourceBytes: await readFile(join(options.rootDir, sourceFile), "utf8"),
        };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    return undefined;
  };

  return {
    async load() {
      return withWorkspaceQueue(workspacePath, async () => {
        const current = await readWorkspaceUnsafe();
        if (!current.exists) await writeWorkspace(current.workspace);
        return current.workspace;
      });
    },

    async readProject(projectId) {
      const { workspace } = await readWorkspaceUnsafe();
      requireRegistered(workspace, projectId);
      if (!(await projectRepository.exists(projectId))) {
        throw new OrphanedProjectError(projectId);
      }
      return projectRepository.read(projectId);
    },

    async findOrphanedProjects() {
      const { workspace } = await readWorkspaceUnsafe();
      const orphaned: ProjectId[] = [];
      for (const projectId of workspace.projectOrder) {
        if (!(await projectRepository.exists(projectId))) orphaned.push(projectId);
      }
      return orphaned;
    },

    async createProject(input) {
      return withWorkspaceQueue(workspacePath, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseRevision);
        if (workspace.projectOrder.length >= MAX_PROJECTS) {
          throw new WorkspaceProjectLimitError();
        }
        const name = input.name.trim();
        if (name.length === 0) throw new TypeError("Project name is required");
        const timestamp = input.now ?? clock();
        const projectId = idFactory();
        if (workspace.projectsById[projectId] !== undefined) {
          throw new ProjectIdentityMismatchError(`Generated duplicate project ID ${projectId}`);
        }
        if (options.createInitialProject === undefined) {
          throw new TypeError("createInitialProject is required for project creation");
        }
        const project = await options.createInitialProject({
          projectId,
          name,
          now: timestamp,
        });
        if (project.projectId !== projectId || project.revision !== 1) {
          throw new ProjectIdentityMismatchError(
            "Initial project factory must preserve the generated ID and revision 1",
          );
        }
        const persistedProject = await projectRepository.create(project);
        const nextWorkspace = registerProject(workspace, persistedProject, timestamp);
        try {
          await writeWorkspace(nextWorkspace);
        } catch (error) {
          throw new PartialWorkspaceCommitError("create", projectId, error);
        }
        return { workspace: nextWorkspace, project: persistedProject };
      });
    },

    async switchProject(input) {
      return withWorkspaceQueue(workspacePath, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseRevision);
        requireRegistered(workspace, input.projectId);
        if (!(await projectRepository.exists(input.projectId))) {
          throw new OrphanedProjectError(input.projectId);
        }
        if (workspace.activeProjectId === input.projectId) return workspace;
        const next = mutateWorkspace(workspace, workspace.revision, (draft) => {
          draft.activeProjectId = input.projectId;
        });
        await writeWorkspace(next);
        return next;
      });
    },

    async renameProject(input) {
      return withWorkspaceQueue(workspacePath, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseWorkspaceRevision);
        requireRegistered(workspace, input.projectId);
        const name = input.name.trim();
        if (name.length === 0) throw new TypeError("Project name is required");
        const timestamp = input.now ?? clock();
        const project = await projectRepository.mutate({
          projectId: input.projectId,
          baseRevision: input.baseProjectRevision,
          now: timestamp,
          mutate: (current) => ({ ...current, name }),
        });
        const nextWorkspace = mutateWorkspace(
          workspace,
          workspace.revision,
          (draft) => {
            const meta = draft.projectsById[input.projectId];
            const existingSlugs = Object.entries(draft.projectsById)
              .filter(([id]) => id !== input.projectId)
              .map(([, entry]) => entry.slug);
            meta.name = name;
            meta.slug = uniqueProjectSlug(name, existingSlugs);
            meta.updatedAt = timestamp;
          },
        );
        try {
          await writeWorkspace(nextWorkspace);
        } catch (error) {
          throw new PartialWorkspaceCommitError("rename", input.projectId, error);
        }
        return { workspace: nextWorkspace, project };
      });
    },

    async deleteProject(input) {
      return withWorkspaceQueue(workspacePath, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseRevision);
        requireRegistered(workspace, input.projectId);
        const trash = await projectRepository.moveToTrash(
          input.projectId,
          input.trashTimestamp,
        );
        const nextWorkspace = mutateWorkspace(
          workspace,
          workspace.revision,
          (draft) => {
            delete draft.projectsById[input.projectId];
            draft.projectOrder = draft.projectOrder.filter(
              (projectId) => projectId !== input.projectId,
            );
            if (draft.activeProjectId === input.projectId) {
              draft.activeProjectId = draft.projectOrder[0] ?? null;
            }
          },
        );
        try {
          await writeWorkspace(nextWorkspace);
        } catch (error) {
          throw new PartialWorkspaceCommitError("delete", input.projectId, error);
        }
        return { workspace: nextWorkspace, trash };
      });
    },

    async importLegacyProject(input) {
      return withWorkspaceQueue(workspacePath, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseRevision);
        if (workspace.projectOrder.length > 0) {
          return { status: "not_needed", workspace };
        }
        const source = await findLegacySource();
        if (source === undefined) return { status: "no_source", workspace };

        const parsed = JSON.parse(source.sourceBytes) as unknown;
        const detection = detectProjectContent(parsed);
        if (detection.kind === "unsupported") {
          return {
            status: "unsupported",
            schemaVersion: detection.version,
            readOnly: true,
            sourceFile: source.sourceFile,
          };
        }

        const sourceSha256 = createHash("sha256")
          .update(source.sourceBytes)
          .digest("hex");
        const backupPath = `.vibescreens/backups/${source.sourceFile}.${sourceSha256}.json`;
        const migratedAt = input.migratedAt ?? clock();
        const migration = migrateProject(parsed, {
          sourceFile: source.sourceFile,
          sourceSha256,
          backupPath,
          migratedAt,
        });
        if (migration.status === "unsupported") {
          return {
            status: "unsupported",
            schemaVersion: migration.schemaVersion,
            readOnly: true,
            sourceFile: source.sourceFile,
          };
        }
        if (migration.status === "blocked") {
          return {
            status: "blocked",
            sourceFile: source.sourceFile,
            blockers: migration.blockers,
            warnings: migration.warnings,
          };
        }

        let project: ProjectDocumentV3;
        let warnings: Array<MigrationIssue | AssetMigrationWarning> = [];
        if (migration.status === "migrated") {
          const materialized = await materializeLegacyAssets(migration, {
            rootDirectory: options.rootDir,
          });
          project = materialized.document;
          warnings = materialized.warnings;
        } else {
          project = migration.document;
        }

        await writeExactBackup(backupPath, source.sourceBytes);
        let persistedProject: ProjectDocumentV3;
        try {
          persistedProject = await projectRepository.create(project);
        } catch (error) {
          if (!(error instanceof ProjectAlreadyExistsError)) throw error;
          const existing = await projectRepository.read(project.projectId);
          if (
            existing.migration?.sourceSha256 !== sourceSha256 &&
            JSON.stringify(existing) !== JSON.stringify(project)
          ) {
            throw error;
          }
          persistedProject = existing;
        }
        const nextWorkspace = registerProject(workspace, persistedProject, migratedAt);
        try {
          await writeWorkspace(nextWorkspace);
        } catch (error) {
          throw new PartialWorkspaceCommitError(
            "import",
            persistedProject.projectId,
            error,
          );
        }
        return {
          status: "imported",
          workspace: nextWorkspace,
          project: persistedProject,
          sourceFile: source.sourceFile,
          backupPath,
          warnings,
        };
      });
    },
  };
}
