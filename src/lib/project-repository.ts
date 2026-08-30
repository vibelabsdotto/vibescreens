import { canonicalJson } from "./canonical-json";
import {
  normalizeProjectDocument,
  publishedVersionSnapshot,
  type ProjectDocumentV3,
  type VersionRecord,
} from "./project-schema";
import {
  createSqliteDocumentStore,
  type SqliteDocumentStore,
} from "./sqlite-storage";
import { assertProjectId, type ProjectId } from "./workspace";

export interface ProjectConflictMetadata {
  projectId: ProjectId;
  revision: number;
  updatedAt: string;
}

export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: ProjectId) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectAlreadyExistsError extends Error {
  constructor(public readonly projectId: ProjectId) {
    super(`Project ${projectId} already exists`);
    this.name = "ProjectAlreadyExistsError";
  }
}

export class ProjectRevisionConflictError extends Error {
  constructor(public readonly current: ProjectConflictMetadata) {
    super(
      `Project revision conflict: ${current.projectId} is at revision ${current.revision}`,
    );
    this.name = "ProjectRevisionConflictError";
  }
}

export class ProjectIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectIdentityMismatchError";
  }
}

export class PublishedVersionMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedVersionMutationError";
  }
}

export interface SaveDraftInput {
  projectId: ProjectId;
  baseRevision: number;
  document: ProjectDocumentV3;
  now?: string;
}

export interface MutateProjectInput {
  projectId: ProjectId;
  baseRevision: number;
  now?: string;
  mutate(
    current: ProjectDocumentV3,
  ): ProjectDocumentV3 | Promise<ProjectDocumentV3>;
}

export type TrashProjectResult =
  | { status: "moved"; trashPath: string }
  | { status: "missing" };

export interface ProjectRepository {
  exists(projectId: ProjectId): Promise<boolean>;
  read(projectId: ProjectId): Promise<ProjectDocumentV3>;
  create(document: ProjectDocumentV3): Promise<ProjectDocumentV3>;
  saveDraft(input: SaveDraftInput): Promise<ProjectDocumentV3>;
  mutate(input: MutateProjectInput): Promise<ProjectDocumentV3>;
  moveToTrash(projectId: ProjectId, trashTimestamp: string): Promise<TrashProjectResult>;
}

export interface ProjectRepositoryOptions {
  rootDir: string;
  store?: SqliteDocumentStore;
  now?: () => string;
}

const projectOperationTails = new Map<string, Promise<void>>();

async function withProjectQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectOperationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  projectOperationTails.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (projectOperationTails.get(key) === tail) {
      projectOperationTails.delete(key);
    }
  }
}

function conflictFor(document: ProjectDocumentV3): ProjectRevisionConflictError {
  return new ProjectRevisionConflictError({
    projectId: document.projectId,
    revision: document.revision,
    updatedAt: document.updatedAt,
  });
}

function assertBaseRevision(
  current: ProjectDocumentV3,
  baseRevision: number,
): void {
  if (baseRevision !== current.revision) throw conflictFor(current);
}

function assertProjectIdentity(
  expectedProjectId: ProjectId,
  current: ProjectDocumentV3,
  candidate: ProjectDocumentV3,
): void {
  if (
    candidate.projectId !== expectedProjectId ||
    candidate.projectId !== current.projectId
  ) {
    throw new ProjectIdentityMismatchError(
      `Candidate project ID ${candidate.projectId} does not match ${expectedProjectId}`,
    );
  }
  if (candidate.createdAt !== current.createdAt) {
    throw new ProjectIdentityMismatchError("Project createdAt is immutable");
  }
  if (candidate.name !== current.name) {
    throw new ProjectIdentityMismatchError("Project name must be changed through the workspace rename command");
  }
  if (canonicalJson(candidate.appOrder) !== canonicalJson(current.appOrder)) {
    throw new ProjectIdentityMismatchError("Internal App membership is immutable");
  }
  const candidateAppIds = Object.keys(candidate.appsById).sort();
  const currentAppIds = Object.keys(current.appsById).sort();
  if (canonicalJson(candidateAppIds) !== canonicalJson(currentAppIds)) {
    throw new ProjectIdentityMismatchError("Internal App membership is immutable");
  }
  for (const appId of current.appOrder) {
    const before = current.appsById[appId];
    const after = candidate.appsById[appId];
    if (
      after === undefined
      || after.id !== before.id
      || after.name !== before.name
      || after.createdAt !== before.createdAt
    ) {
      throw new ProjectIdentityMismatchError("Internal App identity is immutable");
    }
  }
}

