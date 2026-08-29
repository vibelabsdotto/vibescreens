import type { AppId, DeckId, VersionId } from "./ids";
import type { DeckRecord, ProjectDocumentV3 } from "./project-schema";
import type { ProjectId, WorkspaceRegistry } from "./workspace";

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

export type DeckInput = Omit<DeckRecord, "id"> & { id?: DeckId };

export type WorkspaceCommand =
  | { action: "create"; baseRevision: number; name: string }
  | { action: "switch"; baseRevision: number; projectId: ProjectId }
  | {
      action: "rename";
      baseWorkspaceRevision: number;
      baseProjectRevision: number;
      projectId: ProjectId;
      name: string;
    }
  | { action: "delete"; baseRevision: number; projectId: ProjectId }
  | { action: "importLegacy"; baseRevision: number };

export type ProjectCommand =
  | {
      action: "createApp";
      baseRevision: number;
      name: string;
      versionName?: string;
      initialDeck: DeckInput;
    }
  | { action: "renameApp"; baseRevision: number; appId: AppId; name: string }
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

export type MigrationStatus =
  | "not_needed"
  | "imported"
  | "no_source"
  | "unsupported"
  | "blocked";

export type LegacyImportResult =
  | {
      status: "imported";
      workspace: WorkspaceRegistry;
      project: ProjectDocumentV3;
      sourceFile: "vibescreens.json" | "app-store-screenshots.json";
      backupPath: string;
      warnings: unknown[];
    }
  | { status: "not_needed"; workspace: WorkspaceRegistry }
  | { status: "no_source"; workspace: WorkspaceRegistry }
  | {
      status: "unsupported";
      schemaVersion: number;
      readOnly: true;
      sourceFile: "vibescreens.json" | "app-store-screenshots.json";
    }
  | {
      status: "blocked";
      sourceFile: "vibescreens.json" | "app-store-screenshots.json";
      blockers: unknown[];
      warnings: unknown[];
    };

export type WorkspaceCommandResult<C extends WorkspaceCommand> =
  C extends { action: "create" }
    ? { workspace: WorkspaceRegistry; project: ProjectDocumentV3 }
    : C extends { action: "rename" }
      ? { workspace: WorkspaceRegistry; project: ProjectDocumentV3 }
      : C extends { action: "delete" }
        ? { workspace: WorkspaceRegistry; trash: unknown }
        : C extends { action: "importLegacy" }
          ? { workspace: WorkspaceRegistry; importResult: LegacyImportResult }
          : { workspace: WorkspaceRegistry };

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ApiErrorBody {
  ok: false;
  code?: string;
  error?: string;
  current?: unknown;
}

export class WorkspaceClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body?: unknown;

  constructor(message: string, status: number, code: string, body?: unknown) {
    super(message);
    this.name = "WorkspaceClientError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class WorkspaceConflictError extends WorkspaceClientError {
  readonly current: unknown;

  constructor(message: string, code: string, current: unknown, body?: unknown) {
    super(message, 409, code, body);
    this.name = "WorkspaceConflictError";
    this.current = current;
  }
}

export class WorkspaceAbortError extends WorkspaceClientError {
  constructor() {
    super("Request was aborted", 0, "aborted");
    this.name = "WorkspaceAbortError";
  }
}

export class WorkspaceFutureSchemaError extends WorkspaceClientError {
  readonly readOnly = true;

  constructor(
    readonly scope: "workspace" | "project",
    readonly schemaVersion: number,
  ) {
    super(
      `${scope === "workspace" ? "Workspace" : "Project"} schema ${schemaVersion} is newer than this editor supports`,
      200,
      "unsupported_schema",
    );
    this.name = "WorkspaceFutureSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (isRecord(error) && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function parseResponse<T extends Record<string, unknown>>(
  response: Response,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WorkspaceClientError(
      "Server returned invalid JSON",
      response.status,
      "invalid_response",
    );
  }
  if (!isRecord(body) || typeof body.ok !== "boolean") {
    throw new WorkspaceClientError(
      "Server returned an invalid response envelope",
      response.status,
      "invalid_response",
      body,
    );
  }
  if (!response.ok || body.ok !== true) {
    const errorBody = body as unknown as ApiErrorBody;
    const code =
      typeof errorBody.code === "string" ? errorBody.code : "request_failed";
    const message =
      typeof errorBody.error === "string"
        ? errorBody.error
        : `Request failed with HTTP ${response.status}`;
    if (
      response.status === 409 &&
      (code === "project_revision_conflict" || code === "workspace_revision_conflict")
    ) {
      throw new WorkspaceConflictError(
        message,
        code,
        errorBody.current,
        body,
      );
    }
    throw new WorkspaceClientError(message, response.status, code, body);
  }
  return body as T;
}

