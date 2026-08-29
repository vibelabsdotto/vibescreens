import { access, mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriteJson } from "./atomic-write";
import { canonicalJson } from "./canonical-json";
import { pruneUnreachableDraftAssets } from "./project-operations";
import {
  projectDocumentPath,
  projectRoot,
  projectTrashPath,
} from "./project-paths";
import {
  normalizeProjectDocument,
  publishedVersionSnapshot,
  type ProjectDocumentV3,
  type VersionRecord,
} from "./project-schema";
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
  writeJson?: (targetPath: string, data: unknown) => Promise<void>;
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
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
  const writeJson = options.writeJson ?? atomicWriteJson;
  const clock = options.now ?? (() => new Date().toISOString());

  const queueKey = (projectId: ProjectId) => {
    assertProjectId(projectId);
    return projectRoot(options.rootDir, projectId);
  };

  const readUnsafe = async (projectId: ProjectId): Promise<ProjectDocumentV3> => {
    const path = projectDocumentPath(options.rootDir, projectId);
    let serialized: string;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) throw new ProjectNotFoundError(projectId);
      throw error;
    }
    const document = normalizeProjectDocument(JSON.parse(serialized) as unknown);
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
    // Replacing/clearing managed references otherwise strands their registry
    // entries forever and makes the draft unpublishable; published entries are
    // protected (prune only touches drafts).
    pruneUnreachableDraftAssets(candidate);
    candidate.revision = current.revision + 1;
    candidate.updatedAt = timestamp;
    const normalized = normalizeProjectDocument(candidate);
    await writeJson(projectDocumentPath(options.rootDir, projectId), normalized);
    return normalized;
  };

  return {
    async exists(projectId) {
      queueKey(projectId);
      try {
        await access(projectDocumentPath(options.rootDir, projectId));
        return true;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
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
        try {
          await access(projectDocumentPath(options.rootDir, projectId));
          throw new ProjectAlreadyExistsError(projectId);
        } catch (error) {
          if (error instanceof ProjectAlreadyExistsError) throw error;
          if (!isNotFoundError(error)) throw error;
        }
        await writeJson(projectDocumentPath(options.rootDir, projectId), normalized);
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
        const source = projectRoot(options.rootDir, projectId);
        const destination = projectTrashPath(
          options.rootDir,
          projectId,
          trashTimestamp,
        );
        try {
          await access(source);
        } catch (error) {
          if (isNotFoundError(error)) return { status: "missing" };
          throw error;
        }
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
        return { status: "moved", trashPath: destination };
      });
    },
  };
}
