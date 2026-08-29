import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  projectDocumentPath,
  projectRoot,
  projectTrashPath,
  workspaceRoot,
} from "../project-paths";
import type { ProjectId } from "../workspace";

describe("project paths", () => {
  it("resolves workspace, project, document, and trash paths under their roots", () => {
    const cwd = resolve("/tmp/vibescreens-path-test");
    const projectId = "prj_demo-1" as ProjectId;

    expect(workspaceRoot(cwd)).toBe(join(cwd, ".vibescreens"));
    expect(projectRoot(cwd, projectId)).toBe(
      join(cwd, ".vibescreens", "projects", projectId),
    );
    expect(projectDocumentPath(cwd, projectId)).toBe(
      join(cwd, ".vibescreens", "projects", projectId, "vibescreens.json"),
    );
    expect(projectTrashPath(cwd, projectId, "2026-08-28T12:30:00.000Z")).toBe(
      join(
        cwd,
        ".vibescreens",
        "trash",
        `${projectId}-2026-08-28T12:30:00.000Z`,
      ),
    );
  });

  it("rejects invalid IDs, traversal, separators, and absolute path segments", () => {
    const cwd = resolve("/tmp/vibescreens-path-test");
    const invalidProjectIds = [
      "../escape",
      "prj_../escape",
      "prj_nested/project",
      "prj_nested\\project",
      "/tmp/absolute",
      "C:\\absolute",
      "prj_",
      `prj_${"x".repeat(65)}`,
    ] as ProjectId[];
    const projectResolvers = [
      (projectId: ProjectId) => projectRoot(cwd, projectId),
      (projectId: ProjectId) => projectDocumentPath(cwd, projectId),
      (projectId: ProjectId) => projectTrashPath(cwd, projectId, "123"),
    ];

    for (const resolver of projectResolvers) {
      for (const projectId of invalidProjectIds) {
        expect(() => resolver(projectId)).toThrow(/Invalid project ID/);
      }
    }

    for (const timestamp of [
      "",
      ".",
      "..",
      "../escape",
      "nested/value",
      "nested\\value",
      "/tmp/absolute",
      "C:\\absolute",
    ]) {
      expect(() =>
        projectTrashPath(cwd, "prj_safe" as ProjectId, timestamp),
      ).toThrow(/Invalid trash timestamp/);
    }
  });
});
