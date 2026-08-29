import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { atomicWriteJson } from "../atomic-write";
import type { AppId, DeckId, VersionId } from "../ids";
import { createProjectDocument } from "../project-operations";
import { createProjectRepository } from "../project-repository";
import type { ProjectDocumentV3 } from "../project-schema";
import type { ProjectId } from "../workspace";
import {
  OrphanedProjectError,
  ProjectNotRegisteredError,
  createWorkspaceRepository,
} from "../workspace-repository";

const timestamp = "2026-08-28T00:00:00.000Z";
const later = "2026-08-28T01:00:00.000Z";
const temporaryDirectories: string[] = [];

function makeInitialProject(identity: {
  projectId: ProjectId;
  name: string;
  now: string;
}): ProjectDocumentV3 {
  const suffix = identity.projectId.slice(4);
  return createProjectDocument(
    {
      device: "iphone",
      orientation: "portrait",
      locale: "en",
      connectedCanvas: true,
      appName: identity.name,
      themeId: "clean-light",
      fontId: "system-sans",
      appIcon: "",
      slides: [{ id: `slide-${suffix}` } as never],
    },
    {
      projectId: identity.projectId,
      projectName: identity.name,
      appId: `app_${suffix}` as AppId,
      versionId: `ver_${suffix}` as VersionId,
      deckId: `deck_${suffix}` as DeckId,
      now: identity.now,
    },
  );
}