function assertWorkspaceSnapshot(body: Record<string, unknown>): WorkspaceSnapshot {
  if (!isRecord(body.workspace)) {
    throw new WorkspaceClientError(
      "Workspace response is missing workspace data",
      200,
      "invalid_response",
      body,
    );
  }
  const schemaVersion = body.workspace.schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion > 1) {
    throw new WorkspaceFutureSchemaError("workspace", schemaVersion);
  }
  if (
    schemaVersion !== 1 ||
    !Number.isInteger(body.workspace.revision) ||
    !Array.isArray(body.workspace.projectOrder) ||
    !isRecord(body.workspace.projectsById) ||
    !Array.isArray(body.projects)
  ) {
    throw new WorkspaceClientError(
      "Workspace response has an invalid shape",
      200,
      "invalid_response",
      body,
    );
  }
  return {
    workspace: body.workspace as unknown as WorkspaceRegistry,
    projects: body.projects as ProjectSummary[],
  };
}

function assertProjectResponse(body: Record<string, unknown>): ProjectDocumentV3 {
  if (!isRecord(body.project)) {
    throw new WorkspaceClientError(
      "Project response is missing project data",
      200,
      "invalid_response",
      body,
    );
  }
  const schemaVersion = body.project.schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion > 3) {
    throw new WorkspaceFutureSchemaError("project", schemaVersion);
  }
  if (
    schemaVersion !== 3 ||
    typeof body.project.projectId !== "string" ||
    !Number.isInteger(body.project.revision) ||
    !Array.isArray(body.project.appOrder) ||
    !isRecord(body.project.appsById) ||
    !isRecord(body.project.selection)
  ) {
    throw new WorkspaceClientError(
      "Project response has an invalid shape",
      200,
      "invalid_response",
      body,
    );
  }
  return body.project as unknown as ProjectDocumentV3;
}

async function request<T extends Record<string, unknown>>(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<T> {
  try {
    return await parseResponse<T>(await fetcher(input, init));
  } catch (error) {
    if (isAbortLike(error, init.signal ?? undefined)) {
      throw new WorkspaceAbortError();
    }
    if (error instanceof WorkspaceClientError) throw error;
    throw new WorkspaceClientError(
      error instanceof Error ? error.message : "Network request failed",
      0,
      "network_error",
      error,
    );
  }
}

export interface WorkspaceClient {
  getWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot>;
  getProject(projectId: ProjectId, signal?: AbortSignal): Promise<ProjectDocumentV3>;
  saveProject(
    projectId: ProjectId,
    baseRevision: number,
    document: ProjectDocumentV3,
    signal?: AbortSignal,
  ): Promise<ProjectDocumentV3>;
  executeWorkspaceCommand<C extends WorkspaceCommand>(
    command: C,
    signal?: AbortSignal,
  ): Promise<WorkspaceCommandResult<C>>;
  executeProjectCommand(
    projectId: ProjectId,
    command: ProjectCommand,
    signal?: AbortSignal,
  ): Promise<{ project: ProjectDocumentV3 }>;
}

export function createWorkspaceClient(
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): WorkspaceClient {
  return {
    async getWorkspace(signal) {
      const body = await request<Record<string, unknown>>(
        fetcher,
        "/api/workspace",
        { cache: "no-store", signal },
      );
      return assertWorkspaceSnapshot(body);
    },

    async getProject(projectId, signal) {
      const body = await request<Record<string, unknown>>(
        fetcher,
        `/api/project?projectId=${encodeURIComponent(projectId)}`,
        { cache: "no-store", signal },
      );
      return assertProjectResponse(body);
    },

    async saveProject(projectId, baseRevision, document, signal) {
      const body = await request<Record<string, unknown>>(
        fetcher,
        `/api/project?projectId=${encodeURIComponent(projectId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision, document }),
          signal,
        },
      );
      return assertProjectResponse(body);
    },

    async executeWorkspaceCommand<C extends WorkspaceCommand>(
      command: C,
      signal?: AbortSignal,
    ): Promise<WorkspaceCommandResult<C>> {
      const body = await request<Record<string, unknown>>(
        fetcher,
        "/api/workspace/actions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
          signal,
        },
      );
      if (!isRecord(body.workspace)) {
        throw new WorkspaceClientError(
          "Workspace action response is missing workspace data",
          200,
          "invalid_response",
          body,
        );
      }
      return body as unknown as WorkspaceCommandResult<C>;
    },

    async executeProjectCommand(projectId, command, signal) {
      const body = await request<Record<string, unknown>>(
        fetcher,
        `/api/project/actions?projectId=${encodeURIComponent(projectId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
          signal,
        },
      );
      return { project: assertProjectResponse(body) };
    },
  };
}

const PROJECT_CACHE_PREFIX = "vibescreens:project-cache:v1:";

export function projectCacheKey(projectId: ProjectId, revision: number): string {
  return `${PROJECT_CACHE_PREFIX}${projectId}:revision:${revision}`;
}

export function readCachedProject(
  storage: Storage,
  projectId: ProjectId,
  revision: number,
): ProjectDocumentV3 | null {
  const key = projectCacheKey(projectId, revision);
  const serialized = storage.getItem(key);
  if (serialized === null) return null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 3 ||
      parsed.projectId !== projectId ||
      parsed.revision !== revision
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed as unknown as ProjectDocumentV3;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function cacheKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(PROJECT_CACHE_PREFIX)) keys.push(key);
  }
  return keys;
}

