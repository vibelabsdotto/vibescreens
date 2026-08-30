import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";


import type { AppId, DeckId, VersionId } from "../ids";
import { createApp, createProjectDocument } from "../project-operations";
import { projectDocumentPath } from "../project-paths";
import { createProjectRepository } from "../project-repository";
import type { ProjectDocumentV3 } from "../project-schema";
import { createSqliteDocumentStore, vibeScreensDatabasePath } from "../sqlite-storage";
import { createEmptyWorkspace } from "../workspace";
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

function abortWorkspaceUpdates(rootDir: string): void {
  const database = new DatabaseSync(vibeScreensDatabasePath(rootDir));
  database.exec(`
    CREATE TRIGGER abort_workspace_updates
    BEFORE UPDATE ON workspace
    BEGIN
      SELECT RAISE(ABORT, 'injected workspace failure');
    END;
  `);
  database.close();
}

function allowWorkspaceUpdates(rootDir: string): void {
  const database = new DatabaseSync(vibeScreensDatabasePath(rootDir));
  database.exec("DROP TRIGGER abort_workspace_updates");
  database.close();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace repository", () => {
  it("initializes a missing registry once and ignores stale JSON after SQLite becomes authoritative", async () => {
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
    await expect(repository.load()).resolves.toMatchObject({ revision: 0, projectOrder: [] });
    await expect(readFile(workspacePath, "utf8")).resolves.toBe("not-json\n");
  });

  it("rejects a JSON workspace whose registered project file is missing", async () => {
    const rootDir = await temporaryRoot();
    const projectId = "prj_missing_json" as ProjectId;
    const workspacePath = join(rootDir, ".vibescreens", "workspace.json");
    await mkdir(dirname(workspacePath), { recursive: true });
    await writeFile(workspacePath, JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      activeProjectId: projectId,
      projectOrder: [projectId],
      projectsById: {
        [projectId]: {
          id: projectId,
          name: "Missing",
          slug: "missing",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }));
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
    });

    await expect(repository.load()).rejects.toBeInstanceOf(OrphanedProjectError);
    await rm(workspacePath);
    await expect(createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
    }).load()).resolves.toMatchObject({ revision: 0, projectOrder: [] });
  });

  it("non-destructively splits multi-App JSON projects into one Project per App", async () => {
    const rootDir = await temporaryRoot();
    const projectId = "prj_multi_app" as ProjectId;
    const base = makeInitialProject({ projectId, name: "First App", now: timestamp });
    const multiApp = createApp(base, "Second App", {
      device: "android",
      orientation: "portrait",
      locale: "en",
      connectedCanvas: true,
      appName: "Second App",
      themeId: "clean-light",
      fontId: "system-sans",
      appIcon: "",
      slides: [{ id: "slide-second" } as never],
    }, {
      appId: "app_second" as AppId,
      versionId: "ver_second" as VersionId,
      deckId: "deck_second" as DeckId,
      now: later,
    });
    const workspacePath = join(rootDir, ".vibescreens", "workspace.json");
    const projectPath = projectDocumentPath(rootDir, projectId);
    await mkdir(dirname(workspacePath), { recursive: true });
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(workspacePath, JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      activeProjectId: projectId,
      projectOrder: [projectId],
      projectsById: {
        [projectId]: {
          id: projectId,
          name: "Legacy Multi App",
          slug: "legacy-multi-app",
          createdAt: timestamp,
          updatedAt: later,
        },
      },
    }));
    await writeFile(projectPath, JSON.stringify(multiApp));
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => "prj_split_app" as ProjectId,
    });

    const workspace = await repository.load();
    const projects = await Promise.all(workspace.projectOrder.map((id) => repository.readProject(id)));

    expect(workspace.projectOrder).toEqual([projectId, "prj_split_app"]);
    expect(projects.map((project) => project.appOrder)).toEqual([
      ["app_second"],
      [base.appOrder[0]],
    ]);
    expect(projects.map((project) => project.name)).toEqual([
      "Second App",
      base.appsById[base.appOrder[0]].name,
    ]);
    expect(JSON.parse(await readFile(projectPath, "utf8")).appOrder).toHaveLength(2);
  });

  it("creates the project and guards workspace CAS", async () => {
    const rootDir = await temporaryRoot();
    const generatedIds: ProjectId[] = [
      "prj_first" as ProjectId,
      "prj_second" as ProjectId,
    ];
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => generatedIds.shift()!,
    });

    const created = await repository.createProject({
      baseRevision: 0,
      name: "My Project",
      now: timestamp,
    });

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

  it("does not leave an orphaned project when workspace creation fails", async () => {
    const rootDir = await temporaryRoot();
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => "prj_atomic_create" as ProjectId,
    });
    await repository.load();
    abortWorkspaceUpdates(rootDir);

    await expect(
      repository.createProject({ baseRevision: 0, name: "Atomic", now: timestamp }),
    ).rejects.toThrow("injected workspace failure");

    allowWorkspaceUpdates(rootDir);
    expect((await repository.load()).projectOrder).toEqual([]);
    await expect(
      createProjectRepository({ rootDir }).exists("prj_atomic_create" as ProjectId),
    ).resolves.toBe(false);
  });

  it("does not register an existing legacy project deleted during import", async () => {
    const rootDir = await temporaryRoot();
    const document = makeInitialProject({
      projectId: "prj_existing_import" as ProjectId,
      name: "Existing Import",
      now: timestamp,
    });
    await writeFile(join(rootDir, "vibescreens.json"), JSON.stringify(document));
    const baseStore = createSqliteDocumentStore(rootDir);
    expect(baseStore.createWorkspace(createEmptyWorkspace())).toBe(true);
    expect(baseStore.createProject(document)).toBe(true);
    let injected = false;
    const store = {
      ...baseStore,
      compareAndSwapProjectWithWorkspace(...args: Parameters<typeof baseStore.compareAndSwapProjectWithWorkspace>) {
        if (!injected) {
          injected = true;
          expect(baseStore.moveProjectToTrash(document.projectId, "concurrent-delete")).toBe(true);
        }
        return baseStore.compareAndSwapProjectWithWorkspace(...args);
      },
    };
    const repository = createWorkspaceRepository({
      rootDir,
      store,
      createInitialProject: makeInitialProject,
    });

    await expect(repository.importLegacyProject({
      baseRevision: 0,
      migratedAt: later,
    })).rejects.toBeInstanceOf(OrphanedProjectError);
    expect(baseStore.readWorkspace()?.projectOrder).toEqual([]);
  });

  it("does not split project and workspace names when workspace rename fails", async () => {
    const rootDir = await temporaryRoot();
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => "prj_atomic_rename" as ProjectId,
    });
    const created = await repository.createProject({
      baseRevision: 0,
      name: "Before",
      now: timestamp,
    });
    abortWorkspaceUpdates(rootDir);

    await expect(
      repository.renameProject({
        baseWorkspaceRevision: created.workspace.revision,
        baseProjectRevision: created.project.revision,
        projectId: created.project.projectId,
        name: "After",
        now: later,
      }),
    ).rejects.toThrow("injected workspace failure");

    allowWorkspaceUpdates(rootDir);
    expect((await repository.load()).projectsById[created.project.projectId].name).toBe(
      "Before",
    );
    await expect(
      createProjectRepository({ rootDir }).read(created.project.projectId),
    ).resolves.toMatchObject({ name: "Before", revision: 1 });
  });

  it("does not trash a registered project when workspace deletion fails", async () => {
    const rootDir = await temporaryRoot();
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
      createProjectId: () => "prj_atomic_delete" as ProjectId,
    });
    const created = await repository.createProject({
      baseRevision: 0,
      name: "Keep",
      now: timestamp,
    });
    abortWorkspaceUpdates(rootDir);

    await expect(
      repository.deleteProject({
        baseRevision: created.workspace.revision,
        projectId: created.project.projectId,
        trashTimestamp: "2026-08-28T010000000Z",
      }),
    ).rejects.toThrow("injected workspace failure");

    allowWorkspaceUpdates(rootDir);
    expect((await repository.load()).projectOrder).toEqual([created.project.projectId]);
    await expect(
      createProjectRepository({ rootDir }).read(created.project.projectId),
    ).resolves.toMatchObject({ name: "Keep", revision: 1 });
    const database = new DatabaseSync(vibeScreensDatabasePath(rootDir), {
      readOnly: true,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_trash").get()).toEqual({
      count: 0,
    });
    database.close();
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
    await createProjectRepository({ rootDir }).moveToTrash(
      created.project.projectId,
      "orphaned-for-test",
    );

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
      Buffer.from("89504e470d0a1a0a00000000", "hex"),
    );
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
    });

    const imported = await repository.importLegacyProject({
      baseRevision: 0,
      migratedAt: timestamp,
    });

    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("Expected import");
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

    const repeated = await repository.importLegacyProject({
      baseRevision: imported.workspace.revision,
      migratedAt: later,
    });
    expect(repeated).toMatchObject({ status: "not_needed" });
  });

  it("does not leave an orphaned migrated project when workspace import fails", async () => {
    const rootDir = await temporaryRoot();
    await writeFile(
      join(rootDir, "vibescreens.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        appName: "Atomic Import",
        themeId: "clean-light",
        fontId: "system-sans",
        connectedCanvas: false,
        locales: ["en"],
        locale: "en",
        device: "iphone",
        orientation: "portrait",
        appIcon: "",
        slidesByDevice: { iphone: [{ id: "slide-atomic-import" }] },
      })}\n`,
    );
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
    });
    await repository.load();
    abortWorkspaceUpdates(rootDir);

    await expect(
      repository.importLegacyProject({ baseRevision: 0, migratedAt: timestamp }),
    ).rejects.toThrow("injected workspace failure");

    allowWorkspaceUpdates(rootDir);
    expect((await repository.load()).projectOrder).toEqual([]);
    const database = new DatabaseSync(vibeScreensDatabasePath(rootDir), {
      readOnly: true,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  it("opens a future root schema read-only with zero backup, project, or workspace writes", async () => {
    const rootDir = await temporaryRoot();
    const source = '{"schemaVersion":4,"future":true}\n';
    await writeFile(join(rootDir, "vibescreens.json"), source);
    const repository = createWorkspaceRepository({
      rootDir,
      createInitialProject: makeInitialProject,
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
    const database = new DatabaseSync(vibeScreensDatabasePath(rootDir), { readOnly: true });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM workspace").get(),
    ).toMatchObject({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM projects").get(),
    ).toMatchObject({ count: 0 });
    database.close();
    await expect(readFile(join(rootDir, "vibescreens.json"), "utf8")).resolves.toBe(
      source,
    );
  });
});