async function temporaryRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vibescreens-workspace-repository-"));
  temporaryDirectories.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace repository", () => {
  it("initializes a missing registry once and never replaces corrupt durable data", async () => {
    const rootDir = await temporaryRoot();
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
    });

    await expect(repository.load()).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      activeProjectId: null,
      projectOrder: [],
      projectsById: {},
    });
    const workspacePath = join(rootDir, ".vibescreens", "workspace.json");
    await writeFile(workspacePath, "not-json\n");
    await expect(repository.load()).rejects.toThrow();
    await expect(readFile(workspacePath, "utf8")).resolves.toBe("not-json\n");
  });

  it("creates the project document before registering it and guards workspace CAS", async () => {
    const rootDir = await temporaryRoot();
    const events: string[] = [];
    const projectRepository = createProjectRepository({
      rootDir,
      writeJson: async (path, data) => {
        events.push("project");
        await atomicWriteJson(path, data);
      },
    });
    const generatedIds: ProjectId[] = [
      "prj_first" as ProjectId,
      "prj_second" as ProjectId,
    ];
    const repository = createWorkspaceRepository({
      rootDir,
      projectRepository,
      createInitialProject: makeInitialProject,
      createProjectId: () => generatedIds.shift()!,
      writeJson: async (path, data) => {
        events.push("workspace");
        await atomicWriteJson(path, data);
      },
    });

    const created = await repository.createProject({
      baseRevision: 0,
      name: "My Project",
      now: timestamp,
    });

    expect(events).toEqual(["project", "workspace"]);
    expect(created.workspace).toMatchObject({
      revision: 1,
      activeProjectId: "prj_first",
      projectOrder: ["prj_first"],
      projectsById: {
        prj_first: { name: "My Project", slug: "my-project" },
      },
    });
    expect(created.project).toMatchObject({ projectId: "prj_first", revision: 1 });

    await expect(
      repository.createProject({ baseRevision: 0, name: "Stale", now: later }),
    ).rejects.toMatchObject({ currentRevision: 1 });
    expect(generatedIds).toEqual(["prj_second"]);
  });

  it("serializes concurrent creates so the stale caller has no project side effect", async () => {
    const rootDir = await temporaryRoot();
    let generated = 0;
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => `prj_concurrent_${++generated}` as ProjectId,
    });

    const results = await Promise.allSettled([
      repository.createProject({ baseRevision: 0, name: "First", now: timestamp }),
      repository.createProject({ baseRevision: 0, name: "Second", now: timestamp }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(generated).toBe(1);
    expect((await repository.load()).projectOrder).toHaveLength(1);
  });

  it("switches, renames, and deletes with independent workspace/project revisions", async () => {
    const rootDir = await temporaryRoot();
    const ids: ProjectId[] = [
      "prj_first" as ProjectId,
      "prj_second" as ProjectId,
    ];
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => ids.shift()!,
    });
    const first = await repository.createProject({
      baseRevision: 0,
      name: "First",
      now: timestamp,
    });
    const second = await repository.createProject({
      baseRevision: first.workspace.revision,
      name: "Second",
      now: timestamp,
    });

    const switched = await repository.switchProject({
      baseRevision: second.workspace.revision,
      projectId: first.project.projectId,
    });
    expect(switched).toMatchObject({ revision: 3, activeProjectId: "prj_first" });

    const renamed = await repository.renameProject({
      baseWorkspaceRevision: switched.revision,
      baseProjectRevision: first.project.revision,
      projectId: first.project.projectId,
      name: "Renamed",
      now: later,
    });
    expect(renamed.project).toMatchObject({ revision: 2, name: "Renamed" });
    expect(renamed.workspace).toMatchObject({
      revision: 4,
      projectsById: { prj_first: { name: "Renamed", slug: "renamed" } },
    });

    const deleted = await repository.deleteProject({
      baseRevision: renamed.workspace.revision,
      projectId: first.project.projectId,
      trashTimestamp: "2026-08-28T010000000Z",
    });
    expect(deleted.workspace).toMatchObject({
      revision: 5,
      activeProjectId: "prj_second",
      projectOrder: ["prj_second"],
    });
    expect(deleted.trash.status).toBe("moved");
  });

  it("rejects unknown and orphaned projects without hidden workspace writes", async () => {
    const rootDir = await temporaryRoot();
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => "prj_orphan" as ProjectId,
    });
    const created = await repository.createProject({
      baseRevision: 0,
      name: "Orphan",
      now: timestamp,
    });
    await rm(join(rootDir, ".vibescreens", "projects", "prj_orphan"), {
      recursive: true,
      force: true,
    });

    await expect(
      repository.switchProject({
        baseRevision: created.workspace.revision,
        projectId: "prj_unknown" as ProjectId,
      }),
    ).rejects.toBeInstanceOf(ProjectNotRegisteredError);
    await expect(
      repository.switchProject({
        baseRevision: created.workspace.revision,
        projectId: "prj_orphan" as ProjectId,
      }),
    ).rejects.toBeInstanceOf(OrphanedProjectError);
    expect((await repository.load()).revision).toBe(1);
  });

  it("imports the preferred legacy root file with exact backup, scoped assets, warnings, and project-before-workspace commit order", async () => {
    const rootDir = await temporaryRoot();
    const legacy = {
      schemaVersion: 2,
      appName: "Imported",
      themeId: "clean-light",
      fontId: "system-sans",
      connectedCanvas: false,
      locales: ["en"],
      locale: "en",
      device: "iphone",
      orientation: "portrait",
      appIcon: "",
      slidesByDevice: {
        iphone: [
          {
            id: "slide-imported",
            layout: "hero",
            label: { en: "Label" },
            headline: { en: "Headline" },
            screenshot: "/screenshots/existing.png",
            screenshotSecondary: "/screenshots/missing.png",
          },
        ],
      },
    };
    const sourceBytes = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(join(rootDir, "vibescreens.json"), sourceBytes);
    await writeFile(join(rootDir, "app-store-screenshots.json"), "{\"ignored\":true}\n");
    await mkdir(join(rootDir, "public", "screenshots"), { recursive: true });
    await writeFile(
      join(rootDir, "public", "screenshots", "existing.png"),
      "screenshot bytes",
    );
    const events: string[] = [];
    const projectRepository = createProjectRepository({
      rootDir,
      writeJson: async (path, data) => {
        events.push("project");
        await atomicWriteJson(path, data);
      },
    });
    const repository = createWorkspaceRepository({
      rootDir,
      projectRepository,
      createInitialProject: makeInitialProject,
      writeJson: async (path, data) => {
        events.push("workspace");
        await atomicWriteJson(path, data);
      },
    });

    const imported = await repository.importLegacyProject({
      baseRevision: 0,
      migratedAt: timestamp,
    });

    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("Expected import");
    expect(events).toEqual(["project", "workspace"]);
    await expect(readFile(join(rootDir, "vibescreens.json"), "utf8")).resolves.toBe(
      sourceBytes,
    );
    await expect(readFile(join(rootDir, imported.backupPath), "utf8")).resolves.toBe(
      sourceBytes,
    );
    const app = imported.project.appsById[imported.project.appOrder[0]];
    const version = app.versionsById[app.versionOrder[0]];
    const deck = version.decksById[version.deckOrder[0]];
    expect(deck.slides[0].screenshot).toMatch(
      /^\/vibescreens-assets\/.*\/screenshots\/[a-f0-9]{64}\.png$/,
    );
    expect(deck.slides[0].screenshotSecondary).toBe("/screenshots/missing.png");
    expect(imported.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_asset" }),
      ]),
    );
    expect(imported.project.migration).toMatchObject({
      sourceFile: "vibescreens.json",
      warnings: expect.arrayContaining([
        expect.stringContaining("/screenshots/missing.png"),
      ]),
    });

    const eventCount = events.length;
    const repeated = await repository.importLegacyProject({
      baseRevision: imported.workspace.revision,
      migratedAt: later,
    });
    expect(repeated).toMatchObject({ status: "not_needed" });
    expect(events).toHaveLength(eventCount);
  });

  it("opens a future root schema read-only with zero backup, project, or workspace writes", async () => {
    const rootDir = await temporaryRoot();
    const source = '{"schemaVersion":4,"future":true}\n';
    await writeFile(join(rootDir, "vibescreens.json"), source);
    const events: string[] = [];
    const projectRepository = createProjectRepository({
      rootDir,
      writeJson: async (path, data) => {
        events.push("project");
        await atomicWriteJson(path, data);
      },
    });
    const repository = createWorkspaceRepository({
      rootDir,
      projectRepository,
      createInitialProject: makeInitialProject,
      writeJson: async (path, data) => {
        events.push("workspace");
        await atomicWriteJson(path, data);
      },
    });

    const result = await repository.importLegacyProject({
      baseRevision: 0,
      migratedAt: timestamp,
    });

    expect(result).toEqual({
      status: "unsupported",
      schemaVersion: 4,
      readOnly: true,
      sourceFile: "vibescreens.json",
    });
    expect(events).toEqual([]);
    await expect(access(join(rootDir, ".vibescreens"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(rootDir, "vibescreens.json"), "utf8")).resolves.toBe(
      source,
    );
  });
});
