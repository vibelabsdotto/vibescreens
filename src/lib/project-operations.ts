import {
  assetIdFor,
  computePublishedVersionContentHash,
  managedAssetUrl,
  normalizeProjectDocument,
  normalizedNameKey,
  type AppRecord,
  type AssetRef,
  type DeckRecord,
  type ProjectDocumentV3,
  type VersionRecord,
} from "./project-schema";
import {
  createAppId,
  createDeckId,
  createVersionId,
  type AppId,
  type DeckId,
  type VersionId,
} from "./ids";
import { createProjectId, type ProjectId } from "./workspace";

export type DeckInput = Omit<DeckRecord, "id"> & { id?: DeckId };

export type DomainOperationErrorCode =
  | "not_found"
  | "duplicate_name"
  | "duplicate_deck"
  | "last_app"
  | "last_version"
  | "last_deck"
  | "published_immutable";

export class DomainOperationError extends Error {
  readonly code: DomainOperationErrorCode;

  constructor(code: DomainOperationErrorCode, message: string) {
    super(message);
    this.name = "DomainOperationError";
    this.code = code;
  }
}

export interface TimestampOptions {
  now?: string;
}

export interface CreateProjectDocumentOptions extends TimestampOptions {
  projectId?: ProjectId;
  projectName?: string;
  appId?: AppId;
  appName?: string;
  versionId?: VersionId;
  versionName?: string;
  deckId?: DeckId;
}

export interface CreateAppOptions extends TimestampOptions {
  appId?: AppId;
  versionId?: VersionId;
  versionName?: string;
  deckId?: DeckId;
}

export interface CreateVersionOptions extends TimestampOptions {
  versionId?: VersionId;
  deckId?: DeckId;
}

export interface CloneVersionOptions extends TimestampOptions {
  versionId?: VersionId;
}

export interface CreateDeckOptions extends TimestampOptions {
  deckId?: DeckId;
}

export interface SelectionOptions extends TimestampOptions {
  slideId?: string;
}

function operationTimestamp(options?: TimestampOptions): string {
  return options?.now ?? new Date().toISOString();
}

function cloneDocument(document: ProjectDocumentV3): ProjectDocumentV3 {
  return structuredClone(document);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function freezePublishedVersions(document: ProjectDocumentV3): ProjectDocumentV3 {
  for (const app of Object.values(document.appsById)) {
    for (const version of Object.values(app.versionsById)) {
      if (version.status === "published") deepFreeze(version);
    }
  }
  return document;
}

function finalize(
  document: ProjectDocumentV3,
  timestamp: string,
  incrementRevision = true,
): ProjectDocumentV3 {
  document.updatedAt = timestamp;
  if (incrementRevision) document.revision += 1;
  pruneUnreachableDraftAssets(document);
  return freezePublishedVersions(normalizeProjectDocument(document));
}

function getApp(document: ProjectDocumentV3, appId: AppId): AppRecord {
  const app = document.appsById[appId];
  if (app === undefined) {
    throw new DomainOperationError("not_found", `App ${appId} does not exist`);
  }
  return app;
}

function getVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
): VersionRecord {
  const version = getApp(document, appId).versionsById[versionId];
  if (version === undefined) {
    throw new DomainOperationError(
      "not_found",
      `Version ${versionId} does not exist in app ${appId}`,
    );
  }
  return version;
}

function getDeck(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  deckId: DeckId,
): DeckRecord {
  const deck = getVersion(document, appId, versionId).decksById[deckId];
  if (deck === undefined) {
    throw new DomainOperationError(
      "not_found",
      `Deck ${deckId} does not exist in version ${versionId}`,
    );
  }
  return deck;
}

function assertDraft(version: VersionRecord): void {
  if (version.status === "published") {
    throw new DomainOperationError(
      "published_immutable",
      `Published version ${version.id} is immutable; clone it to a draft first`,
    );
  }
}

function assertUniqueName(
  records: Iterable<{ id: string; name: string }>,
  name: string,
  exceptId?: string,
): void {
  const key = normalizedNameKey(name);
  if (key.length === 0) {
    throw new DomainOperationError("duplicate_name", "Name cannot be empty");
  }
  for (const record of records) {
    if (record.id !== exceptId && normalizedNameKey(record.name) === key) {
      throw new DomainOperationError(
        "duplicate_name",
        `Name ${name.trim()} is already in use`,
      );
    }
  }
}

