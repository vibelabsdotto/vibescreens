import { describe, expect, it, vi } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import type { ProjectDocumentV3 } from "../project-schema";
import type { ProjectId, WorkspaceRegistry } from "../workspace";
import {
  WorkspaceAbortError,
  WorkspaceClientError,
  WorkspaceConflictError,
  WorkspaceFutureSchemaError,
  cacheProject,
  createWorkspaceClient,
  evictStaleProjectCache,
  loadWorkspaceWithAutoImport,
  projectCacheKey,
  readCachedProject,
  type ProjectSummary,
} from "../workspace-client";

const projectId = "prj_client" as ProjectId;
const appId = "app_client" as AppId;
const versionId = "ver_client" as VersionId;
const deckId = "deck_client" as DeckId;
const now = "2026-08-28T10:00:00.000Z";

function makeWorkspace(overrides: Partial<WorkspaceRegistry> = {}): WorkspaceRegistry {
  return {
    schemaVersion: 1,
    revision: 4,
    activeProjectId: projectId,
    projectOrder: [projectId],
    projectsById: {
      [projectId]: {
        id: projectId,
        name: "Client Project",
        slug: "client-project",
        createdAt: now,
        updatedAt: now,
      },
    },
    ...overrides,
  };
}

function makeProject(revision = 7): ProjectDocumentV3 {
  return {
    schemaVersion: 3,
    projectId,
    name: "Client Project",
    revision,
    createdAt: now,
    updatedAt: now,
    appOrder: [appId],
    appsById: {
      [appId]: {
        id: appId,
        name: "Client App",
        createdAt: now,
        updatedAt: now,
        versionOrder: [versionId],
        versionsById: {
          [versionId]: {
            id: versionId,
            name: "Draft 1",
            status: "draft",
            createdAt: now,
            updatedAt: now,
            deckOrder: [deckId],
            decksById: {
              [deckId]: {
                id: deckId,
                device: "iphone",
                orientation: "portrait",
                locale: "en",
                connectedCanvas: false,
                appName: "Rendered Client App",
                themeId: "clean-light",
                fontId: "system-sans",
                appIcon: "",
                slides: [],
              },
            },
          },
        },
      },
    },
    assetsById: {},
    selection: { appId, versionId, deckId },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function summary(revision = 7): ProjectSummary {
  return {
    projectId,
    name: "Client Project",
    revision,
    updatedAt: now,
    appCount: 1,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("workspace client requests", () => {
  it("uses the fixed endpoints, query parameters, methods, and JSON payloads", async () => {
    const project = makeProject();
    const workspace = makeWorkspace();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workspace") {
        return jsonResponse({ ok: true, workspace, projects: [summary()] });
      }
      if (url === `/api/project?projectId=${projectId}` && init?.method === undefined) {
        return jsonResponse({ ok: true, project });
      }
      if (url === `/api/project?projectId=${projectId}` && init?.method === "PUT") {
        return jsonResponse({ ok: true, project: makeProject(8) });
      }
      if (url === "/api/workspace/actions") {
        return jsonResponse({ ok: true, workspace });
      }
      if (url === `/api/project/actions?projectId=${projectId}`) {
        return jsonResponse({ ok: true, project: makeProject(8) });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createWorkspaceClient(fetcher);

    await client.getWorkspace();
    await client.getProject(projectId);
    await client.saveProject(projectId, 7, project);
    await client.executeWorkspaceCommand({
      action: "switch",
      baseRevision: 4,
      projectId,
    });
    await client.executeProjectCommand(projectId, {
      action: "renameApp",
      baseRevision: 7,
      appId,
      name: "Renamed",
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/workspace",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/project?projectId=${projectId}`,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/api/project?projectId=${projectId}`,
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 7, document: project }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "/api/workspace/actions",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "switch", baseRevision: 4, projectId }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      `/api/project/actions?projectId=${projectId}`,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "renameApp",
          baseRevision: 7,
          appId,
          name: "Renamed",
        }),
      }),
    );
  });

  it("rejects malformed success envelopes instead of trusting casts", async () => {
    const client = createWorkspaceClient(async () => jsonResponse({ ok: true, workspace: null }));

    await expect(client.getWorkspace()).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceClientError>>({
        name: "WorkspaceClientError",
        code: "invalid_response",
      }),
    );
  });

  it("preserves stable 409 conflict metadata", async () => {
    const current = { projectId, revision: 12, updatedAt: now };
    const client = createWorkspaceClient(async () =>
      jsonResponse(
        {
          ok: false,
          code: "project_revision_conflict",
          error: "Revision conflict",
          current,
        },
        409,
      ),
    );

    await expect(client.saveProject(projectId, 7, makeProject())).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceConflictError>>({
        name: "WorkspaceConflictError",
        status: 409,
        code: "project_revision_conflict",
        current,
      }),
    );
  });

  it("does not treat every domain-level 409 as a revision conflict", async () => {
    const client = createWorkspaceClient(async () =>
      jsonResponse(
        {
          ok: false,
          code: "published_immutable",
          error: "Published versions cannot be renamed",
        },
        409,
      ),
    );

    const error = await client
      .executeProjectCommand(projectId, {
        action: "renameVersion",
        baseRevision: 7,
        appId,
        versionId,
        name: "Renamed",
      })
      .catch((caught: unknown) => caught);

    expect(error).toEqual(
      expect.objectContaining<Partial<WorkspaceClientError>>({
        name: "WorkspaceClientError",
        status: 409,
        code: "published_immutable",
        message: "Published versions cannot be renamed",
      }),
    );
    expect(error).not.toBeInstanceOf(WorkspaceConflictError);
  });

  it("normalizes fetch aborts into a dedicated abort error", async () => {
    const controller = new AbortController();
    const client = createWorkspaceClient(async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(client.getWorkspace(controller.signal)).rejects.toBeInstanceOf(
      WorkspaceAbortError,
    );
  });

  it("refuses a future workspace or project schema as read-only", async () => {
    const futureWorkspaceClient = createWorkspaceClient(async () =>
      jsonResponse({
        ok: true,
        workspace: { ...makeWorkspace(), schemaVersion: 2 },
        projects: [summary()],
      }),
    );
    await expect(futureWorkspaceClient.getWorkspace()).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceFutureSchemaError>>({
        name: "WorkspaceFutureSchemaError",
        scope: "workspace",
        schemaVersion: 2,
        readOnly: true,
      }),
    );

    const futureProjectClient = createWorkspaceClient(async () =>
      jsonResponse({
        ok: true,
        project: { ...makeProject(), schemaVersion: 4 },
      }),
    );
    await expect(futureProjectClient.getProject(projectId)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceFutureSchemaError>>({
        scope: "project",
        schemaVersion: 4,
        readOnly: true,
      }),
    );
  });
});

