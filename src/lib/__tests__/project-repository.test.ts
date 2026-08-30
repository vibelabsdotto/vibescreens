import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import { createProjectDocument, publishVersion } from "../project-operations";

import {
  ProjectAlreadyExistsError,
  ProjectIdentityMismatchError,
  ProjectRevisionConflictError,
  createProjectRepository,
} from "../project-repository";
import type { ProjectDocumentV3 } from "../project-schema";
import { vibeScreensDatabasePath } from "../sqlite-storage";
import type { ProjectId } from "../workspace";

const PROJECT_ID = "prj_repository" as ProjectId;
const APP_ID = "app_repository" as AppId;
const VERSION_ID = "ver_repository" as VersionId;
const DECK_ID = "deck_repository" as DeckId;
const timestamp = "2026-08-28T00:00:00.000Z";
const later = "2026-08-28T01:00:00.000Z";
const temporaryDirectories: string[] = [];

function makeProject(projectId = PROJECT_ID): ProjectDocumentV3 {
  return createProjectDocument(
    {
      device: "iphone",
      orientation: "portrait",
      locale: "en",
      connectedCanvas: true,
      appName: "Rendered App",
      themeId: "clean-light",
      fontId: "system-sans",
      appIcon: "",
      slides: [{ id: "slide-one" } as never],
    },
    {
      now: timestamp,
      projectId,
      projectName: "Repository Project",
      appId: APP_ID,
      versionId: VERSION_ID,
      deckId: DECK_ID,
    },
  );
}

