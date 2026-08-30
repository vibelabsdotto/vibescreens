import { describe, expect, it } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import {
  ProjectSchemaError,
  UnsupportedProjectSchemaVersionError,
  assetIdFor,
  normalizeProjectDocument,
  validateProjectDocument,
  type ProjectDocumentV3,
} from "../project-schema";

const appA = "app_a" as AppId;
const appB = "app_b" as AppId;
const versionA = "ver_a" as VersionId;
const versionB = "ver_b" as VersionId;
const deckA = "deck_a" as DeckId;
const deckB = "deck_b" as DeckId;
const timestamp = "2026-08-28T00:00:00.000Z";

function makeDocument(): ProjectDocumentV3 {
  return {
    schemaVersion: 3,
    projectId: "prj_test" as ProjectDocumentV3["projectId"],
    name: "Example Project",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    appOrder: [appA],
    appsById: {
      [appA]: {
        id: appA,
        name: "First App",
        createdAt: timestamp,
        updatedAt: timestamp,
        versionOrder: [versionA],
        versionsById: {
          [versionA]: {
            id: versionA,
            name: "First Version",
            status: "draft",
            createdAt: timestamp,
            updatedAt: timestamp,
            deckOrder: [deckA],
            decksById: {
              [deckA]: {
                id: deckA,
                device: "iphone",
                orientation: "portrait",
                locale: "en",
                connectedCanvas: true,
                appName: "Rendered App",
                themeId: "clean-light",
                fontId: "system-sans",
                appIcon: "",
                slides: [{ id: "slide-a" } as never],
              },
            },
          },
        },
      },
    },
    assetsById: {},
    selection: {
      appId: appA,
      versionId: versionA,
      deckId: deckA,
      slideId: "slide-a",
    },
  };
}