describe("workspace project cache", () => {
  it("keys cache entries by project ID and exact revision", () => {
    expect(projectCacheKey(projectId, 7)).toBe(
      "vibescreens:project-cache:v1:prj_client:revision:7",
    );
    expect(projectCacheKey(projectId, 8)).not.toBe(projectCacheKey(projectId, 7));
  });

  it("reads only an identity-matching cached document", () => {
    const storage = new MemoryStorage();
    cacheProject(storage, makeProject(7));

    expect(readCachedProject(storage, projectId, 7)).toEqual(makeProject(7));
    expect(readCachedProject(storage, projectId, 8)).toBeNull();

    storage.setItem(projectCacheKey(projectId, 7), JSON.stringify(makeProject(9)));
    expect(readCachedProject(storage, projectId, 7)).toBeNull();
    expect(storage.getItem(projectCacheKey(projectId, 7))).toBeNull();
  });

  it("evicts stale revisions, removed projects, and corrupt cache entries", () => {
    const storage = new MemoryStorage();
    const removedId = "prj_removed" as ProjectId;
    storage.setItem(projectCacheKey(projectId, 6), JSON.stringify(makeProject(6)));
    storage.setItem(projectCacheKey(projectId, 7), JSON.stringify(makeProject(7)));
    storage.setItem(
      projectCacheKey(removedId, 1),
      JSON.stringify({ ...makeProject(1), projectId: removedId }),
    );
    storage.setItem("vibescreens:project-cache:v1:broken", "not-json");
    storage.setItem("unrelated", "keep");

    evictStaleProjectCache(storage, [summary(7)]);

    expect(storage.getItem(projectCacheKey(projectId, 6))).toBeNull();
    expect(storage.getItem(projectCacheKey(projectId, 7))).not.toBeNull();
    expect(storage.getItem(projectCacheKey(removedId, 1))).toBeNull();
    expect(storage.getItem("vibescreens:project-cache:v1:broken")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});

describe("workspace startup orchestration", () => {
  it("does not import when the workspace already has a project", async () => {
    const client = {
      getWorkspace: vi.fn(async () => ({
        workspace: makeWorkspace(),
        projects: [summary()],
      })),
      executeWorkspaceCommand: vi.fn(),
    };

    const result = await loadWorkspaceWithAutoImport(client);

    expect(result).toEqual({
      snapshot: { workspace: makeWorkspace(), projects: [summary()] },
      migrationStatus: "not_needed",
      readOnly: false,
    });
    expect(client.executeWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("attempts legacy import once for an empty workspace and reloads after import", async () => {
    const empty = makeWorkspace({
      revision: 0,
      activeProjectId: null,
      projectOrder: [],
      projectsById: {},
    });
    const imported = makeWorkspace({ revision: 1 });
    const client = {
      getWorkspace: vi
        .fn()
        .mockResolvedValueOnce({ workspace: empty, projects: [] })
        .mockResolvedValueOnce({ workspace: imported, projects: [summary()] }),
      executeWorkspaceCommand: vi.fn(async () => ({
        workspace: imported,
        importResult: {
          status: "imported" as const,
          workspace: imported,
          project: makeProject(),
          sourceFile: "vibescreens.json" as const,
          backupPath: ".vibescreens/backups/legacy.json",
          warnings: [],
        },
      })),
    };

    const result = await loadWorkspaceWithAutoImport(client);

    expect(client.executeWorkspaceCommand).toHaveBeenCalledTimes(1);
    expect(client.executeWorkspaceCommand).toHaveBeenCalledWith({
      action: "importLegacy",
      baseRevision: 0,
    });
    expect(client.getWorkspace).toHaveBeenCalledTimes(2);
    expect(result.migrationStatus).toBe("imported");
    expect(result.snapshot.projects).toEqual([summary()]);
    expect(result.readOnly).toBe(false);
  });

  it.each(["not_needed", "no_source"] as const)(
    "returns the %s migration outcome without retrying",
    async (status) => {
      const empty = makeWorkspace({
        revision: 0,
        activeProjectId: null,
        projectOrder: [],
        projectsById: {},
      });
      const client = {
        getWorkspace: vi.fn(async () => ({ workspace: empty, projects: [] })),
        executeWorkspaceCommand: vi.fn(async () => ({
          workspace: empty,
          importResult: { status, workspace: empty },
        })),
      };

      const result = await loadWorkspaceWithAutoImport(client);

      expect(result.migrationStatus).toBe(status);
      expect(result.snapshot).toEqual({ workspace: empty, projects: [] });
      expect(client.executeWorkspaceCommand).toHaveBeenCalledTimes(1);
      expect(client.getWorkspace).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an unsupported legacy schema read-only", async () => {
    const empty = makeWorkspace({
      revision: 0,
      activeProjectId: null,
      projectOrder: [],
      projectsById: {},
    });
    const client = {
      getWorkspace: vi.fn(async () => ({ workspace: empty, projects: [] })),
      executeWorkspaceCommand: vi.fn(async () => ({
        workspace: empty,
        importResult: {
          status: "unsupported" as const,
          schemaVersion: 9,
          readOnly: true as const,
          sourceFile: "vibescreens.json" as const,
        },
      })),
    };

    const result = await loadWorkspaceWithAutoImport(client);

    expect(result.migrationStatus).toBe("unsupported");
    expect(result.readOnly).toBe(true);
    expect(client.executeWorkspaceCommand).toHaveBeenCalledTimes(1);
  });
});
