import { describe, expect, it } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import {
  applyEditorStateToProjectDocument,
  projectDocumentToEditorState,
} from "../project-editor-adapter";
import type { DeckRecord, ProjectDocumentV3 } from "../project-schema";

const now = "2026-08-28T00:00:00.000Z";
const appId = "app_adapter" as AppId;
const versionId = "ver_adapter" as VersionId;
const selectedDeckId = "deck_selected" as DeckId;
const siblingDeckId = "deck_sibling" as DeckId;

function deck(
  id: DeckId,
  device: DeckRecord["device"],
  locale: string,
): DeckRecord {
  return {
    id,
    device,
    orientation: "portrait",
    locale,
    connectedCanvas: true,
    appName: `${locale} Rendered App`,
    themeId: "clean-light",
    fontId: "system-sans",
    importedFont: {
      src: "/fonts/imported/custom.woff2",
      format: "woff2",
    },
    appIcon: "/app-icon.png",
    crossScreenMockups: ["/screenshots/mockup.png"],
    slides: [
      {
        id: `slide-${locale}`,
        layout: "hero",
        label: { [locale]: "Label" },
        headline: { [locale]: `Headline ${locale}` },
        screenshot: `/screenshots/${locale}.png`,
        transforms: {
          caption: { x: 1, y: 2, width: 3, height: 4 },
        },
        imageElements: [
          {
            id: "image-1",
            src: "/screenshots/overlay.png",
            transform: { x: 5, y: 6, width: 7, height: 8 },
          },
        ],
      },
    ],
  };
}

function makeDocument(): ProjectDocumentV3 {
  const selectedDeck = deck(selectedDeckId, "iphone", "en");
  const siblingDeck = deck(siblingDeckId, "android", "de");
  return {
    schemaVersion: 3,
    projectId: "prj_adapter" as ProjectDocumentV3["projectId"],
    name: "Adapter Project",
    revision: 4,
    createdAt: now,
    updatedAt: now,
    appOrder: [appId],
    appsById: {
      [appId]: {
        id: appId,
        name: "Organizational App Name",
        createdAt: now,
        updatedAt: now,
        versionOrder: [versionId],
        versionsById: {
          [versionId]: {
            id: versionId,
            name: "Launch",
            status: "draft",
            createdAt: now,
            updatedAt: now,
            deckOrder: [selectedDeckId, siblingDeckId],
            decksById: {
              [selectedDeckId]: selectedDeck,
              [siblingDeckId]: siblingDeck,
            },
          },
        },
      },
    },
    assetsById: {},
    selection: {
      appId,
      versionId,
      deckId: selectedDeckId,
      slideId: "slide-en",
    },
  };
}