function firstSlideId(deck: DeckRecord): string | undefined {
  return deck.slides[0]?.id;
}

function makeDeck(input: DeckInput, id: DeckId): DeckRecord {
  const cloned = structuredClone(input);
  return {
    id,
    device: cloned.device,
    orientation: cloned.orientation,
    locale: cloned.locale,
    connectedCanvas: cloned.connectedCanvas,
    appName: cloned.appName,
    themeId: cloned.themeId,
    fontId: cloned.fontId,
    importedFont: cloned.importedFont,
    appIcon: cloned.appIcon,
    crossScreenMockups: cloned.crossScreenMockups,
    slides: cloned.slides,
  };
}

function makeVersion(
  id: VersionId,
  name: string,
  deck: DeckRecord,
  timestamp: string,
): VersionRecord {
  return {
    id,
    name,
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    deckOrder: [deck.id],
    decksById: { [deck.id]: deck } as Record<DeckId, DeckRecord>,
  };
}

function selectionFor(
  appId: AppId,
  versionId: VersionId,
  deck: DeckRecord,
  requestedSlideId?: string,
): ProjectDocumentV3["selection"] {
  const slideId =
    requestedSlideId !== undefined &&
    deck.slides.some((slide) => slide.id === requestedSlideId)
      ? requestedSlideId
      : firstSlideId(deck);
  return {
    appId,
    versionId,
    deckId: deck.id,
    ...(slideId === undefined ? {} : { slideId }),
  };
}

function deckAxisKey(deck: Pick<DeckRecord, "device" | "orientation" | "locale">): string {
  return [
    deck.device,
    deck.orientation,
    deck.locale.trim().normalize("NFKC").toLocaleLowerCase("en-US"),
  ].join("\u0000");
}

/**
 * Drop draft-version asset registry entries nothing references anymore.
 * Replacing or clearing an overlay otherwise leaves the old upload registered
 * forever, and publishing then rejects the version as unpublishable because a
 * scoped registry entry is unreachable. Published versions are untouched: their
 * reachability is checked (never silently "fixed") so the content hash stays
 * meaningful.
 */
export function pruneUnreachableDraftAssets(document: ProjectDocumentV3): void {
  const reachable = new Set<string>();
  for (const app of Object.values(document.appsById)) {
    for (const version of Object.values(app.versionsById)) {
      for (const deck of Object.values(version.decksById)) {
        if (deck.appIcon) reachable.add(deck.appIcon);
        if (deck.importedFont?.src) reachable.add(deck.importedFont.src);
        for (const url of deck.crossScreenMockups ?? []) {
          if (url) reachable.add(url);
        }
        for (const slide of deck.slides) {
          if (slide.screenshot) reachable.add(slide.screenshot);
          if (slide.screenshotSecondary) reachable.add(slide.screenshotSecondary);
          for (const image of slide.imageElements ?? []) {
            if (image.src) reachable.add(image.src);
          }
        }
      }
    }
  }
  for (const [assetId, asset] of Object.entries(document.assetsById)) {
    const version =
      document.appsById[asset.scope.appId]?.versionsById[asset.scope.versionId];
    if (version === undefined || version.status !== "draft") continue;
    if (!reachable.has(asset.url)) {
      delete document.assetsById[assetId as keyof typeof document.assetsById];
    }
  }
}

function assertUniqueDeck(
  version: VersionRecord,
  candidate: DeckRecord,
  exceptId?: DeckId,
): void {
  const key = deckAxisKey(candidate);
  for (const deck of Object.values(version.decksById)) {
    if (deck.id !== exceptId && deckAxisKey(deck) === key) {
      throw new DomainOperationError(
        "duplicate_deck",
        "A deck with the same device, orientation, and locale already exists",
      );
    }
  }
}

