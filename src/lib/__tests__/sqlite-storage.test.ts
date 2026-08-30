import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import { createProjectDocument } from "../project-operations";
import { projectDocumentPath } from "../project-paths";
import { createProjectRepository } from "../project-repository";
import { createWorkspaceProjectService } from "../server-service";
import {
  createSqliteDocumentStore,
  vibeScreensDatabasePath,
} from "../sqlite-storage";
import {
  createEmptyWorkspace,
  type ProjectId,
  type WorkspaceRegistry,
} from "../workspace";

const temporaryDirectories: string[] = [];
const PROJECT_ID = "prj_sqlite" as ProjectId;
const APP_ID = "app_sqlite" as AppId;
const VERSION_ID = "ver_sqlite" as VersionId;
const DECK_ID = "deck_sqlite" as DeckId;
const timestamp = "2026-08-29T12:00:00.000Z";

function project() {
  return createProjectDocument(
    {
      device: "iphone",
      orientation: "portrait",
      locale: "en",
      connectedCanvas: true,
      appName: "SQLite App",
      themeId: "clean-light",
      fontId: "system-sans",
      appIcon: "",
      slides: [],
    },
    {
      now: timestamp,
      projectId: PROJECT_ID,
      projectName: "SQLite Project",
      appId: APP_ID,
      versionId: VERSION_ID,
      deckId: DECK_ID,
    },
  );
}

