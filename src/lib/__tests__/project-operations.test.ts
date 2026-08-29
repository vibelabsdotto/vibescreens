import { describe, expect, it } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import {
  DomainOperationError,
  cloneVersion,
  createApp,
  createDeck,
  createProjectDocument,
  createVersion,
  deleteApp,
  deleteDeck,
  deleteVersion,
  publishVersion,
  renameApp,
  renameVersion,
  selectAppVersion,
  selectDeck,
  updateDeck,
  type DeckInput,
} from "../project-operations";
import type { ProjectDocumentV3 } from "../project-schema";

const now = "2026-08-28T00:00:00.000Z";
const later = "2026-08-28T01:00:00.000Z";
const projectId = "prj_project" as ProjectDocumentV3["projectId"];
const appA = "app_a" as AppId;
const appB = "app_b" as AppId;
const versionA = "ver_a" as VersionId;
const versionB = "ver_b" as VersionId;
const deckA = "deck_a" as DeckId;
const deckB = "deck_b" as DeckId;

function deck(locale = "en", headline = "Hello"): DeckInput {
  return {
    device: "iphone",
    orientation: "portrait",
    locale,
    connectedCanvas: true,
    appName: "Rendered App",
    themeId: "clean-light",
    fontId: "system-sans",
    appIcon: "",
    crossScreenMockups: [],
    slides: [{ id: `slide-${locale}`, headline } as never],
  };
}

function makeProject(): ProjectDocumentV3 {
  return createProjectDocument(deck(), {
    now,
    projectId,
    projectName: "Screenshots",
    appId: appA,
    appName: "Mobile App",
    versionId: versionA,
    versionName: "Launch",
    deckId: deckA,
  });
}