export function createProjectDocument(
  initialDeck: DeckInput,
  options: CreateProjectDocumentOptions = {},
): ProjectDocumentV3 {
  const timestamp = operationTimestamp(options);
  const appId = options.appId ?? createAppId();
  const versionId = options.versionId ?? createVersionId();
  const deckId = options.deckId ?? initialDeck.id ?? createDeckId();
  const deck = makeDeck(initialDeck, deckId);
  const version = makeVersion(
    versionId,
    options.versionName ?? "Draft 1",
    deck,
    timestamp,
  );
  const app: AppRecord = {
    id: appId,
    name: options.appName ?? "My App",
    createdAt: timestamp,
    updatedAt: timestamp,
    versionOrder: [versionId],
    versionsById: { [versionId]: version } as Record<VersionId, VersionRecord>,
  };
  const document: ProjectDocumentV3 = {
    schemaVersion: 3,
    projectId: options.projectId ?? createProjectId(),
    name: options.projectName ?? "VibeScreens Project",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    appOrder: [appId],
    appsById: { [appId]: app } as Record<AppId, AppRecord>,
    assetsById: {},
    selection: selectionFor(appId, versionId, deck),
  };
  return finalize(document, timestamp, false);
}

export function createApp(
  document: ProjectDocumentV3,
  name: string,
  initialDeck: DeckInput,
  options: CreateAppOptions = {},
): ProjectDocumentV3 {
  assertUniqueName(Object.values(document.appsById), name);
  const timestamp = operationTimestamp(options);
  const appId = options.appId ?? createAppId();
  if (document.appsById[appId] !== undefined) {
    throw new DomainOperationError("not_found", `App ID ${appId} is already in use`);
  }
  const versionId = options.versionId ?? createVersionId();
  const deckId = options.deckId ?? initialDeck.id ?? createDeckId();
  const deck = makeDeck(initialDeck, deckId);
  const version = makeVersion(
    versionId,
    options.versionName ?? "Draft 1",
    deck,
    timestamp,
  );
  const next = cloneDocument(document);
  next.appsById[appId] = {
    id: appId,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    versionOrder: [versionId],
    versionsById: { [versionId]: version } as Record<VersionId, VersionRecord>,
  };
  next.appOrder.push(appId);
  next.selection = selectionFor(appId, versionId, deck);
  return finalize(next, timestamp);
}

export function renameApp(
  document: ProjectDocumentV3,
  appId: AppId,
  name: string,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  const current = getApp(document, appId);
  assertUniqueName(Object.values(document.appsById), name, appId);
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  const app = getApp(next, current.id);
  app.name = name;
  app.updatedAt = timestamp;
  return finalize(next, timestamp);
}

export function deleteApp(
  document: ProjectDocumentV3,
  appId: AppId,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  getApp(document, appId);
  if (document.appOrder.length === 1) {
    throw new DomainOperationError("last_app", "The last app cannot be deleted");
  }
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  delete next.appsById[appId];
  next.appOrder = next.appOrder.filter((id) => id !== appId);
  for (const [assetId, asset] of Object.entries(next.assetsById)) {
    if (asset.scope.appId === appId) delete next.assetsById[assetId as keyof typeof next.assetsById];
  }
  return finalize(next, timestamp);
}

export function createVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  name: string,
  initialDeck: DeckInput,
  options: CreateVersionOptions = {},
): ProjectDocumentV3 {
  const currentApp = getApp(document, appId);
  assertUniqueName(Object.values(currentApp.versionsById), name);
  const timestamp = operationTimestamp(options);
  const versionId = options.versionId ?? createVersionId();
  if (currentApp.versionsById[versionId] !== undefined) {
    throw new DomainOperationError("not_found", `Version ID ${versionId} is already in use`);
  }
  const deckId = options.deckId ?? initialDeck.id ?? createDeckId();
  const deck = makeDeck(initialDeck, deckId);
  const version = makeVersion(versionId, name, deck, timestamp);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  app.versionsById[versionId] = version;
  app.versionOrder.push(versionId);
  app.updatedAt = timestamp;
  next.selection = selectionFor(appId, versionId, deck);
  return finalize(next, timestamp);
}