export function cacheProject(storage: Storage, project: ProjectDocumentV3): void {
  const currentKey = projectCacheKey(project.projectId, project.revision);
  const projectPrefix = `${PROJECT_CACHE_PREFIX}${project.projectId}:revision:`;
  for (const key of cacheKeys(storage)) {
    if (key.startsWith(projectPrefix) && key !== currentKey) storage.removeItem(key);
  }
  storage.setItem(currentKey, JSON.stringify(project));
}

export function evictStaleProjectCache(
  storage: Storage,
  projects: readonly ProjectSummary[],
): void {
  const currentKeys = new Set(
    projects.map((project) =>
      projectCacheKey(project.projectId, project.revision),
    ),
  );
  for (const key of cacheKeys(storage)) {
    if (!currentKeys.has(key)) storage.removeItem(key);
  }
}

interface WorkspaceLoaderClient {
  getWorkspace(signal?: AbortSignal): Promise<WorkspaceSnapshot>;
  executeWorkspaceCommand(
    command: Extract<WorkspaceCommand, { action: "importLegacy" }>,
    signal?: AbortSignal,
  ): Promise<
    WorkspaceCommandResult<Extract<WorkspaceCommand, { action: "importLegacy" }>>
  >;
}

export interface WorkspaceLoadResult {
  snapshot: WorkspaceSnapshot;
  migrationStatus: MigrationStatus;
  readOnly: boolean;
}

export async function loadWorkspaceWithAutoImport(
  client: WorkspaceLoaderClient,
  signal?: AbortSignal,
): Promise<WorkspaceLoadResult> {
  const snapshot = await client.getWorkspace(signal);
  if (snapshot.workspace.projectOrder.length > 0) {
    return { snapshot, migrationStatus: "not_needed", readOnly: false };
  }

  const importCommand = {
    action: "importLegacy" as const,
    baseRevision: snapshot.workspace.revision,
  };
  const result =
    signal === undefined
      ? await client.executeWorkspaceCommand(importCommand)
      : await client.executeWorkspaceCommand(importCommand, signal);
  const migrationStatus = result.importResult.status;
  if (migrationStatus === "imported") {
    return {
      snapshot: await client.getWorkspace(signal),
      migrationStatus,
      readOnly: false,
    };
  }
  return {
    snapshot: {
      workspace: result.workspace,
      projects: snapshot.projects,
    },
    migrationStatus,
    readOnly: migrationStatus === "unsupported" || migrationStatus === "blocked",
  };
}