describe("project schema", () => {
  it("uses the complete version identity in deterministic asset IDs", () => {
    const hash = "a".repeat(64);
    const first = assetIdFor("ver_abcdefghijklA" as VersionId, "image", hash, "png");
    const second = assetIdFor("ver_abcdefghijklB" as VersionId, "image", hash, "png");

    expect(first).not.toBe(second);
    expect(assetIdFor(versionA, "image", hash, "abcdefg")).not.toBe(
      assetIdFor(versionA, "image", hash, "abcdefh"),
    );
  });

  it("validates top-level scoped asset refs and published reference reachability", () => {
    const document = makeDocument();
    const version = document.appsById[appA].versionsById[versionA];
    const slide = version.decksById[deckA].slides[0];
    const sha256 = "a".repeat(64);
    const url = `/vibescreens-assets/${document.projectId}/${appA}/${versionA}/screenshots/${sha256}.png`;
    slide.screenshot = url;
    document.assetsById = {
      asset_screen: {
        id: "asset_screen",
        scope: { appId: appA, versionId: versionA },
        kind: "screenshot",
        originalName: "screen.png",
        mime: "image/png",
        bytes: 123,
        sha256,
        extension: "png",
        url,
      },
    } as ProjectDocumentV3["assetsById"];
    version.status = "published";
    version.publishedAt = timestamp;
    version.contentHash = "b".repeat(64);

    expect(validateProjectDocument(document)).toMatchObject({ ok: true });

    const wrongKind = structuredClone(document);
    Object.values(wrongKind.assetsById)[0].kind = "font";
    expect(validateProjectDocument(wrongKind).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_asset" })]),
    );

    const unregistered = structuredClone(document);
    unregistered.assetsById = {};
    expect(validateProjectDocument(unregistered).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_asset_reference" })]),
    );
  });

  it("rejects publication metadata on drafts", () => {
    const document = makeDocument();
    const version = document.appsById[appA].versionsById[versionA];
    version.publishedAt = timestamp;
    version.contentHash = "a".repeat(64);

    expect(validateProjectDocument(document).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_published" })]),
    );
  });

  it("normalizes order arrays to maps and repairs invalid selection deterministically", () => {
    const document = makeDocument();
    document.appsById[appB] = {
      ...structuredClone(document.appsById[appA]),
      id: appB,
      name: "Second App",
      versionOrder: [versionB],
      versionsById: {
        [versionB]: {
          ...structuredClone(document.appsById[appA].versionsById[versionA]),
          id: versionB,
          name: "Second Version",
          deckOrder: [deckB],
          decksById: {
            [deckB]: {
              ...structuredClone(
                document.appsById[appA].versionsById[versionA].decksById[deckA],
              ),
              id: deckB,
              locale: "de",
              slides: [{ id: "slide-b" } as never],
            },
          },
        },
      },
    };
    document.appOrder = [appB, appB];
    document.selection = {
      appId: "app_missing" as AppId,
      versionId: "ver_missing" as VersionId,
      deckId: "deck_missing" as DeckId,
      slideId: "slide-missing",
    };

    const normalized = normalizeProjectDocument(document);

    expect(normalized.appOrder).toEqual([appB, appA]);
    expect(normalized.appsById[appB].versionOrder).toEqual([versionB]);
    expect(normalized.selection).toEqual({
      appId: appB,
      versionId: versionB,
      deckId: deckB,
      slideId: "slide-b",
    });
    expect(validateProjectDocument(normalized)).toMatchObject({ ok: true });
  });

  it("reports an invalid cross-tree selection before normalization", () => {
    const document = makeDocument();
    document.selection.versionId = versionB;

    const validation = validateProjectDocument(document);

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_selection" }),
      ]),
    );
  });

  it("rejects duplicate app and version names after trim, Unicode normalization, and case fold", () => {
    const duplicateAppDocument = makeDocument();
    duplicateAppDocument.appsById[appB] = {
      ...structuredClone(duplicateAppDocument.appsById[appA]),
      id: appB,
      name: "  first app  ",
    };
    duplicateAppDocument.appOrder.push(appB);

    expect(() => normalizeProjectDocument(duplicateAppDocument)).toThrow(
      ProjectSchemaError,
    );

    const duplicateVersionDocument = makeDocument();
    duplicateVersionDocument.appsById[appA].versionsById[versionB] = {
      ...structuredClone(
        duplicateVersionDocument.appsById[appA].versionsById[versionA],
      ),
      id: versionB,
      name: "ＦＩＲＳＴ ＶＥＲＳＩＯＮ",
    };
    duplicateVersionDocument.appsById[appA].versionOrder.push(versionB);

    expect(() => normalizeProjectDocument(duplicateVersionDocument)).toThrow(
      ProjectSchemaError,
    );
  });

  it("validates optional imported font and cross-screen mockup render payloads", () => {
    const valid = makeDocument();
    const deck =
      valid.appsById[appA].versionsById[versionA].decksById[deckA];
    deck.importedFont = {
      src: "/fonts/imported/custom.woff2",
      format: "woff2",
    };
    deck.crossScreenMockups = ["/screenshots/mockup-a.png"];
    expect(validateProjectDocument(valid)).toMatchObject({ ok: true });

    const invalid = makeDocument();
    const invalidDeck =
      invalid.appsById[appA].versionsById[versionA].decksById[deckA];
    invalidDeck.importedFont = {
      src: "javascript:alert(1)",
      format: "exe",
    } as never;
    invalidDeck.crossScreenMockups = ["valid", 42] as never;

    expect(validateProjectDocument(invalid).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("importedFont") }),
        expect.objectContaining({
          path: expect.stringContaining("crossScreenMockups"),
        }),
      ]),
    );
  });

  it("requires every project, app, and version to have a selectable child", () => {
    const noApps = makeDocument();
    noApps.appOrder = [];
    noApps.appsById = {} as ProjectDocumentV3["appsById"];
    expect(validateProjectDocument(noApps).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "empty_project" })]),
    );

    const noVersions = makeDocument();
    noVersions.appsById[appA].versionOrder = [];
    noVersions.appsById[appA].versionsById = {};
    expect(validateProjectDocument(noVersions).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "empty_app" })]),
    );

    const noDecks = makeDocument();
    noDecks.appsById[appA].versionsById[versionA].deckOrder = [];
    noDecks.appsById[appA].versionsById[versionA].decksById = {};
    expect(validateProjectDocument(noDecks).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "empty_version" })]),
    );
  });

  it("validates auditable migration source metadata and SHA-256", () => {
    const valid = makeDocument();
    valid.migration = {
      from: 2,
      migratedAt: timestamp,
      backupPath: ".vibescreens/backups/app-store-screenshots.v2.json",
      warnings: [],
      sourceFile: "app-store-screenshots.json",
      sourceSha256: "a".repeat(64),
    };
    expect(validateProjectDocument(valid)).toMatchObject({ ok: true });

    const invalid = makeDocument();
    invalid.migration = {
      from: 2,
      migratedAt: timestamp,
      backupPath: ".vibescreens/backups/source.json",
      warnings: [],
      sourceFile: "unknown.json",
      sourceSha256: "ABC123",
    } as never;
    expect(validateProjectDocument(invalid).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "migration.sourceFile" }),
        expect.objectContaining({ path: "migration.sourceSha256" }),
      ]),
    );
  });

  it("rejects a newer schema as read-only instead of downgrading it", () => {
    const future = { ...makeDocument(), schemaVersion: 4 };

    const validation = validateProjectDocument(future);
    expect(validation).toMatchObject({ ok: false, readOnly: true });
    expect(() => normalizeProjectDocument(future)).toThrow(
      UnsupportedProjectSchemaVersionError,
    );

    try {
      normalizeProjectDocument(future);
    } catch (error) {
      expect(error).toMatchObject({ readOnly: true, schemaVersion: 4 });
    }
  });
});
