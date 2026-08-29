import { describe, expect, it, vi } from "vitest";

import type { ProjectDocumentV3 } from "../project-schema";
import { ProjectRevisionConflictError } from "../project-repository";
import type { WorkspaceProjectService } from "../server-service";
import type { ProjectId, WorkspaceRegistry } from "../workspace";
import { WorkspaceRevisionConflictError } from "../workspace";
import { createProjectActionRouteHandlers } from "../../app/api/project/actions/route";
import { createProjectRouteHandlers } from "../../app/api/project/route";
import { createWorkspaceActionRouteHandlers } from "../../app/api/workspace/actions/route";
import { createWorkspaceRouteHandlers } from "../../app/api/workspace/route";

const projectId = "prj_route" as ProjectId;
const workspace: WorkspaceRegistry = {
  schemaVersion: 1,
  revision: 2,
  activeProjectId: projectId,
  projectOrder: [projectId],
  projectsById: {
    [projectId]: {
      id: projectId,
      name: "Route Project",
      slug: "route-project",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  } as WorkspaceRegistry["projectsById"],
};
const project = {
  schemaVersion: 3,
  projectId,
  name: "Route Project",
  revision: 4,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  appOrder: [],
  appsById: {},
  selection: {},
} as unknown as ProjectDocumentV3;

function service(overrides: Partial<WorkspaceProjectService> = {}): WorkspaceProjectService {
  return {
    getWorkspace: vi.fn(async () => ({ workspace, projects: [] })),
    getProject: vi.fn(async () => project),
    saveProject: vi.fn(async () => project),
    executeWorkspaceCommand: vi.fn(async () => ({ workspace })),
    executeProjectCommand: vi.fn(async () => ({ project })),
    ...overrides,
  } as unknown as WorkspaceProjectService;
}

function jsonRequest(url: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("core workspace/project routes", () => {
  it("returns the registry and ordered project summaries", async () => {
    const getWorkspace = vi.fn(async () => ({
      workspace,
      projects: [
        {
          projectId,
          name: "Route Project",
          revision: 4,
          updatedAt: project.updatedAt,
          appCount: 2,
        },
      ],
    }));
    const { GET } = createWorkspaceRouteHandlers(service({ getWorkspace }));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      workspace,
      projects: [expect.objectContaining({ projectId, appCount: 2 })],
    });
  });

  it("guards workspace writes and dispatches valid commands", async () => {
    const executeWorkspaceCommand = vi.fn(async () => ({ workspace }));
    const { POST } = createWorkspaceActionRouteHandlers(
      service({ executeWorkspaceCommand } as Partial<WorkspaceProjectService>),
    );

    const blocked = await POST(
      jsonRequest(
        "http://localhost/api/workspace/actions",
        { action: "switch", baseRevision: 2, projectId },
        { origin: "https://attacker.example" },
      ),
    );
    expect(blocked.status).toBe(403);
    expect(executeWorkspaceCommand).not.toHaveBeenCalled();

    const response = await POST(
      jsonRequest("http://localhost/api/workspace/actions", {
        action: "switch",
        baseRevision: 2,
        projectId,
      }),
    );
    expect(response.status).toBe(200);
    expect(executeWorkspaceCommand).toHaveBeenCalledWith({
      action: "switch",
      baseRevision: 2,
      projectId,
    });
    await expect(response.json()).resolves.toEqual({ ok: true, workspace });
  });

  it("reads and revision-saves the exact project selected by query ID", async () => {
    const getProject = vi.fn(async () => project);
    const saveProject = vi.fn(async () => ({ ...project, revision: 5 }));
    const { GET, PUT } = createProjectRouteHandlers(service({ getProject, saveProject }));

    const getResponse = await GET(
      new Request(`http://localhost/api/project?projectId=${projectId}`),
    );
    expect(getProject).toHaveBeenCalledWith(projectId);
    await expect(getResponse.json()).resolves.toEqual({ ok: true, project });

    const putRequest = jsonRequest(
      `http://localhost/api/project?projectId=${projectId}`,
      { baseRevision: 4, document: project },
    );
    const putResponse = await PUT(putRequest);
    expect(saveProject).toHaveBeenCalledWith({
      projectId,
      baseRevision: 4,
      document: project,
    });
    await expect(putResponse.json()).resolves.toMatchObject({
      ok: true,
      project: { revision: 5 },
    });
  });

  it("dispatches app/version commands and returns current metadata on conflicts", async () => {
    const current = {
      projectId,
      revision: 7,
      updatedAt: "2026-08-28T01:00:00.000Z",
    };
    const executeProjectCommand = vi.fn(async () => {
      throw new ProjectRevisionConflictError(current);
    });
    const { POST } = createProjectActionRouteHandlers(
      service({ executeProjectCommand }),
    );

    const response = await POST(
      jsonRequest(`http://localhost/api/project/actions?projectId=${projectId}`, {
        action: "publishVersion",
        baseRevision: 4,
        appId: "app_route",
        versionId: "ver_route",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "project_revision_conflict",
      current,
    });
  });

  it("maps workspace conflicts, malformed IDs, and oversized bodies to stable statuses", async () => {
    const executeWorkspaceCommand = vi.fn(async () => {
      throw new WorkspaceRevisionConflictError(9);
    });
    const workspaceHandlers = createWorkspaceActionRouteHandlers(
      service({ executeWorkspaceCommand } as Partial<WorkspaceProjectService>),
    );
    const conflict = await workspaceHandlers.POST(
      jsonRequest("http://localhost/api/workspace/actions", {
        action: "create",
        baseRevision: 2,
        name: "Stale",
      }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "workspace_revision_conflict",
      current: { revision: 9 },
    });

    const projectHandlers = createProjectRouteHandlers(service());
    const invalid = await projectHandlers.GET(
      new Request("http://localhost/api/project?projectId=../../escape"),
    );
    expect(invalid.status).toBe(400);

    const oversized = await workspaceHandlers.POST(
      new Request("http://localhost/api/workspace/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
  });
});
