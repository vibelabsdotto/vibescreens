import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";

import type { ProjectDocumentV3 } from "./project-schema";
import { workspaceRoot } from "./project-paths";
import type { ProjectId, WorkspaceRegistry } from "./workspace";

const DATABASE_FILENAME = "vibescreens.db";
const DATABASE_SCHEMA_VERSION = 1;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export class SqliteSchemaVersionError extends Error {
  constructor(public readonly schemaVersion: number) {
    super(
      `SQLite schema ${schemaVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`,
    );
    this.name = "SqliteSchemaVersionError";
  }
}

interface WorkspaceRow {
  revision: number;
  document: string;
}

interface ProjectRow {
  project_id: string;
  revision: number;
  updated_at: string;
  document: string;
}

export type AtomicTrashResult = "moved" | "missing" | "conflict";

export interface SqliteDocumentStore {
  readonly path: string;
  readWorkspace(): WorkspaceRegistry | undefined;
  createWorkspace(workspace: WorkspaceRegistry): boolean;
  compareAndSwapWorkspace(baseRevision: number, workspace: WorkspaceRegistry): boolean;
  importWorkspace(workspace: WorkspaceRegistry, projects: readonly ProjectDocumentV3[]): boolean;
  hasProject(projectId: ProjectId): boolean;
  readProject(projectId: ProjectId): ProjectDocumentV3 | undefined;
  listProjectIds(): ProjectId[];
  createProject(document: ProjectDocumentV3): boolean;
  createProjectWithWorkspace(
    baseWorkspaceRevision: number,
    workspace: WorkspaceRegistry,
    document: ProjectDocumentV3,
  ): boolean;
  compareAndSwapProject(
    projectId: ProjectId,
    baseRevision: number,
    document: ProjectDocumentV3,
  ): boolean;
  compareAndSwapProjectWithWorkspace(
    baseWorkspaceRevision: number,
    baseProjectRevision: number,
    workspace: WorkspaceRegistry,
    document: ProjectDocumentV3,
  ): boolean;
  moveProjectToTrash(projectId: ProjectId, trashTimestamp: string): boolean;
  moveProjectToTrashWithWorkspace(
    baseWorkspaceRevision: number,
    workspace: WorkspaceRegistry,
    projectId: ProjectId,
    trashTimestamp: string,
  ): AtomicTrashResult;
}

type GlobalWithVibeScreensDatabases = typeof globalThis & {
  __vibeScreensDatabases?: Map<string, DatabaseSyncInstance>;
};

function databaseCache(): Map<string, DatabaseSyncInstance> {
  const global = globalThis as GlobalWithVibeScreensDatabases;
  global.__vibeScreensDatabases ??= new Map<string, DatabaseSyncInstance>();
  return global.__vibeScreensDatabases;
}

export function vibeScreensDatabasePath(rootDir: string): string {
  return join(workspaceRoot(rootDir), DATABASE_FILENAME);
}