function publishedVersions(document: ProjectDocumentV3): Map<string, {
  version: VersionRecord;
  snapshot: string;
}> {
  const published = new Map<string, { version: VersionRecord; snapshot: string }>();
  for (const [appId, app] of Object.entries(document.appsById)) {
    for (const [versionId, version] of Object.entries(app.versionsById)) {
      if (version.status === "published") {
        published.set(`${appId}\u0000${versionId}`, {
          version,
          snapshot: canonicalJson(
            publishedVersionSnapshot(document, app.id, version.id),
          ),
        });
      }
    }
  }
  return published;
}

function assertPublishedVersionsUnchanged(
  current: ProjectDocumentV3,
  candidate: ProjectDocumentV3,
  allowIntroducedPublished = false,
): void {
  const before = publishedVersions(current);
  const after = publishedVersions(candidate);
  for (const [key, sealed] of before) {
    const next = after.get(key);
    if (next === undefined || next.snapshot !== sealed.snapshot) {
      throw new PublishedVersionMutationError(
        `Published version ${sealed.version.id} cannot be mutated by a draft save`,
      );
    }
  }
  if (!allowIntroducedPublished) {
    for (const [key, sealed] of after) {
      if (!before.has(key)) {
        throw new PublishedVersionMutationError(
          `Published version ${sealed.version.id} cannot be introduced by a draft save`,
        );
      }
    }
  }
}

export function createProjectRepository(
  options: ProjectRepositoryOptions,
): ProjectRepository {
  const store = options.store ?? createSqliteDocumentStore(options.rootDir);
  const clock = options.now ?? (() => new Date().toISOString());

  const queueKey = (projectId: ProjectId) => {
    assertProjectId(projectId);
    return `${store.path}:${projectId}`;
  };

  const readUnsafe = async (projectId: ProjectId): Promise<ProjectDocumentV3> => {
    const stored = store.readProject(projectId);
    if (stored === undefined) throw new ProjectNotFoundError(projectId);
    const document = normalizeProjectDocument(stored);
    if (document.projectId !== projectId) {
      throw new ProjectIdentityMismatchError(
        `Stored project ID ${document.projectId} does not match path ID ${projectId}`,
      );
    }
    return document;
  };

  const persistCandidate = async (
    current: ProjectDocumentV3,
    candidateInput: ProjectDocumentV3,
    projectId: ProjectId,
    timestamp: string,
  ): Promise<ProjectDocumentV3> => {
    assertProjectIdentity(projectId, current, candidateInput);
    const candidate = structuredClone(candidateInput);
    candidate.revision = current.revision + 1;
    candidate.updatedAt = timestamp;
    const normalized = normalizeProjectDocument(candidate);
    if (!store.compareAndSwapProject(projectId, current.revision, normalized)) {
      const latest = store.readProject(projectId);
      if (latest === undefined) throw new ProjectNotFoundError(projectId);
      throw conflictFor(normalizeProjectDocument(latest));
    }
    return normalized;
  };

  return {
    async exists(projectId) {
      queueKey(projectId);
      return store.hasProject(projectId);
    },

    async read(projectId) {
      queueKey(projectId);
      return readUnsafe(projectId);
    },

    async create(document) {
      const projectId = document.projectId;
      const key = queueKey(projectId);
      return withProjectQueue(key, async () => {
        const normalized = normalizeProjectDocument(document);
        if (normalized.revision !== 1) {
          throw new TypeError("New projects must start at revision 1");
        }
        if (!store.createProject(normalized)) {
          throw new ProjectAlreadyExistsError(projectId);
        }
        return normalized;
      });
    },

    async saveDraft(input) {
      const key = queueKey(input.projectId);
      return withProjectQueue(key, async () => {
        const current = await readUnsafe(input.projectId);
        assertBaseRevision(current, input.baseRevision);
        if (input.document.revision !== input.baseRevision) {
          throw new ProjectIdentityMismatchError(
            "Candidate revision must equal baseRevision",
          );
        }
        assertProjectIdentity(input.projectId, current, input.document);
        assertPublishedVersionsUnchanged(current, input.document);
        return persistCandidate(
          current,
          input.document,
          input.projectId,
          input.now ?? clock(),
        );
      });
    },

    async mutate(input) {
      const key = queueKey(input.projectId);
      return withProjectQueue(key, async () => {
        const current = await readUnsafe(input.projectId);
        assertBaseRevision(current, input.baseRevision);
        const candidate = await input.mutate(structuredClone(current));
        assertPublishedVersionsUnchanged(current, candidate, true);
        return persistCandidate(
          current,
          candidate,
          input.projectId,
          input.now ?? clock(),
        );
      });
    },

    async moveToTrash(projectId, trashTimestamp) {
      const key = queueKey(projectId);
      return withProjectQueue(key, async () => {
        if (!store.moveProjectToTrash(projectId, trashTimestamp)) {
          return { status: "missing" };
        }
        return {
          status: "moved",
          trashPath: `${store.path}#project-trash/${trashTimestamp}/${projectId}`,
        };
      });
    },
  };
}
