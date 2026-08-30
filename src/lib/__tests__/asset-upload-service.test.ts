import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import { createProjectDocument, type DeckInput } from "../project-operations";
import { ProjectRevisionConflictError, PublishedVersionMutationError } from "../project-repository";
import { assetIdFor, type AssetRef, type ProjectDocumentV3 } from "../project-schema";
import { createWorkspaceProjectService, type WorkspaceProjectService } from "../server-service";
import type { ProjectId, WorkspaceRegistry } from "../workspace";
import {
  createAssetUploadService,
  type AssetUploadProjectService,
} from "../asset-upload-service";

const PROJECT_ID = "prj_upload" as ProjectId;
const APP_ID = "app_upload" as AppId;
const VERSION_ID = "ver_upload" as VersionId;
const DECK_ID = "deck_upload" as DeckId;
const NOW = "2026-08-28T12:00:00.000Z";
const PNG_BYTES = Buffer.from("89504e470d0a1a0a00000000", "hex");

function deck(): DeckInput {
  return {
    device: "iphone",
    orientation: "portrait",
    locale: "en",
    connectedCanvas: true,
    appName: "Upload App",
    themeId: "clean-light",
    fontId: "system-sans",
    appIcon: "",
    slides: [{ id: "slide-upload" } as never],
  };
}

function makeProject(): ProjectDocumentV3 {
  return createProjectDocument(deck(), {
    now: NOW,
    projectId: PROJECT_ID,
    projectName: "Upload Project",
    appId: APP_ID,
    appName: "Upload App",
    versionId: VERSION_ID,
    versionName: "Draft",
    deckId: DECK_ID,
  });
}