async function useRepository() {
  const rootDir = await mkdtemp(join(tmpdir(), "vibescreens-project-repository-"));
  temporaryDirectories.push(rootDir);
  return { rootDir, repository: createProjectRepository({ rootDir }) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("project repository", () => {
  it("creates and reads a validated revision-one project without overwriting it", async () => {
    const { repository } = await useRepository();
    const project = makeProject();

    await expect(repository.create(project)).resolves.toEqual(project);
    await expect(repository.read(PROJECT_ID)).resolves.toEqual(project);
    await expect(repository.create(project)).rejects.toBeInstanceOf(
      ProjectAlreadyExistsError,
    );
  });

  it("persists a successful compare-and-swap at exactly current revision plus one", async () => {
    const { rootDir, repository } = await useRepository();
    const project = makeProject();
    await repository.create(project);
    const candidate = structuredClone(project);
    candidate.appsById[APP_ID].versionsById[VERSION_ID].decksById[
      DECK_ID
    ].appName = "Changed";

    const saved = await repository.saveDraft({
      projectId: PROJECT_ID,
      baseRevision: 1,
      document: candidate,
      now: later,
    });

    expect(saved).toMatchObject({ revision: 2, updatedAt: later });
    expect(
      saved.appsById[APP_ID].versionsById[VERSION_ID].decksById[DECK_ID].appName,
    ).toBe("Changed");
    await expect(repository.read(PROJECT_ID)).resolves.toEqual(saved);
  });

  it("rejects stale writes with current metadata and leaves the durable bytes unchanged", async () => {
    const { rootDir, repository } = await useRepository();
    await repository.create(makeProject());
    const firstCandidate = makeProject();
    firstCandidate.appsById[APP_ID].versionsById[VERSION_ID].decksById[DECK_ID].appName = "First";
    const first = await repository.saveDraft({
      projectId: PROJECT_ID,
      baseRevision: 1,
      document: firstCandidate,
      now: later,
    });
    const beforeConflict = await repository.read(PROJECT_ID);

    let conflict: unknown;
    try {
      await repository.saveDraft({
        projectId: PROJECT_ID,
        baseRevision: 1,
        document: makeProject(),
        now: later,
      });
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(ProjectRevisionConflictError);
    expect(conflict).toMatchObject({
      current: {
        projectId: PROJECT_ID,
        revision: 2,
        updatedAt: later,
      },
    });
    expect(first.revision).toBe(2);
    await expect(repository.read(PROJECT_ID)).resolves.toEqual(beforeConflict);
  });

  it("serializes concurrent same-base writes so exactly one succeeds", async () => {
    const { repository } = await useRepository();
    await repository.create(makeProject());
    const firstCandidate = makeProject();
    const secondCandidate = makeProject();
    firstCandidate.appsById[APP_ID].versionsById[VERSION_ID].decksById[DECK_ID].appName = "First";
    secondCandidate.appsById[APP_ID].versionsById[VERSION_ID].decksById[DECK_ID].appName = "Second";

    const results = await Promise.allSettled([
      repository.saveDraft({
        projectId: PROJECT_ID,
        baseRevision: 1,
        document: firstCandidate,
        now: later,
      }),
      repository.saveDraft({
        projectId: PROJECT_ID,
        baseRevision: 1,
        document: secondCandidate,
        now: later,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ProjectRevisionConflictError);
    expect((await repository.read(PROJECT_ID)).revision).toBe(2);
  });

  it("prevents generic saves from changing the internal App wrapper", async () => {
    const { repository } = await useRepository();
    const project = makeProject();
    await repository.create(project);
    const candidate = structuredClone(project);
    candidate.appsById[APP_ID].name = "Hidden second product";

    await expect(repository.saveDraft({
      projectId: PROJECT_ID,
      baseRevision: 1,
      document: candidate,
      now: later,
    })).rejects.toBeInstanceOf(ProjectIdentityMismatchError);
  });

  it("prevents client saves from mutating published content", async () => {
    const { repository } = await useRepository();
    const published = await publishVersion(makeProject(), APP_ID, VERSION_ID, {
      now: later,
    });
    published.revision = 1;
    await repository.create(published);
    const tampered = structuredClone(published);
    tampered.appsById[APP_ID].versionsById[VERSION_ID].decksById[
      DECK_ID
    ].appName = "Tampered";

    await expect(
      repository.saveDraft({
        projectId: PROJECT_ID,
        baseRevision: 1,
        document: tampered,
        now: later,
      }),
    ).rejects.toThrow("Published version");
    expect(
      (await repository.read(PROJECT_ID)).appsById[APP_ID].versionsById[VERSION_ID]
        .decksById[DECK_ID].appName,
    ).toBe("Rendered App");
  });

  it("prevents generic mutations from changing a published snapshot's scoped assets", async () => {
    const { repository } = await useRepository();
    const draft = makeProject();
    const sha256 = "e".repeat(64);
    const url = `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/screenshots/${sha256}.png`;
    draft.appsById[APP_ID].versionsById[VERSION_ID].decksById[DECK_ID].slides[0].screenshot =
      url;
    draft.assetsById = {
      asset_screen: {
        id: "asset_screen",
        scope: { appId: APP_ID, versionId: VERSION_ID },
        kind: "screenshot",
        originalName: "screen.png",
        mime: "image/png",
        bytes: 10,
        sha256,
        extension: "png",
        url,
      },
    } as ProjectDocumentV3["assetsById"];
    const published = await publishVersion(draft, APP_ID, VERSION_ID, { now: later });
    published.revision = 1;
    await repository.create(published);

    await expect(
      repository.mutate({
        projectId: PROJECT_ID,
        baseRevision: 1,
        now: later,
        mutate(candidate) {
          Object.values(candidate.assetsById)[0].originalName = "tampered.png";
          return candidate;
        },
      }),
    ).rejects.toThrow("Published version");
  });

  it("preserves registered draft assets until explicit garbage collection", async () => {
    const { repository } = await useRepository();
    const project = makeProject();
    const shaA = "1".repeat(64);
    const shaB = "2".repeat(64);
    const urlA = `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/screenshots/${shaA}.png`;
    const urlB = `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/screenshots/${shaB}.png`;
    project.appsById[APP_ID].versionsById[VERSION_ID].decksById[DECK_ID].slides[0].screenshot =
      urlA;
    project.assetsById = {
      asset_a: {
        id: "asset_a",
        scope: { appId: APP_ID, versionId: VERSION_ID },
        kind: "screenshot",
        originalName: "a.png",
        mime: "image/png",
        bytes: 10,
        sha256: shaA,
        extension: "png",
        url: urlA,
      },
      asset_orphan: {
        id: "asset_orphan",
        scope: { appId: APP_ID, versionId: VERSION_ID },
        kind: "screenshot",
        originalName: "orphan.png",
        mime: "image/png",
        bytes: 10,
        sha256: shaB,
        extension: "png",
        url: urlB,
      },
    } as ProjectDocumentV3["assetsById"];
    await repository.create(project);

    const saved = await repository.saveDraft({
      projectId: PROJECT_ID,
      baseRevision: 1,
      document: structuredClone(project),
      now: later,
    });

    expect(Object.keys(saved.assetsById)).toEqual(["asset_a", "asset_orphan"]);
  });

  it("rejects identity changes and traversal IDs before writing", async () => {
    const { repository } = await useRepository();
    await repository.create(makeProject());
    const mismatched = makeProject("prj_other" as ProjectId);

    await expect(
      repository.saveDraft({
        projectId: PROJECT_ID,
        baseRevision: 1,
        document: mismatched,
        now: later,
      }),
    ).rejects.toBeInstanceOf(ProjectIdentityMismatchError);
    await expect(
      repository.read("prj_../escape" as ProjectId),
    ).rejects.toThrow("Invalid project ID");
  });

  it("moves a project to trash under the same per-project serialization boundary", async () => {
    const { rootDir, repository } = await useRepository();
    await repository.create(makeProject());

    const moved = await repository.moveToTrash(
      PROJECT_ID,
      "2026-08-28T010000000Z",
    );

    expect(moved).toMatchObject({ status: "moved" });
    await expect(repository.read(PROJECT_ID)).rejects.toThrow("does not exist");
    const database = new DatabaseSync(vibeScreensDatabasePath(rootDir), { readOnly: true });
    const trashed = database
      .prepare("SELECT document FROM project_trash WHERE project_id = ?")
      .get(PROJECT_ID) as { document: string };
    database.close();
    expect(JSON.parse(trashed.document)).toMatchObject({ projectId: PROJECT_ID });
  });
});