function rewriteVersionAssetUrls(
  version: VersionRecord,
  urlMap: ReadonlyMap<string, string>,
): void {
  const rewrite = (url: string): string => urlMap.get(url) ?? url;
  for (const deck of Object.values(version.decksById)) {
    deck.appIcon = rewrite(deck.appIcon);
    if (deck.importedFont !== undefined) {
      deck.importedFont.src = rewrite(deck.importedFont.src);
    }
    if (deck.crossScreenMockups !== undefined) {
      deck.crossScreenMockups = deck.crossScreenMockups.map(rewrite);
    }
    for (const slide of deck.slides) {
      slide.screenshot = rewrite(slide.screenshot);
      if (slide.screenshotSecondary !== undefined) {
        slide.screenshotSecondary = rewrite(slide.screenshotSecondary);
      }
      if (slide.imageElements !== undefined) {
        for (const element of slide.imageElements) element.src = rewrite(element.src);
      }
    }
  }
}

function cloneAssetRef(
  projectId: ProjectId,
  asset: AssetRef,
  targetVersionId: VersionId,
): AssetRef {
  const url = managedAssetUrl({
    projectId,
    appId: asset.scope.appId,
    versionId: targetVersionId,
    kind: asset.kind,
    sha256: asset.sha256,
    extension: asset.extension,
  });
  return {
    ...structuredClone(asset),
    id: assetIdFor(targetVersionId, asset.kind, asset.sha256, asset.extension),
    scope: { appId: asset.scope.appId, versionId: targetVersionId },
    url,
  };
}

export function cloneVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  sourceVersionId: VersionId,
  name: string,
  options: CloneVersionOptions = {},
): ProjectDocumentV3 {
  const currentApp = getApp(document, appId);
  const source = getVersion(document, appId, sourceVersionId);
  assertUniqueName(Object.values(currentApp.versionsById), name);
  const timestamp = operationTimestamp(options);
  const versionId = options.versionId ?? createVersionId();
  if (currentApp.versionsById[versionId] !== undefined) {
    throw new DomainOperationError("not_found", `Version ID ${versionId} is already in use`);
  }

  const clone: VersionRecord = {
    id: versionId,
    name,
    status: "draft",
    sourceVersionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    deckOrder: structuredClone(source.deckOrder),
    decksById: structuredClone(source.decksById),
  };
  const next = cloneDocument(document);
  const urlMap = new Map<string, string>();
  for (const asset of Object.values(document.assetsById)) {
    if (asset.scope.appId !== appId || asset.scope.versionId !== sourceVersionId) continue;
    const clonedAsset = cloneAssetRef(document.projectId, asset, versionId);
    if (next.assetsById[clonedAsset.id] !== undefined) {
      throw new DomainOperationError(
        "not_found",
        `Asset ID ${clonedAsset.id} is already in use`,
      );
    }
    next.assetsById[clonedAsset.id] = clonedAsset;
    urlMap.set(asset.url, clonedAsset.url);
  }
  rewriteVersionAssetUrls(clone, urlMap);
  const app = getApp(next, appId);
  app.versionsById[versionId] = clone;
  app.versionOrder.push(versionId);
  app.updatedAt = timestamp;
  const firstDeck = clone.decksById[clone.deckOrder[0]];
  next.selection = selectionFor(appId, versionId, firstDeck);
  return finalize(next, timestamp);
}

export function renameVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  name: string,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  const currentApp = getApp(document, appId);
  const currentVersion = getVersion(document, appId, versionId);
  assertDraft(currentVersion);
  assertUniqueName(Object.values(currentApp.versionsById), name, versionId);
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  const version = getVersion(next, appId, versionId);
  version.name = name;
  version.updatedAt = timestamp;
  app.updatedAt = timestamp;
  return finalize(next, timestamp);
}

export async function publishVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  options: TimestampOptions = {},
): Promise<ProjectDocumentV3> {
  const currentVersion = getVersion(document, appId, versionId);
  assertDraft(currentVersion);
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  const version = getVersion(next, appId, versionId);
  version.status = "published";
  version.publishedAt = timestamp;
  version.updatedAt = timestamp;
  version.contentHash = "0".repeat(64);
  // Normalization verifies that every published reference is registered, correctly
  // scoped, and reachable before the immutable snapshot is sealed.
  normalizeProjectDocument(next);
  version.contentHash = await computePublishedVersionContentHash(next, appId, versionId);
  app.updatedAt = timestamp;
  return finalize(next, timestamp);
}