function workspace(): WorkspaceRegistry {
  return {
    schemaVersion: 1,
    revision: 1,
    activeProjectId: PROJECT_ID,
    projectOrder: [PROJECT_ID],
    projectsById: {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        name: "Upload Project",
        slug: "upload-project",
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as WorkspaceRegistry["projectsById"],
  };
}

function storedAsset(): AssetRef {
  const sha256 = "a".repeat(64);
  return {
    id: assetIdFor(VERSION_ID, "screenshot", sha256, "png"),
    scope: { appId: APP_ID, versionId: VERSION_ID },
    kind: "screenshot",
    originalName: "screen.png",
    mime: "image/png",
    bytes: PNG_BYTES.byteLength,
    sha256,
    extension: "png",
    url: `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/screenshots/${sha256}.png`,
  };
}

function projectService(
  project: ProjectDocumentV3,
  overrides: Partial<AssetUploadProjectService> = {},
): AssetUploadProjectService {
  return {
    getWorkspace: vi.fn(async () => ({ workspace: workspace(), projects: [] })),
    getProject: vi.fn(async () => project),
    saveProject: vi.fn(async (input) => {
      const saved = structuredClone(input.document);
      saved.revision = input.baseRevision + 1;
      return saved;
    }),
    ...overrides,
  } as AssetUploadProjectService;
}

describe("asset upload service", () => {
  it("keeps a freshly uploaded asset registered with the real repository", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vibescreens-real-upload-"));
    try {
      const projectApi = createWorkspaceProjectService({ rootDir });
      const created = await projectApi.executeWorkspaceCommand({
        action: "create",
        baseRevision: 0,
        name: "Upload Project",
      });
      const service = createAssetUploadService({ rootDir, projectService: projectApi });

      const result = await service.uploadAsset({
        projectId: created.project.projectId,
        kind: "screenshot",
        extension: "png",
        originalName: "screen.png",
        mime: "image/png",
        bytes: PNG_BYTES,
      });

      expect(result.project.revision).toBe(2);
      expect(result.project.assetsById[result.asset.id]).toEqual(result.asset);
      await expect(access(join(rootDir, "public", result.asset.url))).resolves.toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retries concurrent upload registration so both assets commit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vibescreens-concurrent-upload-"));
    try {
      const projectApi = createWorkspaceProjectService({ rootDir });
      const created = await projectApi.executeWorkspaceCommand({
        action: "create",
        baseRevision: 0,
        name: "Upload Project",
      });
      const service = createAssetUploadService({ rootDir, projectService: projectApi });
      const upload = (suffix: number) => service.uploadAsset({
        projectId: created.project.projectId,
        kind: "image",
        extension: "png",
        originalName: `overlay-${suffix}.png`,
        mime: "image/png",
        bytes: Buffer.concat([PNG_BYTES, Buffer.from([suffix])]),
      });

      const results = await Promise.all([upload(1), upload(2)]);
      const finalProject = await projectApi.getProject(created.project.projectId);

      expect(results.map((result) => result.asset.id)).toHaveLength(2);
      expect(Object.keys(finalProject.assetsById)).toHaveLength(2);
      expect(finalProject.revision).toBe(3);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("resolves the active project selection, stores SHA-256 bytes, and CAS-registers the full AssetRef", async () => {
    const project = makeProject();
    const projectApi = projectService(project);
    const asset = storedAsset();
    const storeAsset = vi.fn(async () => asset);
    const service = createAssetUploadService({
      rootDir: "/tmp/vibescreens-upload-test",
      projectService: projectApi,
      storeAsset,
    });

    const result = await service.uploadAsset({
      kind: "screenshot",
      extension: "png",
      originalName: "screen.png",
      mime: "image/png",
      bytes: PNG_BYTES,
    });

    expect(projectApi.getWorkspace).toHaveBeenCalledOnce();
    expect(projectApi.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(storeAsset).toHaveBeenCalledWith({
      rootDir: "/tmp/vibescreens-upload-test",
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "screenshot",
      extension: "png",
      originalName: "screen.png",
      mime: "image/png",
      bytes: PNG_BYTES,
    });
    expect(projectApi.saveProject).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      baseRevision: 1,
      document: expect.objectContaining({
        assetsById: { [asset.id]: asset },
      }),
    });
    expect(project.assetsById).toEqual({});
    expect(result).toEqual({ asset, project: expect.objectContaining({ revision: 2 }) });
  });

  it("uses a fully explicit validated target without consulting the active workspace", async () => {
    const project = makeProject();
    const projectApi = projectService(project);
    const asset = storedAsset();
    const storeAsset = vi.fn(async () => asset);
    const service = createAssetUploadService({ projectService: projectApi, storeAsset });

    await service.uploadAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "screenshot",
      extension: "png",
      bytes: PNG_BYTES,
    });

    expect(projectApi.getWorkspace).not.toHaveBeenCalled();
    expect(storeAsset).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, appId: APP_ID, versionId: VERSION_ID }),
    );
  });

  it("rejects invalid scope and traversal names before storing bytes or changing the registry", async () => {
    const project = makeProject();
    const projectApi = projectService(project);
    const storeAsset = vi.fn(async () => storedAsset());
    const service = createAssetUploadService({ projectService: projectApi, storeAsset });

    await expect(
      service.uploadAsset({
        projectId: PROJECT_ID,
        appId: "app_missing",
        versionId: VERSION_ID,
        kind: "screenshot",
        extension: "png",
        bytes: PNG_BYTES,
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      service.uploadAsset({
        kind: "screenshot",
        extension: "png",
        originalName: "../escape.png",
        bytes: PNG_BYTES,
      }),
    ).rejects.toThrow("plain filename");

    expect(storeAsset).not.toHaveBeenCalled();
    expect(projectApi.saveProject).not.toHaveBeenCalled();
    expect(project.assetsById).toEqual({});
  });

  it("rejects published targets before storing bytes", async () => {
    const project = makeProject();
    project.appsById[APP_ID].versionsById[VERSION_ID].status = "published";
    const projectApi = projectService(project);
    const storeAsset = vi.fn(async () => storedAsset());
    const service = createAssetUploadService({ projectService: projectApi, storeAsset });

    await expect(
      service.uploadAsset({
        kind: "screenshot",
        extension: "png",
        bytes: PNG_BYTES,
      }),
    ).rejects.toBeInstanceOf(PublishedVersionMutationError);
    expect(storeAsset).not.toHaveBeenCalled();
    expect(projectApi.saveProject).not.toHaveBeenCalled();
    expect(project.assetsById).toEqual({});
  });

  it("rejects a stored ref whose deterministic asset ID is inconsistent", async () => {
    const project = makeProject();
    const projectApi = projectService(project);
    const malformed = { ...storedAsset(), id: "asset_wrong" as AssetRef["id"] };
    const service = createAssetUploadService({
      projectService: projectApi,
      storeAsset: vi.fn(async () => malformed),
    });

    await expect(
      service.uploadAsset({
        kind: "screenshot",
        extension: "png",
        bytes: PNG_BYTES,
      }),
    ).rejects.toThrow("requested project scope");
    expect(projectApi.saveProject).not.toHaveBeenCalled();
    expect(project.assetsById).toEqual({});
  });

  it("never exposes an unregistered asset when the CAS save is stale", async () => {
    const project = makeProject();
    const asset = storedAsset();
    const conflict = new ProjectRevisionConflictError({
      projectId: PROJECT_ID,
      revision: 2,
      updatedAt: NOW,
    });
    const projectApi = projectService(project, {
      saveProject: vi.fn(async () => {
        throw conflict;
      }) as WorkspaceProjectService["saveProject"],
    });
    const service = createAssetUploadService({
      projectService: projectApi,
      storeAsset: vi.fn(async () => asset),
    });

    await expect(
      service.uploadAsset({
        kind: "screenshot",
        extension: "png",
        bytes: PNG_BYTES,
      }),
    ).rejects.toBe(conflict);
    expect(project.assetsById).toEqual({});
  });
});
