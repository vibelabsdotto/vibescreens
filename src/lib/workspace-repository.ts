import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { storeAsset } from "./asset-store";
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
  ProjectNotFoundError,
  ProjectRevisionConflictError,
  createProjectRepository,
  type ProjectRepository,
  type TrashProjectResult,
} from "./project-repository";
import { projectDocumentPath, workspaceRoot } from "./project-paths";
import {
  normalizeProjectDocument,
  type ProjectDocumentV3,
} from "./project-schema";
import {
  createSqliteDocumentStore,
  type SqliteDocumentStore,
} from "./sqlite-storage";
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
  /** CLI-only external legacy folder. Never accepted from an HTTP body. */
  sourceDirectory?: string;
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
  store?: SqliteDocumentStore;
  createInitialProject?: InitialProjectFactory;
  createProjectId?: () => ProjectId;
  now?: () => string;
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
  const legacyWorkspacePath = join(workspaceRoot(options.rootDir), "workspace.json");
  const store = options.store ?? createSqliteDocumentStore(options.rootDir);
  const projectRepository =
    options.projectRepository ??
    createProjectRepository({ rootDir: options.rootDir, store });
  const idFactory = options.createProjectId ?? createProjectId;
  const clock = options.now ?? (() => new Date().toISOString());

  const splitLegacyApps = (
    workspace: WorkspaceRegistry,
    projects: readonly ProjectDocumentV3[],
  ): { workspace: WorkspaceRegistry; projects: ProjectDocumentV3[] } => {
    const byId = new Map(projects.map((project) => [project.projectId, project]));
    const nextWorkspace = structuredClone(workspace);
    nextWorkspace.projectOrder = [];
    nextWorkspace.projectsById = {};
    const nextProjects: ProjectDocumentV3[] = [];
    const slugs: string[] = [];

    const addProject = (project: ProjectDocumentV3) => {
      if (nextProjects.length >= MAX_PROJECTS) {
        throw new WorkspaceProjectLimitError();
      }
      const slug = uniqueProjectSlug(project.name, slugs);
      slugs.push(slug);
      nextProjects.push(project);
      nextWorkspace.projectOrder.push(project.projectId);
      nextWorkspace.projectsById[project.projectId] = {
        id: project.projectId,
        name: project.name,
        slug,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    };

    for (const sourceProjectId of workspace.projectOrder) {
      const source = byId.get(sourceProjectId);
      if (source === undefined) throw new OrphanedProjectError(sourceProjectId);
      if (source.appOrder.length <= 1) {
        addProject(source);
        continue;
      }

      const selectedAppId = source.selection.appId;
      const appOrder = [
        selectedAppId,
        ...source.appOrder.filter((appId) => appId !== selectedAppId),
      ];
      for (const appId of appOrder) {
        const app = structuredClone(source.appsById[appId]);
        const versionId = app.versionOrder.includes(source.selection.versionId)
          ? source.selection.versionId
          : app.versionOrder[0];
        const version = app.versionsById[versionId];
        const deckId = version.deckOrder.includes(source.selection.deckId)
          ? source.selection.deckId
          : version.deckOrder[0];
        const deck = version.decksById[deckId];
        const selectedSlideId = deck.slides.some(({ id }) => id === source.selection.slideId)
          ? source.selection.slideId
          : deck.slides[0]?.id;
        const projectId = appId === selectedAppId ? source.projectId : idFactory();
        if (nextProjects.some((project) => project.projectId === projectId)) {
          throw new ProjectAlreadyExistsError(projectId);
        }
        const isolated = normalizeProjectDocument({
          ...structuredClone(source),
          projectId,
          name: app.name,
          revision: source.revision,
          appOrder: [appId],
          appsById: { [appId]: app },
          assetsById: Object.fromEntries(
            Object.entries(source.assetsById).filter(([, asset]) => asset.scope.appId === appId),
          ),
          selection: {
            appId,
            versionId,
            deckId,
            ...(selectedSlideId === undefined ? {} : { slideId: selectedSlideId }),
          },
        });
        addProject(isolated);
      }
    }
    nextWorkspace.activeProjectId = workspace.activeProjectId;
    assertValidWorkspaceRegistry(nextWorkspace);
    return { workspace: nextWorkspace, projects: nextProjects };
  };

  const importCurrentJsonWorkspace = async (): Promise<boolean> => {
    let serialized: string;
    try {
      serialized = await readFile(legacyWorkspacePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
    const workspace = JSON.parse(serialized) as unknown;
    assertValidWorkspaceRegistry(workspace);
    const projects: ProjectDocumentV3[] = [];
    for (const projectId of workspace.projectOrder) {
      try {
        const projectBytes = await readFile(
          projectDocumentPath(options.rootDir, projectId),
          "utf8",
        );
        const project = normalizeProjectDocument(JSON.parse(projectBytes) as unknown);
        if (project.projectId !== projectId) {
          throw new ProjectIdentityMismatchError(
            `Stored project ID ${project.projectId} does not match workspace ID ${projectId}`,
          );
        }
        projects.push(project);
      } catch (error) {
        if (isNotFoundError(error)) throw new OrphanedProjectError(projectId);
        throw error;
      }
    }
    const split = splitLegacyApps(workspace, projects);
    store.importWorkspace(split.workspace, split.projects);
    return true;
  };

  const readWorkspaceUnsafe = async (): Promise<{
    workspace: WorkspaceRegistry;
    exists: boolean;
  }> => {
    let workspace = store.readWorkspace();
    if (workspace === undefined) {
      await importCurrentJsonWorkspace();
      workspace = store.readWorkspace();
    }
    if (workspace === undefined) {
      return { workspace: createEmptyWorkspace(), exists: false };
    }
    assertValidWorkspaceRegistry(workspace);
    return { workspace, exists: true };
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

  const writeWorkspace = async (
    workspace: WorkspaceRegistry,
    baseRevision?: number,
  ) => {
    assertValidWorkspaceRegistry(workspace);
    if (baseRevision === undefined) {
      if (store.createWorkspace(workspace)) return;
    } else if (store.compareAndSwapWorkspace(baseRevision, workspace)) {
      return;
    } else if (
      baseRevision === 0 &&
      store.readWorkspace() === undefined &&
      store.createWorkspace(workspace)
    ) {
      return;
    }
    const latest = store.readWorkspace();
    throw new WorkspaceRevisionConflictError(latest?.revision ?? 0);
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

  const findLegacySource = async (sourceDirectory = options.rootDir): Promise<
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
          sourceBytes: await readFile(
            /* turbopackIgnore: true */ join(
              /* turbopackIgnore: true */ sourceDirectory,
              sourceFile,
            ),
            "utf8",
          ),
        };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    return undefined;
  };

  return {
    async load() {
      return withWorkspaceQueue(store.path, async () => {
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
      return withWorkspaceQueue(store.path, async () => {
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
        const persistedProject = normalizeProjectDocument(project);
        const nextWorkspace = registerProject(workspace, persistedProject, timestamp);
        if (
          !store.createProjectWithWorkspace(
            workspace.revision,
            nextWorkspace,
            persistedProject,
          )
        ) {
          if (store.hasProject(projectId)) {
            throw new ProjectAlreadyExistsError(projectId);
          }
          throw new WorkspaceRevisionConflictError(store.readWorkspace()?.revision ?? 0);
        }
        return { workspace: nextWorkspace, project: persistedProject };
      });
    },

    async switchProject(input) {
      return withWorkspaceQueue(store.path, async () => {
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
        await writeWorkspace(next, workspace.revision);
        return next;
      });
    },

    async renameProject(input) {
      return withWorkspaceQueue(store.path, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseWorkspaceRevision);
        requireRegistered(workspace, input.projectId);
        const name = input.name.trim();
        if (name.length === 0) throw new TypeError("Project name is required");
        const timestamp = input.now ?? clock();
        const currentProject = await projectRepository.read(input.projectId);
        if (currentProject.revision !== input.baseProjectRevision) {
          throw new ProjectRevisionConflictError({
            projectId: input.projectId,
            revision: currentProject.revision,
            updatedAt: currentProject.updatedAt,
          });
        }
        const project = normalizeProjectDocument({
          ...structuredClone(currentProject),
          name,
          revision: currentProject.revision + 1,
          updatedAt: timestamp,
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
        if (
          !store.compareAndSwapProjectWithWorkspace(
            workspace.revision,
            currentProject.revision,
            nextWorkspace,
            project,
          )
        ) {
          const latestWorkspace = store.readWorkspace();
          if (latestWorkspace?.revision !== workspace.revision) {
            throw new WorkspaceRevisionConflictError(latestWorkspace?.revision ?? 0);
          }
          const latestProject = store.readProject(input.projectId);
          if (latestProject === undefined) throw new ProjectNotFoundError(input.projectId);
          throw new ProjectRevisionConflictError({
            projectId: input.projectId,
            revision: latestProject.revision,
            updatedAt: latestProject.updatedAt,
          });
        }
        return { workspace: nextWorkspace, project };
      });
    },

    async deleteProject(input) {
      return withWorkspaceQueue(store.path, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseRevision);
        requireRegistered(workspace, input.projectId);
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
        const trashStatus = store.moveProjectToTrashWithWorkspace(
          workspace.revision,
          nextWorkspace,
          input.projectId,
          input.trashTimestamp,
        );
        if (trashStatus === "conflict") {
          throw new WorkspaceRevisionConflictError(store.readWorkspace()?.revision ?? 0);
        }
        const trash: TrashProjectResult =
          trashStatus === "moved"
            ? {
                status: "moved",
                trashPath: `${store.path}#project-trash/${input.trashTimestamp}/${input.projectId}`,
              }
            : { status: "missing" };
        return { workspace: nextWorkspace, trash };
      });
    },

    async importLegacyProject(input) {
      return withWorkspaceQueue(store.path, async () => {
        const { workspace } = await readWorkspaceUnsafe();
        assertWorkspaceRevision(workspace, input.baseRevision);
        if (input.sourceDirectory === undefined && workspace.projectOrder.length > 0) {
          return { status: "not_needed", workspace };
        }
        if (workspace.projectOrder.length >= MAX_PROJECTS) {
          throw new WorkspaceProjectLimitError();
        }
        const source = await findLegacySource(input.sourceDirectory);
        if (source === undefined) return { status: "no_source", workspace };

        const parsed = JSON.parse(source.sourceBytes) as unknown;
        const detection = detectProjectContent(parsed);
        if (input.sourceDirectory !== undefined && detection.kind !== "legacy") {
          throw new Error("External project import requires a legacy schema (v0, v1, or v2)");
        }
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

        if (input.sourceDirectory !== undefined && store.hasProject(migration.document.projectId)) {
          throw new ProjectAlreadyExistsError(migration.document.projectId);
        }
        if (input.sourceDirectory !== undefined && migration.status === "migrated" &&
            migration.assets.some(({ source }) => source.startsWith("/vibescreens-assets/"))) {
          throw new Error("External legacy imports cannot contain managed workspace asset URLs");
        }

        let project: ProjectDocumentV3;
        let warnings: Array<MigrationIssue | AssetMigrationWarning> = [];
        if (migration.status === "migrated") {
          const materialized = await materializeLegacyAssets(migration, {
            rootDirectory: input.sourceDirectory ?? options.rootDir,
            store: (asset) => storeAsset({ ...asset, rootDir: options.rootDir }),
            requireAllAssets: input.sourceDirectory !== undefined,
          });
          project = materialized.document;
          warnings = materialized.warnings;
        } else {
          project = migration.document;
        }

        await writeExactBackup(backupPath, source.sourceBytes);
        const migratedProject = normalizeProjectDocument(project);
        const existingProject = store.readProject(migratedProject.projectId);
        let persistedProject: ProjectDocumentV3;
        let nextWorkspace: WorkspaceRegistry;
        if (existingProject !== undefined) {
          const existing = normalizeProjectDocument(existingProject);
          if (
            existing.migration?.sourceSha256 !== sourceSha256 &&
            JSON.stringify(existing) !== JSON.stringify(migratedProject)
          ) {
            throw new ProjectAlreadyExistsError(migratedProject.projectId);
          }
          persistedProject = existing;
          nextWorkspace = registerProject(workspace, persistedProject, migratedAt);
          if (
            !store.compareAndSwapProjectWithWorkspace(
              workspace.revision,
              existing.revision,
              nextWorkspace,
              existing,
            )
          ) {
            const latestWorkspace = store.readWorkspace();
            if (latestWorkspace?.revision !== workspace.revision) {
              throw new WorkspaceRevisionConflictError(latestWorkspace?.revision ?? 0);
            }
            const latestProject = store.readProject(existing.projectId);
            if (latestProject === undefined) {
              throw new OrphanedProjectError(existing.projectId);
            }
            const latest = normalizeProjectDocument(latestProject);
            if (latest.revision !== existing.revision) {
              throw new ProjectRevisionConflictError({
                projectId: latest.projectId,
                revision: latest.revision,
                updatedAt: latest.updatedAt,
              });
            }
            throw new WorkspaceRevisionConflictError(latestWorkspace?.revision ?? 0);
          }
        } else {
          persistedProject = migratedProject;
          nextWorkspace = registerProject(workspace, persistedProject, migratedAt);
          if (
            !store.createProjectWithWorkspace(
              workspace.revision,
              nextWorkspace,
              persistedProject,
            )
          ) {
            const latestWorkspace = store.readWorkspace();
            if (latestWorkspace?.revision !== workspace.revision) {
              throw new WorkspaceRevisionConflictError(latestWorkspace?.revision ?? 0);
            }
            if (store.hasProject(persistedProject.projectId)) {
              throw new ProjectAlreadyExistsError(persistedProject.projectId);
            }
            throw new WorkspaceRevisionConflictError(latestWorkspace?.revision ?? 0);
          }
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