export function deleteVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  const currentApp = getApp(document, appId);
  getVersion(document, appId, versionId);
  if (currentApp.versionOrder.length === 1) {
    throw new DomainOperationError(
      "last_version",
      "The last version in an app cannot be deleted",
    );
  }
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  delete app.versionsById[versionId];
  app.versionOrder = app.versionOrder.filter((id) => id !== versionId);
  for (const [assetId, asset] of Object.entries(next.assetsById)) {
    if (asset.scope.appId === appId && asset.scope.versionId === versionId) {
      delete next.assetsById[assetId as keyof typeof next.assetsById];
    }
  }
  for (const version of Object.values(app.versionsById)) {
    if (version.sourceVersionId === versionId) delete version.sourceVersionId;
  }
  app.updatedAt = timestamp;
  return finalize(next, timestamp);
}

export function createDeck(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  input: DeckInput,
  options: CreateDeckOptions = {},
): ProjectDocumentV3 {
  const currentVersion = getVersion(document, appId, versionId);
  assertDraft(currentVersion);
  const timestamp = operationTimestamp(options);
  const deckId = options.deckId ?? input.id ?? createDeckId();
  if (currentVersion.decksById[deckId] !== undefined) {
    throw new DomainOperationError("not_found", `Deck ID ${deckId} is already in use`);
  }
  const deck = makeDeck(input, deckId);
  assertUniqueDeck(currentVersion, deck);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  const version = getVersion(next, appId, versionId);
  version.decksById[deckId] = deck;
  version.deckOrder.push(deckId);
  version.updatedAt = timestamp;
  app.updatedAt = timestamp;
  next.selection = selectionFor(appId, versionId, deck);
  return finalize(next, timestamp);
}

export function updateDeck(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  deckId: DeckId,
  changes: Partial<Omit<DeckRecord, "id">>,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  const currentVersion = getVersion(document, appId, versionId);
  assertDraft(currentVersion);
  const currentDeck = getDeck(document, appId, versionId, deckId);
  const candidate: DeckRecord = {
    ...structuredClone(currentDeck),
    ...structuredClone(changes),
    id: deckId,
  };
  assertUniqueDeck(currentVersion, candidate, deckId);
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  const version = getVersion(next, appId, versionId);
  version.decksById[deckId] = candidate;
  version.updatedAt = timestamp;
  app.updatedAt = timestamp;
  return finalize(next, timestamp);
}

export function deleteDeck(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  deckId: DeckId,
  options: TimestampOptions = {},
): ProjectDocumentV3 {
  const currentVersion = getVersion(document, appId, versionId);
  assertDraft(currentVersion);
  getDeck(document, appId, versionId, deckId);
  if (currentVersion.deckOrder.length === 1) {
    throw new DomainOperationError(
      "last_deck",
      "The last deck in a version cannot be deleted",
    );
  }
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  const app = getApp(next, appId);
  const version = getVersion(next, appId, versionId);
  delete version.decksById[deckId];
  version.deckOrder = version.deckOrder.filter((id) => id !== deckId);
  version.updatedAt = timestamp;
  app.updatedAt = timestamp;
  return finalize(next, timestamp);
}

export function selectAppVersion(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  deckId?: DeckId,
  options: SelectionOptions = {},
): ProjectDocumentV3 {
  const version = getVersion(document, appId, versionId);
  const selectedDeckId = deckId ?? version.deckOrder[0];
  const deck = getDeck(document, appId, versionId, selectedDeckId);
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  next.selection = selectionFor(
    appId,
    versionId,
    deck,
    options.slideId,
  );
  return finalize(next, timestamp);
}

export function selectDeck(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
  deckId: DeckId,
  options: SelectionOptions = {},
): ProjectDocumentV3 {
  getVersion(document, appId, versionId);
  const deck = getDeck(document, appId, versionId, deckId);
  const timestamp = operationTimestamp(options);
  const next = cloneDocument(document);
  next.selection = selectionFor(
    appId,
    versionId,
    deck,
    options.slideId,
  );
  return finalize(next, timestamp);
}