function workspaceWithProject(document = project()): WorkspaceRegistry {
  return {
    schemaVersion: 1,
    revision: 1,
    activeProjectId: document.projectId,
    projectOrder: [document.projectId],
    projectsById: {
      [document.projectId]: {
        id: document.projectId,
        name: document.name,
        slug: "sqlite-project",
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
    },
  };
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibescreens-sqlite-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SQLite persistence", () => {
  it("rejects a symlinked workspace database directory", async () => {
    const rootDir = await temporaryRoot();
    const external = await temporaryRoot();
    await symlink(external, join(rootDir, ".vibescreens"));

    expect(() => createSqliteDocumentStore(rootDir)).toThrow(/symbolic link/i);
  });

  it("rejects a symlinked SQLite database file", async () => {
    const rootDir = await temporaryRoot();
    const external = join(await temporaryRoot(), "outside.db");
    await writeFile(external, "outside");
    await mkdir(join(rootDir, ".vibescreens"), { recursive: true });
    await symlink(external, vibeScreensDatabasePath(rootDir));

    expect(() => createSqliteDocumentStore(rootDir)).toThrow(/symbolic link/i);
  });

  it("refuses to open a database created by a newer schema", async () => {
    const rootDir = await temporaryRoot();
    const databasePath = vibeScreensDatabasePath(rootDir);
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (2, '2026-08-29T12:00:00.000Z');
    `);
    database.close();

    expect(() => createSqliteDocumentStore(rootDir)).toThrow(
      "SQLite schema 2 is newer than supported schema 1",
    );
  });

  it("stores projects in the SQLite database instead of project JSON files", async () => {
    const rootDir = await temporaryRoot();
    const repository = createProjectRepository({ rootDir });

    await repository.create(project());

    await expect(readFile(projectDocumentPath(rootDir, PROJECT_ID), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const database = new DatabaseSync(vibeScreensDatabasePath(rootDir), { readOnly: true });
    const row = database
      .prepare("SELECT project_id, revision FROM projects WHERE project_id = ?")
      .get(PROJECT_ID) as { project_id: string; revision: number };
    database.close();
    expect(row).toEqual({ project_id: PROJECT_ID, revision: 1 });
  });

  it("rolls project creation back when the workspace write fails", async () => {
    const rootDir = await temporaryRoot();
    const store = createSqliteDocumentStore(rootDir);
    const document = project();
    expect(store.createWorkspace(createEmptyWorkspace())).toBe(true);
    abortWorkspaceUpdates(rootDir);

    expect(() =>
      store.createProjectWithWorkspace(0, workspaceWithProject(document), document),
    ).toThrow("injected workspace failure");

    expect(store.readProject(document.projectId)).toBeUndefined();
    expect(store.readWorkspace()).toEqual(createEmptyWorkspace());
  });

  it("rolls a project rename back when the workspace write fails", async () => {
    const rootDir = await temporaryRoot();
    const store = createSqliteDocumentStore(rootDir);
    const document = project();
    const workspace = workspaceWithProject(document);
    expect(store.importWorkspace(workspace, [document])).toBe(true);
    const renamed = {
      ...document,
      revision: 2,
      name: "Renamed",
      updatedAt: "2026-08-29T13:00:00.000Z",
    };
    const renamedWorkspace: WorkspaceRegistry = {
      ...workspace,
      revision: 2,
      projectsById: {
        [document.projectId]: {
          ...workspace.projectsById[document.projectId],
          name: renamed.name,
          slug: "renamed",
          updatedAt: renamed.updatedAt,
        },
      },
    };
    abortWorkspaceUpdates(rootDir);

    expect(() =>
      store.compareAndSwapProjectWithWorkspace(
        workspace.revision,
        document.revision,
        renamedWorkspace,
        renamed,
      ),
    ).toThrow("injected workspace failure");

    expect(store.readProject(document.projectId)).toEqual(document);
    expect(store.readWorkspace()).toEqual(workspace);
  });

  it("rolls project trash and deletion back when the workspace write fails", async () => {
    const rootDir = await temporaryRoot();
    const store = createSqliteDocumentStore(rootDir);
    const document = project();
    const workspace = workspaceWithProject(document);
    expect(store.importWorkspace(workspace, [document])).toBe(true);
    const emptyWorkspace: WorkspaceRegistry = {
      ...createEmptyWorkspace(),
      revision: 2,
    };
    abortWorkspaceUpdates(rootDir);

    expect(() =>
      store.moveProjectToTrashWithWorkspace(
        workspace.revision,
        emptyWorkspace,
        document.projectId,
        "2026-08-29T130000000Z",
      ),
    ).toThrow("injected workspace failure");

    expect(store.readProject(document.projectId)).toEqual(document);
    expect(store.readWorkspace()).toEqual(workspace);
    const database = new DatabaseSync(vibeScreensDatabasePath(rootDir), {
      readOnly: true,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_trash").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  it("imports the existing v3 JSON workspace once without modifying the source files", async () => {
    const rootDir = await temporaryRoot();
    const document = project();
    const workspace: WorkspaceRegistry = {
      schemaVersion: 1,
      revision: 1,
      activeProjectId: PROJECT_ID,
      projectOrder: [PROJECT_ID],
      projectsById: {
        [PROJECT_ID]: {
          id: PROJECT_ID,
          name: document.name,
          slug: "sqlite-project",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    };
    const workspacePath = join(rootDir, ".vibescreens", "workspace.json");
    const documentPath = projectDocumentPath(rootDir, PROJECT_ID);
    await mkdir(dirname(workspacePath), { recursive: true });
    await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
    await mkdir(dirname(documentPath), { recursive: true });
    const projectBytes = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(documentPath, projectBytes);
    const workspaceBytes = await readFile(workspacePath, "utf8");

    const snapshot = await createWorkspaceProjectService({ rootDir }).getWorkspace();

    expect(snapshot.workspace).toEqual(workspace);
    expect(snapshot.projects).toEqual([
      expect.objectContaining({ projectId: PROJECT_ID, name: document.name, revision: 1 }),
    ]);
    await expect(readFile(workspacePath, "utf8")).resolves.toBe(workspaceBytes);
    await expect(readFile(documentPath, "utf8")).resolves.toBe(projectBytes);
    await expect(readFile(vibeScreensDatabasePath(rootDir))).resolves.toBeInstanceOf(Buffer);
  });
});