function openDatabase(rootDir: string): DatabaseSyncInstance {
  const path = vibeScreensDatabasePath(rootDir);
  const directory = dirname(path);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new TypeError(`SQLite workspace directory must not be a symbolic link: ${directory}`);
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new TypeError(`SQLite database file must not be a symbolic link: ${path}`);
  }
  const cached = databaseCache().get(path);
  if (cached !== undefined) return cached;

  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  try {
    const migrationTableExists =
      database
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get() !== undefined;
    if (migrationTableExists) {
      const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        | { version: number | null }
        | undefined;
      const schemaVersion = row?.version ?? 0;
      if (schemaVersion > DATABASE_SCHEMA_VERSION) {
        throw new SqliteSchemaVersionError(schemaVersion);
      }
    }

    database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workspace (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      document TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      document TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS project_trash (
      project_id TEXT NOT NULL,
      trash_timestamp TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      updated_at TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (project_id, trash_timestamp)
    ) STRICT;
  `);
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(DATABASE_SCHEMA_VERSION, new Date().toISOString());
  } catch (error) {
    database.close();
    throw error;
  }
  databaseCache().set(path, database);
  return database;
}

function parseWorkspace(serialized: string): WorkspaceRegistry {
  return JSON.parse(serialized) as WorkspaceRegistry;
}

function parseProject(serialized: string): ProjectDocumentV3 {
  return JSON.parse(serialized) as ProjectDocumentV3;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

export function createSqliteDocumentStore(rootDir: string): SqliteDocumentStore {
  const database = openDatabase(rootDir);
  const path = vibeScreensDatabasePath(rootDir);

  const readWorkspaceStatement = database.prepare(
    "SELECT revision, document FROM workspace WHERE singleton = 1",
  );
  const createWorkspaceStatement = database.prepare(
    "INSERT OR IGNORE INTO workspace (singleton, revision, document) VALUES (1, ?, ?)",
  );
  const updateWorkspaceStatement = database.prepare(
    "UPDATE workspace SET revision = ?, document = ? WHERE singleton = 1 AND revision = ?",
  );
  const hasProjectStatement = database.prepare(
    "SELECT 1 AS present FROM projects WHERE project_id = ?",
  );
  const readProjectStatement = database.prepare(
    "SELECT project_id, revision, updated_at, document FROM projects WHERE project_id = ?",
  );
  const listProjectIdsStatement = database.prepare(
    "SELECT project_id FROM projects ORDER BY project_id",
  );
  const createProjectStatement = database.prepare(
    "INSERT OR IGNORE INTO projects (project_id, revision, updated_at, document) VALUES (?, ?, ?, ?)",
  );
  const updateProjectStatement = database.prepare(
    "UPDATE projects SET revision = ?, updated_at = ?, document = ? WHERE project_id = ? AND revision = ?",
  );
  const trashProjectStatement = database.prepare(`
    INSERT INTO project_trash (
      project_id,
      trash_timestamp,
      revision,
      updated_at,
      document
    )
    SELECT project_id, ?, revision, updated_at, document
    FROM projects
    WHERE project_id = ?
  `);
  const deleteProjectStatement = database.prepare(
    "DELETE FROM projects WHERE project_id = ?",
  );

  const createProjectUnsafe = (document: ProjectDocumentV3): boolean =>
    changed(
      createProjectStatement.run(
        document.projectId,
        document.revision,
        document.updatedAt,
        serialize(document),
      ),
    );

  return {
    path,

    readWorkspace() {
      const row = readWorkspaceStatement.get() as WorkspaceRow | undefined;
      return row === undefined ? undefined : parseWorkspace(row.document);
    },

    createWorkspace(workspace) {
      return changed(createWorkspaceStatement.run(workspace.revision, serialize(workspace)));
    },

    compareAndSwapWorkspace(baseRevision, workspace) {
      return changed(
        updateWorkspaceStatement.run(
          workspace.revision,
          serialize(workspace),
          baseRevision,
        ),
      );
    },

    importWorkspace(workspace, projects) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (readWorkspaceStatement.get() !== undefined) {
          database.exec("ROLLBACK");
          return false;
        }
        for (const project of projects) {
          if (!createProjectUnsafe(project)) {
            throw new Error(`Project ${project.projectId} already exists during JSON import`);
          }
        }
        if (!changed(createWorkspaceStatement.run(workspace.revision, serialize(workspace)))) {
          throw new Error("Workspace was created concurrently during JSON import");
        }
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    hasProject(projectId) {
      return hasProjectStatement.get(projectId) !== undefined;
    },

    readProject(projectId) {
      const row = readProjectStatement.get(projectId) as ProjectRow | undefined;
      return row === undefined ? undefined : parseProject(row.document);
    },

    listProjectIds() {
      return (listProjectIdsStatement.all() as Array<{ project_id: string }>).map(
        ({ project_id }) => project_id as ProjectId,
      );
    },

    createProject: createProjectUnsafe,

    createProjectWithWorkspace(baseWorkspaceRevision, workspace, document) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (!createProjectUnsafe(document)) {
          database.exec("ROLLBACK");
          return false;
        }
        const workspaceUpdated = changed(
          updateWorkspaceStatement.run(
            workspace.revision,
            serialize(workspace),
            baseWorkspaceRevision,
          ),
        );
        const workspaceCreated =
          !workspaceUpdated &&
          baseWorkspaceRevision === 0 &&
          readWorkspaceStatement.get() === undefined &&
          changed(createWorkspaceStatement.run(workspace.revision, serialize(workspace)));
        if (!workspaceUpdated && !workspaceCreated) {
          database.exec("ROLLBACK");
          return false;
        }
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    compareAndSwapProject(projectId, baseRevision, document) {
      return changed(
        updateProjectStatement.run(
          document.revision,
          document.updatedAt,
          serialize(document),
          projectId,
          baseRevision,
        ),
      );
    },

    compareAndSwapProjectWithWorkspace(
      baseWorkspaceRevision,
      baseProjectRevision,
      workspace,
      document,
    ) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (
          !changed(
            updateProjectStatement.run(
              document.revision,
              document.updatedAt,
              serialize(document),
              document.projectId,
              baseProjectRevision,
            ),
          )
        ) {
          database.exec("ROLLBACK");
          return false;
        }
        if (
          !changed(
            updateWorkspaceStatement.run(
              workspace.revision,
              serialize(workspace),
              baseWorkspaceRevision,
            ),
          )
        ) {
          database.exec("ROLLBACK");
          return false;
        }
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    moveProjectToTrash(projectId, trashTimestamp) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const inserted = trashProjectStatement.run(trashTimestamp, projectId);
        if (!changed(inserted)) {
          database.exec("ROLLBACK");
          return false;
        }
        if (!changed(deleteProjectStatement.run(projectId))) {
          throw new Error(`Project ${projectId} disappeared while moving it to trash`);
        }
        database.exec("COMMIT");
        return true;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    moveProjectToTrashWithWorkspace(
      baseWorkspaceRevision,
      workspace,
      projectId,
      trashTimestamp,
    ) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (!changed(trashProjectStatement.run(trashTimestamp, projectId))) {
          if (
            !changed(
              updateWorkspaceStatement.run(
                workspace.revision,
                serialize(workspace),
                baseWorkspaceRevision,
              ),
            )
          ) {
            database.exec("ROLLBACK");
            return "conflict";
          }
          database.exec("COMMIT");
          return "missing";
        }
        if (!changed(deleteProjectStatement.run(projectId))) {
          throw new Error(`Project ${projectId} disappeared while moving it to trash`);
        }
        if (
          !changed(
            updateWorkspaceStatement.run(
              workspace.revision,
              serialize(workspace),
              baseWorkspaceRevision,
            ),
          )
        ) {
          database.exec("ROLLBACK");
          return "conflict";
        }
        database.exec("COMMIT");
        return "moved";
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
