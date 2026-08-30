import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import type { DeckInput } from "../project-operations";
import type { ProjectId } from "../workspace";
import { createWorkspaceProjectService } from "../server-service";

const NOW = "2026-08-28T12:00:00.000Z";
const roots: string[] = [];

function deck(locale = "en"): DeckInput {
  return {
    device: "iphone",
    orientation: "portrait",
    locale,
    connectedCanvas: true,
    appName: "Rendered App",
    themeId: "clean-light",
    fontId: "system-sans",
    appIcon: "",
    slides: [{ id: `slide-${locale}` } as never],
  };
}

async function setup(
  now: () => string = () => NOW,
  removeVersionAssets?: (directory: string) => Promise<void>,
) {
  const rootDir = await mkdtemp(join(tmpdir(), "vibescreens-server-service-"));
  roots.push(rootDir);
  const projectIds = ["prj_one" as ProjectId, "prj_two" as ProjectId];
  const appIds = ["app_initial" as AppId, "app_second" as AppId];
  const versionIds = [
    "ver_initial" as VersionId,
    "ver_second_app" as VersionId,
    "ver_release" as VersionId,
    "ver_clone" as VersionId,
  ];
  const deckIds = [
    "deck_initial" as DeckId,
    "deck_second_app" as DeckId,
    "deck_release" as DeckId,
  ];
  const cloneAssets = vi.fn(async () => undefined);
  const service = createWorkspaceProjectService({
    rootDir,
    now,
    createProjectId: () => projectIds.shift()!,
    createAppId: () => appIds.shift()!,
    createVersionId: () => versionIds.shift()!,
    createDeckId: () => deckIds.shift()!,
    createInitialDeck: () => deck(),
    cloneVersionAssets: cloneAssets,
    removeVersionAssets,
  });
  return { service, cloneAssets, rootDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace/project server service", () => {
  it("rejects the removed public App lifecycle", async () => {
    const { service } = await setup();
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });

    await expect(service.executeProjectCommand(created.project.projectId, {
      action: "createApp",
      baseRevision: created.project.revision,
      name: "Second App",
      initialDeck: deck("de"),
    } as never)).rejects.toThrow("Unsupported project action: createApp");
  });

  it("creates, summarizes, switches, renames, and deletes independent projects", async () => {
    const { service } = await setup();

    const first = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "First Project",
    });
    const second = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: first.workspace.revision,
      name: "Second Project",
    });

    const summary = await service.getWorkspace();
    expect(summary.workspace.activeProjectId).toBe("prj_two");
    expect(summary.projects).toEqual([
      expect.objectContaining({
        projectId: "prj_one",
        name: "First Project",
        revision: 1,
      }),
      expect.objectContaining({
        projectId: "prj_two",
        name: "Second Project",
        revision: 1,
      }),
    ]);

    const switched = await service.executeWorkspaceCommand({
      action: "switch",
      baseRevision: second.workspace.revision,
      projectId: first.project.projectId,
    });
    expect(switched.workspace.activeProjectId).toBe(first.project.projectId);

    const renamed = await service.executeWorkspaceCommand({
      action: "rename",
      baseWorkspaceRevision: switched.workspace.revision,
      baseProjectRevision: first.project.revision,
      projectId: first.project.projectId,
      name: "Renamed Project",
    });
    expect(renamed.project).toMatchObject({ name: "Renamed Project", revision: 2 });

    const deleted = await service.executeWorkspaceCommand({
      action: "delete",
      baseRevision: renamed.workspace.revision,
      projectId: first.project.projectId,
    });
    expect(deleted.workspace).toMatchObject({
      activeProjectId: "prj_two",
      projectOrder: ["prj_two"],
    });
    await expect(service.getProject(first.project.projectId)).rejects.toThrow();
  });

  it("executes version lifecycle commands under project revision checks", async () => {
    const { service, cloneAssets } = await setup();
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });
    const projectId = created.project.projectId;
    const initialAppId = created.project.selection.appId;
    const initialVersionId = created.project.selection.versionId;

    const withVersion = await service.executeProjectCommand(projectId, {
      action: "createVersion",
      baseRevision: created.project.revision,
      name: "Release 2",
      initialDeck: deck("fr"),
    });
    expect(withVersion.project.selection.versionId).toBe("ver_second_app");

    const published = await service.executeProjectCommand(projectId, {
      action: "publishVersion",
      baseRevision: withVersion.project.revision,
      versionId: initialVersionId,
    });
    expect(
      published.project.appsById[initialAppId].versionsById[initialVersionId],
    ).toMatchObject({ status: "published", publishedAt: NOW });

    await expect(
      service.executeProjectCommand(projectId, {
        action: "renameVersion",
        baseRevision: published.project.revision,
        versionId: initialVersionId,
        name: "Forbidden Rename",
      }),
    ).rejects.toMatchObject({ code: "published_immutable" });

    const cloned = await service.executeProjectCommand(projectId, {
      action: "cloneVersion",
      baseRevision: published.project.revision,
      sourceVersionId: initialVersionId,
      name: "Editable Copy",
    });
    expect(cloned.project.selection.versionId).toBe("ver_release");
    expect(
      cloned.project.appsById[initialAppId].versionsById["ver_release" as VersionId],
    ).toMatchObject({
      status: "draft",
      sourceVersionId: initialVersionId,
    });
    expect(cloneAssets).toHaveBeenCalledWith({
      rootDir: expect.any(String),
      projectId,
      appId: initialAppId,
      sourceVersionId: initialVersionId,
      targetVersionId: "ver_release",
      assets: expect.any(Array),
    });
  });

  it("passes the source version's registered assets to the asset cloner", async () => {
    const { service, cloneAssets } = await setup();
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });
    const projectId = created.project.projectId;
    const appId = created.project.selection.appId;
    const sourceVersionId = created.project.selection.versionId;
    const registeredAsset = {
      id: "asset_clone" as never,
      kind: "screenshot" as const,
      scope: { appId, versionId: sourceVersionId },
      originalName: "screen.png",
      mime: "image/png",
      bytes: 12,
      sha256: "a".repeat(64),
      extension: "png",
      url: "/vibescreens-assets/prj_one/app_initial/ver_initial/screenshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    };
    // Register the asset and reference it from the source deck so it is
    // reachable; unreachable registry entries are pruned by design.
    const deckId = created.project.selection.deckId;
    const withAsset = await service.saveProject({
      projectId,
      baseRevision: created.project.revision,
      document: {
        ...created.project,
        assetsById: { asset_clone: registeredAsset },
        appsById: {
          ...created.project.appsById,
          [appId]: {
            ...created.project.appsById[appId],
            versionsById: {
              ...created.project.appsById[appId].versionsById,
              [sourceVersionId]: {
                ...created.project.appsById[appId].versionsById[sourceVersionId],
                decksById: {
                  ...created.project.appsById[appId].versionsById[sourceVersionId].decksById,
                  [deckId]: {
                    ...created.project.appsById[appId].versionsById[sourceVersionId]
                      .decksById[deckId],
                    slides: [
                      {
                        ...created.project.appsById[appId].versionsById[sourceVersionId]
                          .decksById[deckId].slides[0],
                        screenshot: registeredAsset.url,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      } as typeof created.project,
    });

    await service.executeProjectCommand(projectId, {
      action: "cloneVersion",
      baseRevision: withAsset.revision,
      sourceVersionId,
      name: "Verified Copy",
    });
    const cloned = await service.getProject(projectId);
    const clonedVersionId = cloned.appsById[appId].versionOrder.find(
      (id) => id !== sourceVersionId,
    );
    expect(clonedVersionId).toBeDefined();

    expect(cloneAssets).toHaveBeenCalledTimes(1);
    const calls = cloneAssets.mock
      .calls as unknown as Array<
      Array<{
        projectId: string;
        sourceVersionId: string;
        targetVersionId: string;
        assets?: Array<{ id: string; sha256: string }>;
      }>
    >;
    const call = calls[0]![0]!;
    expect(call.projectId).toBe(projectId);
    expect(call.sourceVersionId).toBe(sourceVersionId);
    expect(call.targetVersionId).toBe(clonedVersionId);
    expect(Array.isArray(call.assets)).toBe(true);
    expect(call.assets?.length).toBe(1);
    expect(call.assets?.[0]).toMatchObject({ id: "asset_clone", sha256: "a".repeat(64) });
  });

  it("removes a deleted version's registry entries and asset scope from the project", async () => {
    const { service } = await setup();
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });
    const projectId = created.project.projectId;
    const appId = created.project.selection.appId;
    const versionId = created.project.selection.versionId;
    const assetUrl = `/vibescreens-assets/${projectId}/${appId}/${versionId}/screenshots/${"7".repeat(64)}.png`;
    const registeredAsset = {
      id: "asset_delete" as never,
      kind: "screenshot" as const,
      scope: { appId, versionId },
      originalName: "screen.png",
      mime: "image/png",
      bytes: 12,
      sha256: "7".repeat(64),
      extension: "png",
      url: assetUrl,
    };
    const deckId = created.project.selection.deckId;
    const withAsset = await service.saveProject({
      projectId,
      baseRevision: created.project.revision,
      document: {
        ...created.project,
        assetsById: { asset_delete: registeredAsset },
        appsById: {
          ...created.project.appsById,
          [appId]: {
            ...created.project.appsById[appId],
            versionsById: {
              ...created.project.appsById[appId].versionsById,
              [versionId]: {
                ...created.project.appsById[appId].versionsById[versionId],
                decksById: {
                  ...created.project.appsById[appId].versionsById[versionId].decksById,
                  [deckId]: {
                    ...created.project.appsById[appId].versionsById[versionId].decksById[deckId],
                    slides: [
                      {
                        ...created.project.appsById[appId].versionsById[versionId]
                          .decksById[deckId].slides[0],
                        screenshot: assetUrl,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      } as typeof created.project,
    });
    // A version cannot be deleted while it is the only one, so add a second.
    const withSecond = await service.executeProjectCommand(projectId, {
      action: "createVersion",
      baseRevision: withAsset.revision,
      name: "Second",
      initialDeck: {
        device: "iphone",
        orientation: "portrait",
        locale: "en",
        connectedCanvas: true,
        appName: "App",
        themeId: "clean-light",
        fontId: "system-sans",
        appIcon: "",
        slides: [],
      },
    });

    await service.executeProjectCommand(projectId, {
      action: "deleteVersion",
      baseRevision: withSecond.project.revision,
      versionId,
    });

    const after = await service.getProject(projectId);
    expect(after.appsById[appId].versionsById[versionId]).toBeUndefined();
    expect(Object.keys(after.assetsById)).toEqual([]);
  });

  it("stages deleted-version assets before commit and reports deferred cleanup", async () => {
    const removeVersionAssets = vi.fn(async () => {
      throw new Error("injected cleanup failure");
    });
    const { service, rootDir } = await setup(() => NOW, removeVersionAssets);
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });
    const projectId = created.project.projectId;
    const appId = created.project.selection.appId;
    const versionId = created.project.selection.versionId;
    const sourceDirectory = join(
      rootDir,
      "public",
      "vibescreens-assets",
      projectId,
      appId,
      versionId,
    );
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "asset.png"), "bytes");
    const withSecond = await service.executeProjectCommand(projectId, {
      action: "createVersion",
      baseRevision: created.project.revision,
      name: "Second",
      initialDeck: deck(),
    });

    const deleted = await service.executeProjectCommand(projectId, {
      action: "deleteVersion",
      baseRevision: withSecond.project.revision,
      versionId,
    });

    expect(deleted.assetCleanupPending).toBe(true);
    await expect(access(sourceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.getProject(projectId)).appsById[appId].versionsById[versionId])
      .toBeUndefined();
    expect(removeVersionAssets).toHaveBeenCalledOnce();
  });

  it("uses one timestamp for every record changed by a project command", async () => {
    const clock = vi.fn(() => NOW);
    const { service } = await setup(clock);
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });
    const commandTime = "2026-08-28T13:00:00.000Z";
    clock.mockReset();
    clock
      .mockReturnValueOnce(commandTime)
      .mockReturnValueOnce("2026-08-28T13:00:01.000Z");

    const result = await service.executeProjectCommand(created.project.projectId, {
      action: "renameVersion",
      baseRevision: created.project.revision,
      versionId: created.project.selection.versionId,
      name: "Renamed Version",
    });

    expect(result.project.updatedAt).toBe(commandTime);
    expect(
      result.project.appsById[result.project.selection.appId]
        .versionsById[result.project.selection.versionId].updatedAt,
    ).toBe(commandTime);
  });

  it("saves a full draft document but rejects stale revisions", async () => {
    const { service } = await setup();
    const created = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: 0,
      name: "Project",
    });
    const candidate = structuredClone(created.project);
    const app = candidate.appsById[candidate.selection.appId];
    app.versionsById[candidate.selection.versionId]
      .decksById[candidate.selection.deckId].appName = "Edited deck";

    const saved = await service.saveProject({
      projectId: created.project.projectId,
      baseRevision: created.project.revision,
      document: candidate,
    });
    expect(saved).toMatchObject({ revision: 2 });
    expect(
      saved.appsById[saved.selection.appId]
        .versionsById[saved.selection.versionId]
        .decksById[saved.selection.deckId].appName,
    ).toBe("Edited deck");

    await expect(
      service.saveProject({
        projectId: created.project.projectId,
        baseRevision: created.project.revision,
        document: candidate,
      }),
    ).rejects.toMatchObject({ current: { revision: 2 } });
  });
});
