import { describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "../canonical-json";
import {
  ExportPlanError,
  buildExportPlan,
  type ExportScope,
} from "../export-plan";
import type { AppId, DeckId, VersionId } from "../ids";
import { publishVersion } from "../project-operations";
import {
  assetIdFor,
  computePublishedVersionContentHash,
  type AppRecord,
  type AssetRef,
  type DeckRecord,
  type ProjectDocumentV3,
  type VersionRecord,
} from "../project-schema";
import type { Slide, SlideLayout } from "../types";

const timestamp = "2026-08-28T00:00:00.000Z";
const appA = "app_a11111111" as AppId;
const appB = "app_b22222222" as AppId;
const draftA = "ver_adraft111" as VersionId;
const publishedA = "ver_apub111111" as VersionId;
const publishedB = "ver_bpub222222" as VersionId;
const deckDraftA = "deck_adraft11" as DeckId;
const deckPublishedA = "deck_apub1111" as DeckId;
const deckPublishedB = "deck_bpub2222" as DeckId;

function makeSlide(
  id: string,
  layout: SlideLayout = "hero",
  screenshot = `/screenshots/${id}.png`,
): Slide {
  return {
    id,
    layout,
    label: { en: "Label" },
    headline: { en: "Headline" },
    screenshot,
  };
}

function makeDeck(
  id: DeckId,
  overrides: Partial<DeckRecord> = {},
): DeckRecord {
  return {
    id,
    device: "iphone",
    orientation: "portrait",
    locale: "en-US",
    connectedCanvas: true,
    appName: "Rendered App",
    themeId: "clean-light",
    fontId: "system-sans",
    appIcon: "",
    slides: [makeSlide("slide-one-111111"), makeSlide("slide-two-222222")],
    ...overrides,
  };
}

function publishedVersion(
  id: VersionId,
  name: string,
  deck: DeckRecord,
): VersionRecord {
  return {
    id,
    name,
    status: "published",
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: timestamp,
    contentHash: "0".repeat(64),
    deckOrder: [deck.id],
    decksById: { [deck.id]: deck } as Record<DeckId, DeckRecord>,
  };
}

async function registerPublishedScreenshots(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
): Promise<void> {
  const version = document.appsById[appId].versionsById[versionId];
  for (const deck of Object.values(version.decksById)) {
    for (const slide of deck.slides) {
      const sha256 = await sha256CanonicalJson({ appId, versionId, slideId: slide.id });
      const id = assetIdFor(versionId, "screenshot", sha256, "png");
      const url = `/vibescreens-assets/${document.projectId}/${appId}/${versionId}/screenshots/${sha256}.png`;
      slide.screenshot = url;
      document.assetsById[id] = {
        id,
        scope: { appId, versionId },
        kind: "screenshot",
        originalName: `${slide.id}.png`,
        mime: "image/png",
        bytes: 10,
        sha256,
        extension: "png",
        url,
      } satisfies AssetRef;
    }
  }
  version.contentHash = await computePublishedVersionContentHash(
    document,
    appId,
    versionId,
  );
}

async function makeDocument(): Promise<ProjectDocumentV3> {
  const bDeck = makeDeck(deckPublishedB, {
    device: "android-7",
    orientation: "landscape",
    locale: "fr-FR",
    slides: [makeSlide("slide-b-22222222")],
  });
  const aPublishedDeck = makeDeck(deckPublishedA);
  const aDraftDeck = makeDeck(deckDraftA, {
    device: "android",
    locale: "de-DE",
    slides: [makeSlide("slide-draft-1111")],
  });

  const bPublished = publishedVersion(publishedB, "Launch", bDeck);
  const aPublished = publishedVersion(publishedA, "Launch", aPublishedDeck);
  const aDraft: VersionRecord = {
    id: draftA,
    name: "Next Release",
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    deckOrder: [deckDraftA],
    decksById: { [deckDraftA]: aDraftDeck } as Record<DeckId, DeckRecord>,
  };

  const aRecord: AppRecord = {
    id: appA,
    name: "Creme Studio",
    createdAt: timestamp,
    updatedAt: timestamp,
    versionOrder: [publishedA, draftA],
    versionsById: {
      [draftA]: aDraft,
      [publishedA]: aPublished,
    } as Record<VersionId, VersionRecord>,
  };
  const bRecord: AppRecord = {
    id: appB,
    name: "Crème Studio",
    createdAt: timestamp,
    updatedAt: timestamp,
    versionOrder: [publishedB],
    versionsById: { [publishedB]: bPublished } as Record<VersionId, VersionRecord>,
  };

  const document: ProjectDocumentV3 = {
    schemaVersion: 3,
    projectId: "prj_exports" as ProjectDocumentV3["projectId"],
    name: "Export Project",
    revision: 7,
    createdAt: timestamp,
    updatedAt: timestamp,
    appOrder: [appB, appA],
    appsById: {
      [appA]: aRecord,
      [appB]: bRecord,
    } as Record<AppId, AppRecord>,
    assetsById: {},
    selection: {
      appId: appA,
      versionId: draftA,
      deckId: deckDraftA,
      slideId: "slide-draft-1111",
    },
  };
  await registerPublishedScreenshots(document, appB, publishedB);
  await registerPublishedScreenshots(document, appA, publishedA);
  return document;
}

async function plan(
  scope: ExportScope,
  document?: ProjectDocumentV3,
) {
  return buildExportPlan(document ?? (await makeDocument()), scope, {
    createdAt: "2026-08-28T01:02:03.000Z",
    rendererVersion: "test-renderer@1",
  });
}

describe("buildExportPlan", () => {
  it("expands the current version into deterministic ordered jobs and a manifest", async () => {
    const result = await plan({ kind: "current" });

    expect(result.versions.map((version) => [version.appId, version.versionId])).toEqual([
      [appA, draftA],
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      appId: appA,
      versionId: draftA,
      deckId: deckDraftA,
      slideId: "slide-draft-1111",
      platform: "android",
      device: "android",
      orientation: "portrait",
      locale: "de-DE",
      width: 1080,
      height: 1920,
      slideIndex: 0,
      relativePath:
        "versions/next-release--adraft11/draft/android/android/portrait/de-de/1080x1920/01-draft-11-hero.png",
    });
    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      createdAt: "2026-08-28T01:02:03.000Z",
      rendererVersion: "test-renderer@1",
      complete: true,
      plannedJobCount: 1,
      project: { id: "prj_exports", revision: 7 },
      scope: { kind: "current" },
    });
    expect(result.manifest.versions[0]).toMatchObject({
      status: "draft",
      projectRevision: 7,
      jobCount: 1,
    });
    expect(result.manifest.versions[0]).not.toHaveProperty("appId");
    expect(result.manifest.versions[0]).not.toHaveProperty("appName");
    expect(result.manifest.jobs[0]).not.toHaveProperty("appId");
  });

  it("deduplicates selected versions and sorts them by app/version order, not request order", async () => {
    const result = await plan({
      kind: "selected",
      versions: [
        { appId: appA, versionId: publishedA },
        { appId: appB, versionId: publishedB },
        { appId: appA, versionId: publishedA },
      ],
    });

    expect(result.versions.map((version) => [version.appId, version.versionId])).toEqual([
      [appB, publishedB],
      [appA, publishedA],
    ]);
    expect(result.jobs).toHaveLength(9);
    expect(result.jobs[0].relativePath).toBe(
      "versions/launch--bpub2222/published/android/android-7/landscape/fr-fr/1920x1200/01-b-222222-hero.png",
    );
    expect(result.jobs[1]).toMatchObject({
      appId: appA,
      versionId: publishedA,
      width: 1320,
      height: 2868,
      slideIndex: 0,
    });
    expect(result.manifest.versions).toHaveLength(2);
    expect(result.manifest.versions.every((version) => version.status === "published")).toBe(
      true,
    );
  });

  it("exports only published versions for all scope unless drafts are explicitly included", async () => {
    const publishedOnly = await plan({ kind: "all" });
    const withDrafts = await plan({ kind: "all", includeDrafts: true });

    expect(publishedOnly.versions.map((version) => version.versionId)).toEqual([
      publishedB,
      publishedA,
    ]);
    expect(publishedOnly.jobs).toHaveLength(9);
    expect(withDrafts.versions.map((version) => version.versionId)).toEqual([
      publishedB,
      publishedA,
      draftA,
    ]);
    expect(withDrafts.jobs).toHaveLength(10);
  });

  it("filters decks by stable IDs without changing version ordering", async () => {
    const result = await plan({
      kind: "selected",
      versions: [
        { appId: appA, versionId: publishedA },
        { appId: appB, versionId: publishedB },
      ],
      deckIds: [deckPublishedA],
    });

    expect(result.versions.map((version) => version.versionId)).toEqual([publishedA]);
    expect(result.jobs).toHaveLength(8);
    expect(new Set(result.jobs.map((job) => job.deckId))).toEqual(
      new Set([deckPublishedA]),
    );
  });

  it("uses version ID suffixes to avoid path collisions when names produce the same slug", async () => {
    const result = await plan({ kind: "all" });
    const versionDirectories = new Set(
      result.jobs.map((job) => job.relativePath.split("/").slice(0, 2).join("/")),
    );

    expect(versionDirectories).toEqual(
      new Set([
        "versions/launch--apub1111",
        "versions/launch--bpub2222",
      ]),
    );
    expect(new Set(result.jobs.map((job) => job.relativePath)).size).toBe(
      result.jobs.length,
    );
  });

  it("takes an isolated deep-frozen snapshot without mutating selection", async () => {
    const document = await makeDocument();
    const selectionBefore = structuredClone(document.selection);
    const result = await plan({ kind: "current" }, document);

    document.appsById[appA].versionsById[draftA].name = "Changed Later";
    document.appsById[appA].versionsById[draftA].decksById[deckDraftA].slides[0].id =
      "changed-later";

    expect(document.selection).toEqual(selectionBefore);
    expect(result.snapshot.appsById[appA].versionsById[draftA].name).toBe("Next Release");
    expect(
      result.snapshot.appsById[appA].versionsById[draftA].decksById[deckDraftA]
        .slides[0].id,
    ).toBe("slide-draft-1111");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot.appsById[appA].versionsById[draftA])).toBe(true);
    expect(() => {
      result.jobs[0].relativePath = "changed.png";
    }).toThrow();
  });

  it("blocks a published version with a changed content hash during preflight", async () => {
    const document = await makeDocument();
    document.appsById[appB].versionsById[publishedB].contentHash = "0".repeat(64);

    const result = await plan(
      { kind: "selected", versions: [{ appId: appB, versionId: publishedB }] },
      document,
    );

    expect(result.jobs).toHaveLength(0);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].ready).toBe(false);
    expect(result.preflight.errors).toEqual([
      expect.objectContaining({
        code: "content_hash_mismatch",
        versionId: publishedB,
      }),
    ]);
    expect(result.manifest.complete).toBe(false);
  });

  it("detects scoped asset-registry changes in a published snapshot", async () => {
    const document = await makeDocument();
    const version = document.appsById[appB].versionsById[publishedB];
    version.status = "draft";
    delete version.publishedAt;
    delete version.contentHash;
    const slide = version.decksById[deckPublishedB].slides[0];
    const sha256 = "f".repeat(64);
    const url = `/vibescreens-assets/${document.projectId}/${appB}/${publishedB}/screenshots/${sha256}.png`;
    slide.screenshot = url;
    for (const [id, asset] of Object.entries(document.assetsById)) {
      if (asset.scope.appId === appB && asset.scope.versionId === publishedB) {
        delete (document.assetsById as Record<string, AssetRef>)[id];
      }
    }
    const assetId = assetIdFor(publishedB, "screenshot", sha256, "png");
    document.assetsById[assetId] = {
      id: assetId,
      scope: { appId: appB, versionId: publishedB },
      kind: "screenshot",
      originalName: "screen.png",
      mime: "image/png",
      bytes: 10,
      sha256,
      extension: "png",
      url,
    };
    const published = await publishVersion(document, appB, publishedB, { now: timestamp });
    published.assetsById[assetId].originalName = "tampered.png";

    const result = await plan(
      { kind: "selected", versions: [{ appId: appB, versionId: publishedB }] },
      published,
    );

    expect(result.preflight.errors).toEqual([
      expect.objectContaining({ code: "content_hash_mismatch" }),
    ]);
    expect(result.jobs).toHaveLength(0);
  });

  it("blocks published placeholder screenshots but warns and plans draft placeholders", async () => {
    const publishedDocument = await makeDocument();
    const publishedDeck =
      publishedDocument.appsById[appB].versionsById[publishedB].decksById[
        deckPublishedB
      ];
    const screenshotUrl = publishedDeck.slides[0].screenshot;
    publishedDeck.slides[0].screenshot = "";
    for (const [id, asset] of Object.entries(publishedDocument.assetsById)) {
      if (asset.url === screenshotUrl) {
        delete (publishedDocument.assetsById as Record<string, AssetRef>)[id];
      }
    }
    publishedDocument.appsById[appB].versionsById[publishedB].contentHash =
      await computePublishedVersionContentHash(publishedDocument, appB, publishedB);

    const blocked = await plan(
      { kind: "selected", versions: [{ appId: appB, versionId: publishedB }] },
      publishedDocument,
    );
    expect(blocked.jobs).toHaveLength(0);
    expect(blocked.preflight.errors).toEqual([
      expect.objectContaining({ code: "missing_screenshot", slideId: "slide-b-22222222" }),
    ]);

    const draftDocument = await makeDocument();
    draftDocument.appsById[appA].versionsById[draftA].decksById[
      deckDraftA
    ].slides[0].screenshot = "";
    const warned = await plan({ kind: "current" }, draftDocument);
    expect(warned.jobs).toHaveLength(1);
    expect(warned.preflight.warnings).toEqual([
      expect.objectContaining({ code: "missing_screenshot", slideId: "slide-draft-1111" }),
    ]);
    expect(warned.manifest.complete).toBe(true);
  });

  it("fails preflight when a referenced managed asset file is missing on disk", async () => {
    const document = await makeDocument();
    // All published screenshot URLs are registered; pretend the files vanished.
    const result = await buildExportPlan(
      document,
      { kind: "selected", versions: [{ appId: appB, versionId: publishedB }] },
      {
        createdAt: "2026-08-28T01:02:03.000Z",
        rendererVersion: "test-renderer@1",
        assetFileExists: async () => false,
      },
    );

    expect(result.jobs).toHaveLength(0);
    expect(result.versions[0].ready).toBe(false);
    expect(result.preflight.errors).toEqual([
      expect.objectContaining({ code: "missing_asset_file", versionId: publishedB }),
    ]);
    expect(result.manifest.complete).toBe(false);
  });

  it("passes preflight when every managed asset file exists", async () => {
    const document = await makeDocument();
    const checked: string[] = [];
    const result = await buildExportPlan(
      document,
      { kind: "selected", versions: [{ appId: appB, versionId: publishedB }] },
      {
        createdAt: "2026-08-28T01:02:03.000Z",
        rendererVersion: "test-renderer@1",
        assetFileExists: async (url) => {
          checked.push(url);
          return true;
        },
      },
    );

    expect(result.versions[0].ready).toBe(true);
    expect(result.preflight.errors).toEqual([]);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((url) => url.startsWith("/vibescreens-assets/"))).toBe(true);
  });

  it("rejects missing selections, empty scopes, and duplicate output paths", async () => {
    await expect(
      plan({
        kind: "selected",
        versions: [{ appId: appA, versionId: "ver_missing" as VersionId }],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(plan({ kind: "selected", versions: [] })).rejects.toMatchObject({
      code: "empty_scope",
    });

    const document = await makeDocument();
    const collidingAppId = "app_a1111111-copy" as AppId;
    const collidingApp = document.appsById[appB];
    const collidingVersion = collidingApp.versionsById[publishedB];
    collidingVersion.status = "draft";
    delete collidingVersion.publishedAt;
    delete collidingVersion.contentHash;
    for (const [id, asset] of Object.entries(document.assetsById)) {
      if (asset.scope.appId === appB) {
        delete (document.assetsById as Record<string, AssetRef>)[id];
      }
    }
    delete document.appsById[appB];
    delete collidingApp.versionsById[publishedB];
    collidingApp.id = collidingAppId;
    collidingVersion.id = publishedA;
    collidingApp.versionOrder = [publishedA];
    collidingApp.versionsById[publishedA] = collidingVersion;
    document.appsById[collidingAppId] = collidingApp;
    document.appOrder[0] = collidingAppId;

    await expect(plan({ kind: "all", includeDrafts: true }, document)).rejects.toEqual(
      expect.objectContaining<Partial<ExportPlanError>>({ code: "path_collision" }),
    );
  });
});