describe("project editor adapter", () => {
  it("projects only the selected v3 deck into a schema-v2 editor state", () => {
    const state = projectDocumentToEditorState(makeDocument());

    expect(state).toMatchObject({
      schemaVersion: 2,
      appName: "en Rendered App",
      themeId: "clean-light",
      fontId: "system-sans",
      importedFont: {
        src: "/fonts/imported/custom.woff2",
        format: "woff2",
      },
      connectedCanvas: true,
      locales: ["en", "de"],
      locale: "en",
      device: "iphone",
      orientation: "portrait",
      appIcon: "/app-icon.png",
    });
    expect(state.slidesByDevice.iphone).toEqual(
      makeDocument().appsById[appId].versionsById[versionId].decksById[
        selectedDeckId
      ].slides,
    );
    expect(state.slidesByDevice.android).toEqual([]);
    expect(Object.keys(state.slidesByDevice)).toEqual([
      "iphone",
      "ipad",
      "tvos",
      "watchos",
      "carplay",
      "android",
      "android-7",
      "android-10",
      "macos",
      "windows",
      "feature-graphic",
    ]);
    for (const [device, slides] of Object.entries(state.slidesByDevice)) {
      if (device !== "iphone") expect(slides).toEqual([]);
    }
  });

  it("returns a deeply detached editor state", () => {
    const document = makeDocument();
    const before = structuredClone(document);
    const state = projectDocumentToEditorState(document);

    state.importedFont!.src = "/fonts/imported/mutated.woff2";
    state.locales.push("fr");
    state.slidesByDevice.iphone[0].headline.en = "Mutated";
    state.slidesByDevice.iphone[0].transforms!.caption!.x = 999;
    state.slidesByDevice.iphone[0].imageElements![0].transform.x = 999;

    expect(document).toEqual(before);
  });

  it("applies non-axis editor fields to only the selected draft deck", () => {
    const document = makeDocument();
    const state = projectDocumentToEditorState(document);
    state.appName = "Edited Rendered App";
    state.themeId = "dark-bold";
    state.fontId = "self-hosted";
    state.importedFont = {
      src: "/fonts/imported/replacement.otf",
      format: "opentype",
    };
    state.connectedCanvas = false;
    state.appIcon = "/replacement-icon.png";
    state.slidesByDevice.iphone = [
      {
        id: "slide-en-edited",
        layout: "device-bottom",
        label: { en: "New" },
        headline: { en: "Hello" },
        screenshot: "/screenshots/en-edited.png",
      },
    ];

    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });
    const selected =
      updated.appsById[appId].versionsById[versionId].decksById[
        selectedDeckId
      ];

    expect(selected).toEqual({
      id: selectedDeckId,
      device: "iphone",
      orientation: "portrait",
      locale: "en",
      connectedCanvas: false,
      appName: "Edited Rendered App",
      themeId: "dark-bold",
      fontId: "self-hosted",
      importedFont: {
        src: "/fonts/imported/replacement.otf",
        format: "opentype",
      },
      appIcon: "/replacement-icon.png",
      crossScreenMockups: ["/screenshots/mockup.png"],
      slides: state.slidesByDevice.iphone,
    });
    expect(updated.revision).toBe(5);
    expect(updated.updatedAt).toBe("2026-08-28T01:00:00.000Z");
    expect(updated.appsById[appId].updatedAt).toBe(
      "2026-08-28T01:00:00.000Z",
    );
    expect(updated.appsById[appId].versionsById[versionId].updatedAt).toBe(
      "2026-08-28T01:00:00.000Z",
    );
    expect(
      updated.appsById[appId].versionsById[versionId].decksById[siblingDeckId],
    ).toEqual(
      document.appsById[appId].versionsById[versionId].decksById[siblingDeckId],
    );
    expect(document.revision).toBe(4);
    expect(
      document.appsById[appId].versionsById[versionId].decksById[
        selectedDeckId
      ].appName,
    ).toBe("en Rendered App");
  });

  it("detaches the applied deck from later editor-state mutations", () => {
    const document = makeDocument();
    const state = projectDocumentToEditorState(document);
    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });

    state.importedFont!.src = "/fonts/imported/later.woff2";
    state.slidesByDevice.iphone[0].headline.en = "Changed later";

    const updatedDeck =
      updated.appsById[appId].versionsById[versionId].decksById[
        selectedDeckId
      ];
    expect(updatedDeck.importedFont?.src).toBe(
      "/fonts/imported/custom.woff2",
    );
    expect(updatedDeck.slides[0].headline.en).toBe("Headline en");
  });

  it("repairs the selected slide after applying replacement slides", () => {
    const document = makeDocument();
    const state = projectDocumentToEditorState(document);
    state.slidesByDevice.iphone = [
      {
        id: "slide-replacement",
        layout: "hero",
        label: { en: "Replacement" },
        headline: { en: "Replacement headline" },
        screenshot: "",
      },
    ];

    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });

    expect(updated.selection.slideId).toBe("slide-replacement");
  });

  it("omits the selected slide when the applied deck is empty", () => {
    const document = makeDocument();
    const state = projectDocumentToEditorState(document);
    state.slidesByDevice.iphone = [];

    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });

    expect(updated.selection).not.toHaveProperty("slideId");
  });

  it("uses legacy defaults for optional editor fields", () => {
    const document = makeDocument();
    const state = projectDocumentToEditorState(document);
    state.fontId = undefined;
    state.appIcon = undefined;
    state.importedFont = undefined;

    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });
    const updatedDeck =
      updated.appsById[appId].versionsById[versionId].decksById[
        selectedDeckId
      ];

    expect(updatedDeck.fontId).toBe("system-sans");
    expect(updatedDeck.appIcon).toBe("");
    expect(updatedDeck.importedFont).toBeUndefined();
  });

  it("rejects creating a missing toolbar axis deck in a published version", () => {
    const document = makeDocument();
    const version = document.appsById[appId].versionsById[versionId];
    version.status = "published";
    version.publishedAt = now;
    version.contentHash = "a".repeat(64);
    const before = structuredClone(document);
    const state = projectDocumentToEditorState(document);
    state.device = "android";
    state.orientation = "landscape";
    state.locale = "fr";

    expect(() =>
      applyEditorStateToProjectDocument(document, state, {
        now: "2026-08-28T01:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "published_immutable" }));
    expect(document).toEqual(before);
  });

  it("selects the deck matching toolbar axes without rewriting either deck", () => {
    const document = makeDocument();
    const before = structuredClone(document);
    const state = projectDocumentToEditorState(document);
    state.device = "android";
    state.orientation = "portrait";
    state.locale = "de";

    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });

    expect(updated.selection).toEqual({
      appId,
      versionId,
      deckId: siblingDeckId,
      slideId: "slide-de",
    });
    expect(updated.appsById[appId].versionsById[versionId].decksById).toEqual(
      before.appsById[appId].versionsById[versionId].decksById,
    );
    expect(updated.revision).toBe(5);
    expect(updated.updatedAt).toBe("2026-08-28T01:00:00.000Z");
    expect(document).toEqual(before);
  });

  it("creates and selects a missing toolbar axis deck in a draft version", () => {
    const document = makeDocument();
    const before = structuredClone(document);
    const state = projectDocumentToEditorState(document);
    state.device = "android";
    state.orientation = "landscape";
    state.locale = "fr";
    state.connectedCanvas = false;
    state.appName = "French Android App";
    state.themeId = "dark-bold";
    state.fontId = "self-hosted";
    state.importedFont = {
      src: "/fonts/imported/french.otf",
      format: "opentype",
    };
    state.appIcon = "/french-icon.png";
    state.slidesByDevice.android = [
      {
        id: "slide-fr-android",
        layout: "split-landscape",
        label: { fr: "Nouveau" },
        headline: { fr: "Bonjour" },
        screenshot: "/screenshots/fr-android.png",
      },
    ];

    const updated = applyEditorStateToProjectDocument(document, state, {
      now: "2026-08-28T01:00:00.000Z",
    });
    const createdDeckId = updated.selection.deckId;
    const version = updated.appsById[appId].versionsById[versionId];

    expect(createdDeckId).not.toBe(selectedDeckId);
    expect(createdDeckId).not.toBe(siblingDeckId);
    expect(version.deckOrder).toEqual([
      selectedDeckId,
      siblingDeckId,
      createdDeckId,
    ]);
    expect(version.decksById[createdDeckId]).toEqual({
      id: createdDeckId,
      device: "android",
      orientation: "landscape",
      locale: "fr",
      connectedCanvas: false,
      appName: "French Android App",
      themeId: "dark-bold",
      fontId: "self-hosted",
      importedFont: {
        src: "/fonts/imported/french.otf",
        format: "opentype",
      },
      appIcon: "/french-icon.png",
      slides: state.slidesByDevice.android,
    });
    expect(updated.selection.slideId).toBe("slide-fr-android");
    expect(version.decksById[selectedDeckId]).toEqual(
      before.appsById[appId].versionsById[versionId].decksById[selectedDeckId],
    );
    expect(version.decksById[siblingDeckId]).toEqual(
      before.appsById[appId].versionsById[versionId].decksById[siblingDeckId],
    );
    expect(updated.revision).toBe(5);
    expect(updated.updatedAt).toBe("2026-08-28T01:00:00.000Z");
    expect(document).toEqual(before);
  });

  it("fails fast when the v3 selection does not resolve to a deck", () => {
    const document = makeDocument();
    document.selection.deckId = "deck_missing" as DeckId;

    expect(() => projectDocumentToEditorState(document)).toThrow(
      "Project selection does not resolve to a deck",
    );
  });
});
