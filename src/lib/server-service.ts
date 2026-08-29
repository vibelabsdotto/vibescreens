import { rm } from "node:fs/promises";
import { join } from "node:path";

import { cloneVersionAssets as cloneStoredVersionAssets } from "./asset-store";
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
  createApp,
  createDeck,
  createProjectDocument,
  createVersion,
  deleteApp,
  deleteDeck,
  deleteVersion,
  publishVersion,
  renameApp,
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
  appCount: number;
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
      action: "createApp";
      baseRevision: number;
      name: string;
      versionName?: string;
      initialDeck: DeckInput;
    }
  | {
      action: "renameApp";
      baseRevision: number;
      appId: AppId;
      name: string;
    }
  | { action: "deleteApp"; baseRevision: number; appId: AppId }
  | {
      action: "createVersion";
      baseRevision: number;
      appId: AppId;
      name: string;
      initialDeck: DeckInput;
    }
  | {
      action: "cloneVersion";
      baseRevision: number;
      appId: AppId;
      sourceVersionId: VersionId;
      name: string;
    }
  | {
      action: "renameVersion";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
      name: string;
    }
  | {
      action: "publishVersion";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
    }
  | {
      action: "deleteVersion";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
    }
  | {
      action: "createDeck";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
      deck: DeckInput;
    }
  | {
      action: "updateDeck";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
      deckId: DeckId;
      changes: Partial<Omit<DeckRecord, "id">>;
    }
  | {
      action: "deleteDeck";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
      deckId: DeckId;
    }
  | {
      action: "selectAppVersion";
      baseRevision: number;
      appId: AppId;
      versionId: VersionId;
      deckId?: DeckId;
      slideId?: string;
    }
  | {
      action: "selectDeck";
      baseRevision: number;
      appId: AppId;
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
  ): Promise<{ project: ProjectDocumentV3 }>;
}

export interface WorkspaceProjectServiceOptions {
  rootDir?: string;
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
    options.projectRepository ?? createProjectRepository({ rootDir, now: clock });
  const workspaceRepository =
    options.workspaceRepository ??
    createWorkspaceRepository({
      rootDir,
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
            appCount: project.appOrder.length,
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
          const importResult = await workspaceRepository.importLegacyProject(command);
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
      await requireRegisteredProject(projectId);

      const commandTimestamp = clock();
      let clonedAssetDirectory: string | undefined;
      const removedAssetDirectories: string[] = [];
      try {
        const project = await projectRepository.mutate({
          projectId,
          baseRevision: command.baseRevision,
          now: commandTimestamp,
          mutate: async (current) => {
            const now = commandTimestamp;
            switch (command.action) {
              case "createApp": {
                assertName(command.name);
                assertOptionalString(command.versionName, "versionName");
                assertRecord(command.initialDeck, "initialDeck");
                return createApp(current, command.name, command.initialDeck, {
                  appId: appIdFactory(),
                  versionId: versionIdFactory(),
                  versionName: command.versionName,
                  deckId: deckIdFactory(),
                  now,
                });
              }
              case "renameApp":
                assertAppId(command.appId);
                assertName(command.name);
                return renameApp(current, command.appId, command.name, { now });
              case "deleteApp": {
                assertAppId(command.appId);
                // Snapshot every version directory still on disk BEFORE the
                // document mutation; the reply below removes them with the
                // owning entities instead of stranding public asset files.
                for (const versionId of Object.keys(
                  current.appsById[command.appId]?.versionsById ?? {},
                )) {
                  removedAssetDirectories.push(
                    versionAssetDirectory(
                      rootDir,
                      projectId,
                      command.appId,
                      versionId as VersionId,
                    ),
                  );
                }
                return deleteApp(current, command.appId, { now });
              }
              case "createVersion":
                assertAppId(command.appId);
                assertName(command.name);
                assertRecord(command.initialDeck, "initialDeck");
                return createVersion(
                  current,
                  command.appId,
                  command.name,
                  command.initialDeck,
                  {
                    versionId: versionIdFactory(),
                    deckId: deckIdFactory(),
                    now,
                  },
                );
              case "cloneVersion": {
                assertAppId(command.appId);
                assertVersionId(command.sourceVersionId);
                assertName(command.name);
                const targetVersionId = versionIdFactory();
                const candidate = cloneVersion(
                  current,
                  command.appId,
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
                  command.appId,
                  command.sourceVersionId,
                );
                await cloneAssets({
                  rootDir,
                  projectId,
                  appId: command.appId,
                  sourceVersionId: command.sourceVersionId,
                  targetVersionId,
                  assets: Object.values(sourceAssets),
                });
                clonedAssetDirectory = versionAssetDirectory(
                  rootDir,
                  projectId,
                  command.appId,
                  targetVersionId,
                );
                return candidate;
              }
              case "renameVersion":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                assertName(command.name);
                return renameVersion(
                  current,
                  command.appId,
                  command.versionId,
                  command.name,
                  { now },
                );
              case "publishVersion":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                return publishVersion(current, command.appId, command.versionId, { now });
              case "deleteVersion": {
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                removedAssetDirectories.push(
                  versionAssetDirectory(
                    rootDir,
                    projectId,
                    command.appId,
                    command.versionId,
                  ),
                );
                return deleteVersion(current, command.appId, command.versionId, { now });
              }
              case "createDeck":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                assertRecord(command.deck, "deck");
                return createDeck(current, command.appId, command.versionId, command.deck, {
                  deckId: deckIdFactory(),
                  now,
                });
              case "updateDeck":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                assertDeckId(command.deckId);
                assertRecord(command.changes, "changes");
                return updateDeck(
                  current,
                  command.appId,
                  command.versionId,
                  command.deckId,
                  command.changes,
                  { now },
                );
              case "deleteDeck":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                assertDeckId(command.deckId);
                return deleteDeck(
                  current,
                  command.appId,
                  command.versionId,
                  command.deckId,
                  { now },
                );
              case "selectAppVersion":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                if (command.deckId !== undefined) assertDeckId(command.deckId);
                assertOptionalString(command.slideId, "slideId");
                return selectAppVersion(
                  current,
                  command.appId,
                  command.versionId,
                  command.deckId,
                  { now, slideId: command.slideId },
                );
              case "selectDeck":
                assertAppId(command.appId);
                assertVersionId(command.versionId);
                assertDeckId(command.deckId);
                assertOptionalString(command.slideId, "slideId");
                return selectDeck(
                  current,
                  command.appId,
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
        // Committed: the document no longer owns these versions, so their
        // asset files must not stay publicly reachable under public/.
        await Promise.all(
          removedAssetDirectories.splice(0).map((directory) => removeAssets(directory)),
        );
        return { project };
      } catch (error) {
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
