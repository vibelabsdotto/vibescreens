import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSafeAssetStorageRoot,
  cloneVersionAssets as cloneStoredVersionAssets,
} from "./asset-store";
import { DEFAULT_SCREENSHOT_FONT_ID } from "./constants";
import { DEFAULT_PROJECT } from "./defaults";
import {
  assertAppId,
  assertDeckId,
  assertVersionId,
  createAppId,
  createDeckId,
  createVersionId,
  type AppId,
  type DeckId,
  type VersionId,
} from "./ids";
import {
  cloneVersion,
  createDeck,
  createProjectDocument,
  createVersion,
  deleteDeck,
  deleteVersion,
  publishVersion,
  renameVersion,
  selectAppVersion,
  selectDeck,
  updateDeck,
  type DeckInput,
} from "./project-operations";
import {
  createProjectRepository,
  type ProjectRepository,
  type SaveDraftInput,
} from "./project-repository";
import {
  assetsForVersion,
  type DeckRecord,
  type ProjectDocumentV3,
} from "./project-schema";
import {
  createSqliteDocumentStore,
  type SqliteDocumentStore,
} from "./sqlite-storage";
import {
  assertProjectId,
  createProjectId,
  type ProjectId,
  type WorkspaceRegistry,
} from "./workspace";
import {
  createWorkspaceRepository,
  type ImportLegacyProjectResult,
  type WorkspaceRepository,
} from "./workspace-repository";

export interface ProjectSummary {
  projectId: ProjectId;
  name: string;
  revision: number;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  workspace: WorkspaceRegistry;
  projects: ProjectSummary[];
}

export interface CreateWorkspaceCommand {
  action: "create";
  baseRevision: number;
  name: string;
}

export interface SwitchWorkspaceCommand {
  action: "switch";
  baseRevision: number;
  projectId: ProjectId;
}

export interface RenameWorkspaceCommand {
  action: "rename";
  baseWorkspaceRevision: number;
  baseProjectRevision: number;
  projectId: ProjectId;
  name: string;
}

export interface DeleteWorkspaceCommand {
  action: "delete";
  baseRevision: number;
  projectId: ProjectId;
}

export interface ImportLegacyWorkspaceCommand {
  action: "importLegacy";
  baseRevision: number;
}

export type WorkspaceCommand =
  | CreateWorkspaceCommand
  | SwitchWorkspaceCommand
  | RenameWorkspaceCommand
  | DeleteWorkspaceCommand
  | ImportLegacyWorkspaceCommand;

export type ProjectCommand =
  | {
      action: "createVersion";
      baseRevision: number;
      name: string;
      initialDeck: DeckInput;
    }
  | {
      action: "cloneVersion";
      baseRevision: number;
      sourceVersionId: VersionId;
      name: string;
    }
  | {
      action: "renameVersion";
      baseRevision: number;
      versionId: VersionId;
      name: string;
    }
  | {
      action: "publishVersion";
      baseRevision: number;
      versionId: VersionId;
    }
  | {
      action: "deleteVersion";
      baseRevision: number;
      versionId: VersionId;
    }
  | {
      action: "createDeck";
      baseRevision: number;
      versionId: VersionId;
      deck: DeckInput;
    }
  | {
      action: "updateDeck";
      baseRevision: number;
      versionId: VersionId;
      deckId: DeckId;
      changes: Partial<Omit<DeckRecord, "id">>;
    }
  | {
      action: "deleteDeck";
      baseRevision: number;
      versionId: VersionId;
      deckId: DeckId;
    }
  | {
      action: "selectVersion";
      baseRevision: number;
      versionId: VersionId;
      deckId?: DeckId;
      slideId?: string;
    }
  | {
      action: "selectDeck";
      baseRevision: number;
      versionId: VersionId;
      deckId: DeckId;
      slideId?: string;
    };

export type WorkspaceCommandResult<C extends WorkspaceCommand> =
  C extends CreateWorkspaceCommand
    ? { workspace: WorkspaceRegistry; project: ProjectDocumentV3 }
    : C extends SwitchWorkspaceCommand
      ? { workspace: WorkspaceRegistry }
      : C extends RenameWorkspaceCommand
        ? { workspace: WorkspaceRegistry; project: ProjectDocumentV3 }
        : C extends DeleteWorkspaceCommand
          ? {
              workspace: WorkspaceRegistry;
              trash: Awaited<
                ReturnType<WorkspaceRepository["deleteProject"]>
              >["trash"];
            }
          : C extends ImportLegacyWorkspaceCommand
            ? {
                workspace: WorkspaceRegistry;
                importResult: ImportLegacyProjectResult;
              }
            : never;