describe("project operations", () => {
  it("creates the initial app, draft version, deck, and valid selection without aliasing input", () => {
    const initialDeck = deck();

    const project = createProjectDocument(initialDeck, {
      now,
      projectId,
      projectName: " Screenshots ",
      appId: appA,
      appName: " Mobile App ",
      versionId: versionA,
      versionName: " Launch ",
      deckId: deckA,
    });

    expect(project).toMatchObject({
      schemaVersion: 3,
      projectId,
      name: "Screenshots",
      revision: 1,
      appOrder: [appA],
      selection: {
        appId: appA,
        versionId: versionA,
        deckId: deckA,
        slideId: "slide-en",
      },
    });
    expect(project.appsById[appA].name).toBe("Mobile App");
    expect(project.appsById[appA].versionsById[versionA]).toMatchObject({
      name: "Launch",
      status: "draft",
      deckOrder: [deckA],
    });

    project.appsById[appA].versionsById[versionA].decksById[deckA].slides.push(
      { id: "another" } as never,
    );
    expect(initialDeck.slides).toHaveLength(1);
  });

  it("renames apps and draft versions without changing IDs and rejects normalized duplicates", () => {
    let project = makeProject();
    project = createApp(project, "Desktop App", deck("de"), {
      now: later,
      appId: appB,
      versionId: versionB,
      deckId: deckB,
      versionName: "Launch",
    });

    const renamedApp = renameApp(project, appA, "Renamed Mobile", { now: later });
    expect(renamedApp.appOrder).toEqual([appA, appB]);
    expect(renamedApp.appsById[appA].id).toBe(appA);

    const renamedVersion = renameVersion(renamedApp, appA, versionA, "Version 2", {
      now: later,
    });
    expect(renamedVersion.appsById[appA].versionOrder).toEqual([versionA]);
    expect(renamedVersion.appsById[appA].versionsById[versionA].id).toBe(versionA);

    expect(() => renameApp(project, appB, "  MOBILE APP  ")).toThrow(
      DomainOperationError,
    );

    const withSecondVersion = createVersion(
      project,
      appA,
      "Second",
      deck("fr"),
      { now: later, versionId: versionB, deckId: deckB },
    );
    expect(() =>
      renameVersion(withSecondVersion, appA, versionB, " launch "),
    ).toThrow(DomainOperationError);
  });

  it("publishes a content hash and forbids published name or deck mutation", async () => {
    const project = makeProject();

    const published = await publishVersion(project, appA, versionA, { now: later });
    const version = published.appsById[appA].versionsById[versionA];

    expect(version).toMatchObject({
      status: "published",
      publishedAt: later,
    });
    expect(version.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => renameVersion(published, appA, versionA, "Hotfix")).toThrow(
      DomainOperationError,
    );
    expect(() =>
      updateDeck(published, appA, versionA, deckA, { appName: "Changed" }),
    ).toThrow(DomainOperationError);
    expect(() => {
      version.decksById[deckA].appName = "Changed externally";
    }).toThrow();
  });

  it("seals only the published version's scoped asset refs into its content hash", async () => {
    const project = makeProject();
    const version = project.appsById[appA].versionsById[versionA];
    const slide = version.decksById[deckA].slides[0];
    const sha256 = "c".repeat(64);
    const url = `/vibescreens-assets/${projectId}/${appA}/${versionA}/screenshots/${sha256}.png`;
    slide.screenshot = url;
    project.assetsById = {
      asset_screen: {
        id: "asset_screen",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "screen.png",
        mime: "image/png",
        bytes: 10,
        sha256,
        extension: "png",
        url,
      },
    } as ProjectDocumentV3["assetsById"];

    const first = await publishVersion(project, appA, versionA, { now: later });
    const changedMetadata = structuredClone(project);
    Object.values(changedMetadata.assetsById)[0].originalName = "renamed.png";
    const second = await publishVersion(changedMetadata, appA, versionA, { now: later });

    expect(first.appsById[appA].versionsById[versionA].contentHash).not.toBe(
      second.appsById[appA].versionsById[versionA].contentHash,
    );
  });

  it("clones scoped asset refs and rewrites managed URLs to the target version", () => {
    const project = makeProject();
    const version = project.appsById[appA].versionsById[versionA];
    const sha256 = "d".repeat(64);
    const sourceUrl = `/vibescreens-assets/${projectId}/${appA}/${versionA}/screenshots/${sha256}.png`;
    version.decksById[deckA].slides[0].screenshot = sourceUrl;
    project.assetsById = {
      asset_source: {
        id: "asset_source",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "screen.png",
        mime: "image/png",
        bytes: 10,
        sha256,
        extension: "png",
        url: sourceUrl,
      },
    } as ProjectDocumentV3["assetsById"];

    const cloned = cloneVersion(project, appA, versionA, "Clone", {
      now: later,
      versionId: versionB,
    });
    const targetUrl = sourceUrl.replace(`/${versionA}/`, `/${versionB}/`);
    const targetAssets = Object.values(cloned.assetsById).filter(
      (asset) => asset.scope.versionId === versionB,
    );

    expect(cloned.appsById[appA].versionsById[versionB].decksById[deckA].slides[0].screenshot).toBe(
      targetUrl,
    );
    expect(targetAssets).toEqual([
      expect.objectContaining({
        scope: { appId: appA, versionId: versionB },
        sha256,
        url: targetUrl,
      }),
    ]);
    expect(
      Object.values(cloned.assetsById).find(
        (asset) => asset.scope.versionId === versionA,
      )?.url,
    ).toBe(sourceUrl);
  });

  it("prunes unreachable draft asset entries when a deck update replaces or clears a managed reference", () => {
    const project = makeProject();
    const version = project.appsById[appA].versionsById[versionA];
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const urlA = `/vibescreens-assets/${projectId}/${appA}/${versionA}/screenshots/${shaA}.png`;
    const urlB = `/vibescreens-assets/${projectId}/${appA}/${versionA}/screenshots/${shaB}.png`;
    version.decksById[deckA].slides[0].screenshot = urlA;
    project.assetsById = {
      asset_a: {
        id: "asset_a",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "a.png",
        mime: "image/png",
        bytes: 10,
        sha256: shaA,
        extension: "png",
        url: urlA,
      },
      asset_b: {
        id: "asset_b",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "b.png",
        mime: "image/png",
        bytes: 10,
        sha256: shaB,
        extension: "png",
        url: urlB,
      },
    } as ProjectDocumentV3["assetsById"];

    // B is unreferenced while A is in use: replacing A with B prunes A's entry.
    const replaced = updateDeck(project, appA, versionA, deckA, {
      slides: [{ ...version.decksById[deckA].slides[0], screenshot: urlB } as never],
    });
    expect(Object.keys(replaced.assetsById)).toEqual(["asset_b"]);

    // Clearing the reference prunes B's entry as well.
    const cleared = updateDeck(project, appA, versionA, deckA, {
      slides: [{ ...version.decksById[deckA].slides[0], screenshot: "" } as never],
    });
    expect(Object.keys(cleared.assetsById)).toEqual([]);
  });

  it("keeps published asset entries even when an unrelated reference changes", async () => {
    const project = makeProject();
    const version = project.appsById[appA].versionsById[versionA];
    const sha = "c".repeat(64);
    const url = `/vibescreens-assets/${projectId}/${appA}/${versionA}/screenshots/${sha}.png`;
    version.decksById[deckA].slides[0].screenshot = url;
    project.assetsById = {
      asset_target: {
        id: "asset_target",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "target.png",
        mime: "image/png",
        bytes: 10,
        sha256: sha,
        extension: "png",
        url,
      },
    } as ProjectDocumentV3["assetsById"];

    const published = await publishVersion(project, appA, versionA, { now: later });
    // A draft save elsewhere in the document must NOT strip published reachables.
    const withSecondVersion = createVersion(published, appA, "Other", deck("fr"), {
      now: later,
      versionId: versionB,
      deckId: deckB,
    });

    expect(Object.keys(withSecondVersion.assetsById)).toEqual(["asset_target"]);
  });

  it("prunes unreachable draft asset entries on the next draft operation", () => {
    // Registry entry that nothing references at all: prune on the next draft op.
    const project = makeProject();
    const sha = "9".repeat(64);
    const url = `/vibescreens-assets/${projectId}/${appA}/${versionA}/screenshots/${sha}.png`;
    project.assetsById = {
      asset_orphan: {
        id: "asset_orphan",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "orphan.png",
        mime: "image/png",
        bytes: 10,
        sha256: sha,
        extension: "png",
        url,
      },
    } as ProjectDocumentV3["assetsById"];

    const renamed = renameVersion(project, appA, versionA, "Renamed");
    expect(Object.keys(renamed.assetsById)).toEqual([]);
  });

  it("clones either status to a new draft with isolated deep content and stable scoped IDs", async () => {
    const published = await publishVersion(makeProject(), appA, versionA, {
      now: later,
    });

    const cloned = cloneVersion(published, appA, versionA, "Launch Copy", {
      now: later,
      versionId: versionB,
    });
    const source = cloned.appsById[appA].versionsById[versionA];
    const copy = cloned.appsById[appA].versionsById[versionB];

    expect(copy).toMatchObject({
      id: versionB,
      name: "Launch Copy",
      status: "draft",
      sourceVersionId: versionA,
      deckOrder: [deckA],
    });
    expect(copy.publishedAt).toBeUndefined();
    expect(copy.contentHash).toBeUndefined();
    expect(copy.decksById[deckA].slides[0]?.id).toBe("slide-en");
    expect(copy.decksById[deckA].importedFont).toBeUndefined();
    expect(copy.decksById[deckA].crossScreenMockups).toEqual([]);
    expect(cloned.selection.versionId).toBe(versionB);

    copy.decksById[deckA].slides.push({ id: "copy-only" } as never);
    copy.decksById[deckA].crossScreenMockups?.push("/screenshots/copy-only.png");
    expect(source.decksById[deckA].slides).toHaveLength(1);
    expect(source.decksById[deckA].crossScreenMockups).toEqual([]);
  });

  it("protects the last app, version, and deck", () => {
    const project = makeProject();

    expect(() => deleteApp(project, appA)).toThrowError(
      expect.objectContaining({ code: "last_app" }),
    );
    expect(() => deleteVersion(project, appA, versionA)).toThrowError(
      expect.objectContaining({ code: "last_version" }),
    );
    expect(() => deleteDeck(project, appA, versionA, deckA)).toThrowError(
      expect.objectContaining({ code: "last_deck" }),
    );
  });

  it("falls back deterministically after deleting the selected app, version, or deck", () => {
    let project = makeProject();
    project = createApp(project, "Second App", deck("de"), {
      now: later,
      appId: appB,
      versionId: versionB,
      deckId: deckB,
      versionName: "Second Version",
    });
    expect(project.selection.appId).toBe(appB);

    project = deleteApp(project, appB, { now: later });
    expect(project.selection).toMatchObject({
      appId: appA,
      versionId: versionA,
      deckId: deckA,
    });

    project = createVersion(project, appA, "Second Version", deck("de"), {
      now: later,
      versionId: versionB,
      deckId: deckB,
    });
    project = deleteVersion(project, appA, versionB, { now: later });
    expect(project.selection.versionId).toBe(versionA);

    project = createDeck(project, appA, versionA, deck("de"), {
      now: later,
      deckId: deckB,
    });
    project = deleteDeck(project, appA, versionA, deckB, { now: later });
    expect(project.selection).toMatchObject({
      deckId: deckA,
      slideId: "slide-en",
    });
  });

  it("selects only valid app/version/deck chains without mutating content", () => {
    let project = makeProject();
    project = createDeck(project, appA, versionA, deck("de"), {
      now: later,
      deckId: deckB,
    });
    const beforeContent = structuredClone(
      project.appsById[appA].versionsById[versionA].decksById,
    );

    const selectedVersion = selectAppVersion(project, appA, versionA, deckA, {
      now: later,
    });
    expect(selectedVersion.selection).toMatchObject({
      appId: appA,
      versionId: versionA,
      deckId: deckA,
      slideId: "slide-en",
    });

    const selectedDeck = selectDeck(selectedVersion, appA, versionA, deckB, {
      now: later,
    });
    expect(selectedDeck.selection).toMatchObject({
      deckId: deckB,
      slideId: "slide-de",
    });
    expect(selectedDeck.appsById[appA].versionsById[versionA].decksById).toEqual(
      beforeContent,
    );

    expect(() =>
      selectAppVersion(project, appA, "ver_missing" as VersionId),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() =>
      selectDeck(project, appA, versionA, "deck_missing" as DeckId),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
  });
});
