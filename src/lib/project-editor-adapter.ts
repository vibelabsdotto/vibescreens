import { DEFAULT_SCREENSHOT_FONT_ID } from "./constants";
import {
  createDeck,
  selectDeck,
  updateDeck,
  type TimestampOptions,
} from "./project-operations";
import type { DeckRecord, ProjectDocumentV3 } from "./project-schema";
import type { Device, ProjectState, Slide } from "./types";

function selectedDeck(document: ProjectDocumentV3): DeckRecord {
  const { appId, versionId, deckId } = document.selection;
  const deck =
    document.appsById[appId]?.versionsById[versionId]?.decksById[deckId];
  if (deck === undefined) {
    throw new Error("Project selection does not resolve to a deck");
  }
  return deck;
}

function emptySlidesByDevice(): Record<Device, Slide[]> {
  return {
    iphone: [],
    ipad: [],
    tvos: [],
    watchos: [],
    carplay: [],
    android: [],
    "android-7": [],
    "android-10": [],
    macos: [],
    windows: [],
    "feature-graphic": [],
  };
}

export function projectDocumentToEditorState(
  document: ProjectDocumentV3,
): ProjectState {
  const deck = selectedDeck(document);
  const { appId, versionId } = document.selection;
  const version = document.appsById[appId]?.versionsById[versionId];
  if (version === undefined) {
    throw new Error("Project selection does not resolve to a version");
  }
  const slidesByDevice = emptySlidesByDevice();
  slidesByDevice[deck.device] = structuredClone(deck.slides);
  const localeKeys = new Set<string>();
  const locales: string[] = [];
  for (const deckId of version.deckOrder) {
    const locale = version.decksById[deckId].locale;
    const key = locale.trim().normalize("NFKC").toLocaleLowerCase("en-US");
    if (!localeKeys.has(key)) {
      localeKeys.add(key);
      locales.push(locale);
    }
  }

  return {
    schemaVersion: 2,
    appName: deck.appName,
    themeId: deck.themeId,
    fontId: deck.fontId as ProjectState["fontId"],
    ...(deck.importedFont === undefined
      ? {}
      : { importedFont: structuredClone(deck.importedFont) }),
    connectedCanvas: deck.connectedCanvas,
    locales,
    locale: deck.locale,
    device: deck.device,
    orientation: deck.orientation,
    slidesByDevice,
    appIcon: deck.appIcon,
  };
}

export function applyEditorStateToProjectDocument(
  document: ProjectDocumentV3,
  editorState: ProjectState,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  const { appId, versionId, deckId } = document.selection;
  const version = document.appsById[appId]?.versionsById[versionId];
  const normalizedLocale = editorState.locale
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  const matchingDeck = Object.values(version?.decksById ?? {}).find(
    (deck) =>
      deck.device === editorState.device &&
      deck.orientation === editorState.orientation &&
      deck.locale.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
        normalizedLocale,
  );
  if (matchingDeck === undefined) {
    const sourceDeck = selectedDeck(document);
    return createDeck(
      document,
      appId,
      versionId,
      {
        device: editorState.device,
        orientation: editorState.orientation,
        locale: editorState.locale,
        connectedCanvas: editorState.connectedCanvas,
        appName: editorState.appName,
        themeId: editorState.themeId,
        fontId: editorState.fontId ?? DEFAULT_SCREENSHOT_FONT_ID,
        importedFont: editorState.importedFont,
        appIcon: editorState.appIcon ?? "",
        crossScreenMockups:
          sourceDeck.device === editorState.device
            ? sourceDeck.crossScreenMockups
            : undefined,
        slides: editorState.slidesByDevice[editorState.device] ?? [],
      },
      options,
    );
  }
  if (matchingDeck.id !== deckId) {
    return selectDeck(document, appId, versionId, matchingDeck.id, options);
  }
  return updateDeck(
    document,
    appId,
    versionId,
    deckId,
    {
      connectedCanvas: editorState.connectedCanvas,
      appName: editorState.appName,
      themeId: editorState.themeId,
      fontId: editorState.fontId ?? DEFAULT_SCREENSHOT_FONT_ID,
      importedFont: editorState.importedFont,
      appIcon: editorState.appIcon ?? "",
      slides: editorState.slidesByDevice[editorState.device] ?? [],
    },
    options,
  );
}