export interface WorkspaceProjectService {
  getWorkspace(): Promise<WorkspaceSnapshot>;
  getProject(projectId: ProjectId): Promise<ProjectDocumentV3>;
  saveProject(input: SaveDraftInput): Promise<ProjectDocumentV3>;
  executeWorkspaceCommand<C extends WorkspaceCommand>(
    command: C,
  ): Promise<WorkspaceCommandResult<C>>;
  executeProjectCommand(
    projectId: ProjectId,
    command: ProjectCommand,
  ): Promise<{ project: ProjectDocumentV3; assetCleanupPending?: boolean }>;
}

export interface WorkspaceProjectServiceOptions {
  rootDir?: string;
  store?: SqliteDocumentStore;
  workspaceRepository?: WorkspaceRepository;
  projectRepository?: ProjectRepository;
  now?: () => string;
  createProjectId?: () => ProjectId;
  createAppId?: () => AppId;
  createVersionId?: () => VersionId;
  createDeckId?: () => DeckId;
  createInitialDeck?: () => DeckInput;
  cloneVersionAssets?: typeof cloneStoredVersionAssets;
  /** Removes a version's managed asset directory (after app/version deletes). */
  removeVersionAssets?: (directory: string) => Promise<void>;
}

function defaultInitialDeck(): DeckInput {
  const device = DEFAULT_PROJECT.device;
  return {
    device,
    orientation: DEFAULT_PROJECT.orientation,
    locale: DEFAULT_PROJECT.locale,
    connectedCanvas: DEFAULT_PROJECT.connectedCanvas,
    appName: DEFAULT_PROJECT.appName,
    themeId: DEFAULT_PROJECT.themeId,
    fontId: DEFAULT_PROJECT.fontId ?? DEFAULT_SCREENSHOT_FONT_ID,
    importedFont: DEFAULT_PROJECT.importedFont,
    appIcon: DEFAULT_PROJECT.appIcon ?? "",
    slides: structuredClone(DEFAULT_PROJECT.slidesByDevice[device]),
  };
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be an integer >= 0`);
  }
}

function assertName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Name is required");
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function trashTimestamp(timestamp: string): string {
  return timestamp.replace(/[^A-Za-z0-9_-]/g, "");
}

function versionAssetDirectory(
  rootDir: string,
  projectId: ProjectId,
  appId: AppId,
  versionId: VersionId,
): string {
  assertProjectId(projectId);
  assertAppId(appId);
  assertVersionId(versionId);
  return join(
    rootDir,
    "public",
    "vibescreens-assets",
    projectId,
    appId,
    versionId,
  );
}

export function createWorkspaceProjectService(
  options: WorkspaceProjectServiceOptions = {},
): WorkspaceProjectService {
  const rootDir = options.rootDir ?? process.cwd();
  const store = options.store ?? createSqliteDocumentStore(rootDir);
  const clock = options.now ?? (() => new Date().toISOString());
  const projectIdFactory = options.createProjectId ?? createProjectId;
  const appIdFactory = options.createAppId ?? createAppId;
  const versionIdFactory = options.createVersionId ?? createVersionId;
  const deckIdFactory = options.createDeckId ?? createDeckId;
  const initialDeckFactory = options.createInitialDeck ?? defaultInitialDeck;
  const cloneAssets = options.cloneVersionAssets ?? cloneStoredVersionAssets;
  const removeAssets =
    options.removeVersionAssets ??
    (async (directory: string) => {
      await rm(directory, { recursive: true, force: true });
    });
  const projectRepository =
    options.projectRepository ?? createProjectRepository({ rootDir, store, now: clock });
  const workspaceRepository =
    options.workspaceRepository ??
    createWorkspaceRepository({
      rootDir,
      store,
      projectRepository,
      createProjectId: projectIdFactory,
      now: clock,
      createInitialProject: ({ projectId, name, now }) =>
        createProjectDocument(initialDeckFactory(), {
          projectId,
          projectName: name,
          appId: appIdFactory(),
          appName: name,
          versionId: versionIdFactory(),
          versionName: "Draft 1",
          deckId: deckIdFactory(),
          now,
        }),
    });

  const requireRegisteredProject = async (projectId: ProjectId) => {
    assertProjectId(projectId);
    return workspaceRepository.readProject(projectId);
  };

  const service: WorkspaceProjectService = {
    async getWorkspace() {
      const workspace = await workspaceRepository.load();
      const projects = await Promise.all(
        workspace.projectOrder.map(async (projectId): Promise<ProjectSummary> => {
          const project = await workspaceRepository.readProject(projectId);
          return {
            projectId,
            name: project.name,
            revision: project.revision,
            updatedAt: project.updatedAt,
          };
        }),
      );
      return { workspace, projects };
    },

    async getProject(projectId) {
      return requireRegisteredProject(projectId);
    },

    async saveProject(input) {
      assertProjectId(input.projectId);
      assertRevision(input.baseRevision, "baseRevision");
      assertRecord(input.document, "document");
      await requireRegisteredProject(input.projectId);
      return projectRepository.saveDraft(input);
    },

    async executeWorkspaceCommand<C extends WorkspaceCommand>(
      command: C,
    ): Promise<WorkspaceCommandResult<C>> {
      assertRecord(command, "Workspace command");
      switch (command.action) {
        case "create": {
          assertRevision(command.baseRevision, "baseRevision");
          assertName(command.name);
          return (await workspaceRepository.createProject(command)) as WorkspaceCommandResult<C>;
        }
        case "switch": {
          assertRevision(command.baseRevision, "baseRevision");
          assertProjectId(command.projectId);
          return {
            workspace: await workspaceRepository.switchProject(command),
          } as WorkspaceCommandResult<C>;
        }
        case "rename": {
          assertRevision(command.baseWorkspaceRevision, "baseWorkspaceRevision");
          assertRevision(command.baseProjectRevision, "baseProjectRevision");
          assertProjectId(command.projectId);
          assertName(command.name);
          return (await workspaceRepository.renameProject(command)) as WorkspaceCommandResult<C>;
        }
        case "delete": {
          assertRevision(command.baseRevision, "baseRevision");
          assertProjectId(command.projectId);
          return (await workspaceRepository.deleteProject({
            ...command,
            trashTimestamp: trashTimestamp(clock()),
          })) as WorkspaceCommandResult<C>;
        }
        case "importLegacy": {
          assertRevision(command.baseRevision, "baseRevision");
          const importResult = await workspaceRepository.importLegacyProject({
            baseRevision: command.baseRevision,
          });
          const workspace =
            "workspace" in importResult
              ? importResult.workspace
              : await workspaceRepository.load();
          return { workspace, importResult } as WorkspaceCommandResult<C>;
        }
        default:
          throw new TypeError(
            `Unsupported workspace action: ${String((command as { action?: unknown }).action)}`,
          );
      }
    },

    async executeProjectCommand(projectId, command) {
      assertProjectId(projectId);
      assertRecord(command, "Project command");
      assertRevision(command.baseRevision, "baseRevision");
      const registeredProject = await requireRegisteredProject(projectId);
      if (command.action === "deleteVersion") {
        assertVersionId(command.versionId);
        await assertSafeAssetStorageRoot(rootDir, [
          projectId,
          registeredProject.selection.appId,
          command.versionId,
        ]);
      }

      const commandTimestamp = clock();
      let clonedAssetDirectory: string | undefined;
      let stagedVersionAssets:
        | { sourceDirectory: string; stagedDirectory: string }
        | undefined;
      let projectCommitted = false;
      try {
        if (command.action === "deleteVersion") {
          const sourceDirectory = versionAssetDirectory(
            rootDir,
            projectId,
            registeredProject.selection.appId,
            command.versionId,
          );
          const stagedDirectory = `${sourceDirectory}.trash-${randomUUID()}`;
          try {
            await rename(sourceDirectory, stagedDirectory);
            stagedVersionAssets = { sourceDirectory, stagedDirectory };
          } catch (error) {
            if (!isNotFoundError(error)) throw error;
          }
        }
        const project = await projectRepository.mutate({
          projectId,
          baseRevision: command.baseRevision,
          now: commandTimestamp,
          mutate: async (current) => {
            const now = commandTimestamp;
            const appId = current.selection.appId;
            assertAppId(appId);
            switch (command.action) {
              case "createVersion":
                assertName(command.name);
                assertRecord(command.initialDeck, "initialDeck");
                return createVersion(
                  current,
                  appId,
                  command.name,
                  command.initialDeck,
                  {
                    versionId: versionIdFactory(),
                    deckId: deckIdFactory(),
                    now,
                  },
                );
              case "cloneVersion": {
                assertVersionId(command.sourceVersionId);
                assertName(command.name);
                const targetVersionId = versionIdFactory();
                const candidate = cloneVersion(
                  current,
                  appId,
                  command.sourceVersionId,
                  command.name,
                  { versionId: targetVersionId, now },
                );
                // Scoped registered assets force the size/hash-verified copy
                // branch; cloning without them would silently succeed even
                // when source files are missing and commit rewritten URLs
                // that point at nonexistent files.
                const sourceAssets = assetsForVersion(
                  current,
                  appId,
                  command.sourceVersionId,
                );
                await cloneAssets({
                  rootDir,
                  projectId,
                  appId: appId,
                  sourceVersionId: command.sourceVersionId,
                  targetVersionId,
                  assets: Object.values(sourceAssets),
                });
                clonedAssetDirectory = versionAssetDirectory(
                  rootDir,
                  projectId,
                  appId,
                  targetVersionId,
                );
                return candidate;
              }
              case "renameVersion":
                assertVersionId(command.versionId);
                assertName(command.name);
                return renameVersion(
                  current,
                  appId,
                  command.versionId,
                  command.name,
                  { now },
                );
              case "publishVersion":
                assertVersionId(command.versionId);
                return publishVersion(current, appId, command.versionId, { now });
              case "deleteVersion": {
                assertVersionId(command.versionId);
                return deleteVersion(current, appId, command.versionId, { now });
              }
              case "createDeck":
                assertVersionId(command.versionId);
                assertRecord(command.deck, "deck");
                return createDeck(current, appId, command.versionId, command.deck, {
                  deckId: deckIdFactory(),
                  now,
                });
              case "updateDeck":
                assertVersionId(command.versionId);
                assertDeckId(command.deckId);
                assertRecord(command.changes, "changes");
                return updateDeck(
                  current,
                  appId,
                  command.versionId,
                  command.deckId,
                  command.changes,
                  { now },
                );
              case "deleteDeck":
                assertVersionId(command.versionId);
                assertDeckId(command.deckId);
                return deleteDeck(
                  current,
                  appId,
                  command.versionId,
                  command.deckId,
                  { now },
                );
              case "selectVersion":
                assertVersionId(command.versionId);
                if (command.deckId !== undefined) assertDeckId(command.deckId);
                assertOptionalString(command.slideId, "slideId");
                return selectAppVersion(
                  current,
                  appId,
                  command.versionId,
                  command.deckId,
                  { now, slideId: command.slideId },
                );
              case "selectDeck":
                assertVersionId(command.versionId);
                assertDeckId(command.deckId);
                assertOptionalString(command.slideId, "slideId");
                return selectDeck(
                  current,
                  appId,
                  command.versionId,
                  command.deckId,
                  { now, slideId: command.slideId },
                );
              default:
                throw new TypeError(
                  `Unsupported project action: ${String(
                    (command as { action?: unknown }).action,
                  )}`,
                );
            }
          },
        });
        projectCommitted = true;
        let assetCleanupPending = false;
        if (stagedVersionAssets !== undefined) {
          try {
            await removeAssets(stagedVersionAssets.stagedDirectory);
          } catch {
            assetCleanupPending = true;
          }
        }
        return {
          project,
          ...(assetCleanupPending ? { assetCleanupPending: true } : {}),
        };
      } catch (error) {
        if (stagedVersionAssets !== undefined && !projectCommitted) {
          try {
            await rename(
              stagedVersionAssets.stagedDirectory,
              stagedVersionAssets.sourceDirectory,
            );
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Version deletion failed and staged assets could not be restored",
            );
          }
        }
        if (clonedAssetDirectory !== undefined) {
          try {
            await rm(clonedAssetDirectory, { recursive: true, force: true });
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Version clone failed and copied assets could not be removed",
            );
          }
        }
        throw error;
      }
    },
  };

  return service;
}
