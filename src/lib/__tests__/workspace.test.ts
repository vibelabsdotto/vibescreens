import { describe, expect, it } from "vitest";

import {
  MAX_PROJECTS,
  WorkspaceRevisionConflictError,
  createEmptyWorkspace,
  createProjectId,
  isProjectId,
  mutateWorkspace,
  slugifyProjectName,
  type ProjectId,
  type WorkspaceRegistry,
  uniqueProjectSlug,
} from "../workspace";

describe("workspace registry", () => {
  it("creates an empty v1 registry and strict unique project IDs", () => {
    const workspace: WorkspaceRegistry = createEmptyWorkspace();
    const firstId = createProjectId();
    const secondId = createProjectId();

    expect(MAX_PROJECTS).toBe(100);
    expect(workspace).toEqual({
      schemaVersion: 1,
      revision: 0,
      activeProjectId: null,
      projectOrder: [],
      projectsById: {},
    });
    expect(firstId).toMatch(/^prj_[A-Za-z0-9_-]{1,64}$/);
    expect(secondId).toMatch(/^prj_[A-Za-z0-9_-]{1,64}$/);
    expect(secondId).not.toBe(firstId);
    expect(isProjectId("prj_a")).toBe(true);
    expect(isProjectId(`prj_${"a".repeat(64)}`)).toBe(true);
    expect(isProjectId("project_a")).toBe(false);
    expect(isProjectId("prj_../escape")).toBe(false);
    expect(isProjectId(`prj_${"a".repeat(65)}`)).toBe(false);
  });

  it("starts workspace CAS revision at zero", () => {
    expect(createEmptyWorkspace().revision).toBe(0);
  });

  it("increments the workspace revision after a successful mutation", () => {
    const workspace = createEmptyWorkspace();
    const projectId = "prj_active" as ProjectId;
    workspace.revision = 7;

    const nextWorkspace = mutateWorkspace(workspace, 7, (draft) => {
      draft.activeProjectId = projectId;
    });

    expect(nextWorkspace.revision).toBe(8);
    expect(nextWorkspace.activeProjectId).toBe(projectId);
  });

  it("throws a typed conflict with the current revision for stale mutations", () => {
    const workspace = createEmptyWorkspace();
    workspace.revision = 3;
    let mutatorCalled = false;
    let caught: unknown;

    try {
      mutateWorkspace(workspace, 2, () => {
        mutatorCalled = true;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkspaceRevisionConflictError);
    if (!(caught instanceof WorkspaceRevisionConflictError)) {
      throw new Error("Expected a workspace revision conflict");
    }
    expect(caught.currentRevision).toBe(3);
    expect(mutatorCalled).toBe(false);
  });

  it("deep-clones the registry before applying a mutation", () => {
    const projectId = "prj_original" as ProjectId;
    const secondProjectId = "prj_second" as ProjectId;
    const workspace = createEmptyWorkspace();
    workspace.activeProjectId = projectId;
    workspace.projectOrder.push(projectId);
    workspace.projectsById[projectId] = {
      id: projectId,
      name: "Original",
      slug: "original",
      createdAt: "2026-08-28T08:00:00.000Z",
      updatedAt: "2026-08-28T08:00:00.000Z",
    };

    const nextWorkspace = mutateWorkspace(workspace, 0, (draft) => {
      draft.projectOrder.push(secondProjectId);
      draft.projectsById[projectId].name = "Renamed";
    });

    expect(workspace).toEqual({
      schemaVersion: 1,
      revision: 0,
      activeProjectId: projectId,
      projectOrder: [projectId],
      projectsById: {
        [projectId]: {
          id: projectId,
          name: "Original",
          slug: "original",
          createdAt: "2026-08-28T08:00:00.000Z",
          updatedAt: "2026-08-28T08:00:00.000Z",
        },
      },
    });
    expect(nextWorkspace).not.toBe(workspace);
    expect(nextWorkspace.projectOrder).not.toBe(workspace.projectOrder);
    expect(nextWorkspace.projectsById).not.toBe(workspace.projectsById);
    expect(nextWorkspace.projectsById[projectId]).not.toBe(
      workspace.projectsById[projectId],
    );
    expect(nextWorkspace.projectOrder).toEqual([projectId, secondProjectId]);
    expect(nextWorkspace.projectsById[projectId].name).toBe("Renamed");
  });

  it("creates deterministic slugs and resolves collisions case-insensitively", () => {
    expect(slugifyProjectName("  Crème Brûlée  ")).toBe("creme-brulee");
    expect(slugifyProjectName("你好 🚀")).toBe("project");
    expect(slugifyProjectName("  ")).toBe("project");
    expect(slugifyProjectName("---Hello___world---")).toBe("hello-world");

    const existing = ["MY-PROJECT", "my-project-2", "My-Project-4"];

    expect(uniqueProjectSlug("My Project", existing)).toBe("my-project-3");
    expect(uniqueProjectSlug("My Project", existing)).toBe("my-project-3");
    expect(uniqueProjectSlug("", ["PROJECT"])).toBe("project-2");
    expect(uniqueProjectSlug("Fresh Name", existing)).toBe("fresh-name");
  });
});
