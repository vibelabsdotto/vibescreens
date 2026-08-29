import type { ProjectId } from "./workspace";
import type { Device, ImportedFont, Orientation, Slide } from "./types";
import { sha256CanonicalJson } from "./canonical-json";
import {
  isAppId,
  isAssetId,
  isDeckId,
  isVersionId,
  type AppId,
  type AssetId,
  type DeckId,
  type VersionId,
} from "./ids";
import { isProjectId } from "./workspace";

export type VersionStatus = "draft" | "published";
export type AssetKind = "screenshot" | "image" | "font" | "app-icon";

export interface AssetRef {
  id: AssetId;
  scope: {
    appId: AppId;
    versionId: VersionId;
  };
  kind: AssetKind;
  originalName: string;
  mime: string;
  bytes: number;
  sha256: string;
  extension: string;
  url: string;
}

export interface ProjectMigrationMetadata {
  from: 0 | 1 | 2;
  migratedAt: string;
  backupPath: string;
  warnings: string[];
  sourceFile: "vibescreens.json" | "app-store-screenshots.json";
  sourceSha256: string;
}

export interface ProjectSelection {
  appId: AppId;
  versionId: VersionId;
  deckId: DeckId;
  slideId?: string;
}

export interface DeckRecord {
  id: DeckId;
  device: Device;
  orientation: Orientation;
  locale: string;
  connectedCanvas: boolean;
  appName: string;
  themeId: string;
  fontId: string;
  importedFont?: ImportedFont;
  appIcon: string;
  crossScreenMockups?: string[];
  slides: Slide[];
}

export interface VersionRecord {
  id: VersionId;
  name: string;
  status: VersionStatus;
  sourceVersionId?: VersionId;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  contentHash?: string;
  deckOrder: DeckId[];
  decksById: Record<DeckId, DeckRecord>;
}

export interface AppRecord {
  id: AppId;
  name: string;
  createdAt: string;
  updatedAt: string;
  versionOrder: VersionId[];
  versionsById: Record<VersionId, VersionRecord>;
}

export interface ProjectDocumentV3 {
  schemaVersion: 3;
  projectId: ProjectId;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  appOrder: AppId[];
  appsById: Record<AppId, AppRecord>;
  assetsById: Record<AssetId, AssetRef>;
  selection: ProjectSelection;
  migration?: ProjectMigrationMetadata;
}

export type ProjectValidationIssueCode =
  | "invalid_schema"
  | "unsupported_schema"
  | "invalid_structure"
  | "invalid_id"
  | "invalid_name"
  | "duplicate_name"
  | "invalid_order"
  | "empty_project"
  | "empty_app"
  | "empty_version"
  | "duplicate_deck_axis"
  | "invalid_selection"
  | "invalid_asset"
  | "invalid_asset_reference"
  | "invalid_published";

export interface ProjectValidationIssue {
  code: ProjectValidationIssueCode;
  path: string;
  message: string;
}

export interface ProjectValidationResult {
  ok: boolean;
  readOnly: boolean;
  issues: ProjectValidationIssue[];
}

export class ProjectSchemaError extends Error {
  readonly issues: ProjectValidationIssue[];
  readonly readOnly: boolean;

  constructor(
    message: string,
    issues: ProjectValidationIssue[],
    readOnly = false,
  ) {
    super(message);
    this.name = "ProjectSchemaError";
    this.issues = issues;
    this.readOnly = readOnly;
  }
}

export class UnsupportedProjectSchemaVersionError extends ProjectSchemaError {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    const issue: ProjectValidationIssue = {
      code: "unsupported_schema",
      path: "schemaVersion",
      message: `Schema version ${schemaVersion} is newer than supported version 3`,
    };
    super(issue.message, [issue], true);
    this.name = "UnsupportedProjectSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}

const DEVICES: ReadonlySet<string> = new Set([
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
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const ASSET_KIND_DIRECTORIES: Record<AssetKind, string> = {
  screenshot: "screenshots",
  image: "images",
  font: "fonts",
  "app-icon": "app-icons",
};
const ASSET_DIRECTORY_KINDS = new Map<string, AssetKind>(
  Object.entries(ASSET_KIND_DIRECTORIES).map(([kind, directory]) => [
    directory,
    kind as AssetKind,
  ]),
);
const FONT_FORMATS: ReadonlySet<string> = new Set([
  "woff2",
  "woff",
  "truetype",
  "opentype",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assetKindDirectory(kind: AssetKind): string {
  return ASSET_KIND_DIRECTORIES[kind];
}

export function assetIdFor(
  versionId: VersionId,
  kind: AssetKind,
  sha256: string,
  extension: string,
): AssetId {
  const kindToken: Record<AssetKind, string> = {
    screenshot: "ss",
    image: "im",
    font: "ft",
    "app-icon": "ai",
  };
  const versionToken = versionId.slice(4).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  return `asset_${versionToken}_${kindToken[kind]}_${sha256.slice(0, 32)}_${extension.slice(0, 6)}` as AssetId;
}

export function managedAssetUrl(input: {
  projectId: ProjectId;
  appId: AppId;
  versionId: VersionId;
  kind: AssetKind;
  sha256: string;
  extension: string;
}): string {
  return `/vibescreens-assets/${input.projectId}/${input.appId}/${input.versionId}/${assetKindDirectory(input.kind)}/${input.sha256}.${input.extension}`;
}

export interface ParsedManagedAssetUrl {
  projectId: ProjectId;
  appId: AppId;
  versionId: VersionId;
  kind: AssetKind;
  sha256: string;
  extension: string;
}

export function parseManagedAssetUrl(value: string): ParsedManagedAssetUrl | undefined {
  if (!value.startsWith("/vibescreens-assets/") || value.includes("\\")) return undefined;
  const parts = value.split("/");
  if (parts.length !== 7 || parts[0] !== "" || parts[1] !== "vibescreens-assets") {
    return undefined;
  }
  const [, , projectId, appId, versionId, directory, filename] = parts;
  if (
    !isProjectId(projectId) ||
    !isAppId(appId) ||
    !isVersionId(versionId) ||
    !ASSET_DIRECTORY_KINDS.has(directory)
  ) {
    return undefined;
  }
  const match = /^([a-f0-9]{64})\.([a-z0-9]{1,10})$/.exec(filename);
  if (match === null) return undefined;
  return {
    projectId,
    appId,
    versionId,
    kind: ASSET_DIRECTORY_KINDS.get(directory)!,
    sha256: match[1],
    extension: match[2],
  };
}

export function assetsForVersion(
  document: Pick<ProjectDocumentV3, "assetsById">,
  appId: AppId,
  versionId: VersionId,
): Record<AssetId, AssetRef> {
  return Object.fromEntries(
    Object.entries(document.assetsById).filter(
      ([, asset]) => asset.scope.appId === appId && asset.scope.versionId === versionId,
    ),
  ) as Record<AssetId, AssetRef>;
}

export function publishedVersionSnapshot(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
): unknown {
  const version = document.appsById[appId]?.versionsById[versionId];
  if (version === undefined) throw new TypeError(`Version ${versionId} does not exist`);
  const { contentHash: _contentHash, ...sealedVersion } = version;
  return {
    contract: "vibescreens.published-version@1",
    owner: { projectId: document.projectId, appId, versionId },
    version: sealedVersion,
    assetsById: assetsForVersion(document, appId, versionId),
  };
}

export function computePublishedVersionContentHash(
  document: ProjectDocumentV3,
  appId: AppId,
  versionId: VersionId,
): Promise<string> {
  return sha256CanonicalJson(publishedVersionSnapshot(document, appId, versionId));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidImportedFontSource(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes("\\")) return false;
  if (value.startsWith("/")) {
    return !value.startsWith("//") && !value.split("/").includes("..");
  }
  if (/^data:font\/(?:woff2?|ttf|otf|truetype|opentype)(?:;[^,]*)?,/i.test(value)) {
    return true;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "blob:";
  } catch {
    return false;
  }
}

function normalizedDisplayName(value: string): string {
  return value.trim().normalize("NFC");
}

export function normalizedNameKey(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function addIssue(
  issues: ProjectValidationIssue[],
  code: ProjectValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

interface AssetReference {
  url: string;
  kind: AssetKind;
  path: string;
}

function assetReferencesForVersion(raw: Record<string, unknown>, path: string): AssetReference[] {
  const references: AssetReference[] = [];
  const add = (url: unknown, kind: AssetKind, referencePath: string) => {
    if (typeof url === "string" && url.length > 0) {
      references.push({ url, kind, path: referencePath });
    }
  };
  if (!isRecord(raw.decksById)) return references;
  for (const [deckId, rawDeck] of Object.entries(raw.decksById)) {
    if (!isRecord(rawDeck)) continue;
    const deckPath = `${path}.decksById.${deckId}`;
    add(rawDeck.appIcon, "app-icon", `${deckPath}.appIcon`);
    if (isRecord(rawDeck.importedFont)) {
      add(rawDeck.importedFont.src, "font", `${deckPath}.importedFont.src`);
    }
    if (Array.isArray(rawDeck.crossScreenMockups)) {
      rawDeck.crossScreenMockups.forEach((url, index) =>
        add(url, "image", `${deckPath}.crossScreenMockups.${index}`),
      );
    }
    if (!Array.isArray(rawDeck.slides)) continue;
    rawDeck.slides.forEach((rawSlide, slideIndex) => {
      if (!isRecord(rawSlide)) return;
      const slidePath = `${deckPath}.slides.${slideIndex}`;
      add(rawSlide.screenshot, "screenshot", `${slidePath}.screenshot`);
      add(
        rawSlide.screenshotSecondary,
        "screenshot",
        `${slidePath}.screenshotSecondary`,
      );
      if (Array.isArray(rawSlide.imageElements)) {
        rawSlide.imageElements.forEach((rawImage, imageIndex) => {
          if (isRecord(rawImage)) {
            add(rawImage.src, "image", `${slidePath}.imageElements.${imageIndex}.src`);
          }
        });
      }
    });
  }
  return references;
}

function validateAssetRegistry(
  document: Record<string, unknown>,
  issues: ProjectValidationIssue[],
): void {
  if (!isRecord(document.assetsById)) {
    addIssue(issues, "invalid_structure", "assetsById", "Expected an asset record");
    return;
  }

  const assetsByUrl = new Map<string, { id: string; asset: Record<string, unknown> }>();
  for (const [assetId, rawAsset] of Object.entries(document.assetsById)) {
    const path = `assetsById.${assetId}`;
    if (!isRecord(rawAsset)) {
      addIssue(issues, "invalid_asset", path, "Expected an asset ref");
      continue;
    }
    if (!isAssetId(assetId) || rawAsset.id !== assetId) {
      addIssue(issues, "invalid_asset", `${path}.id`, "Asset ID must match its map key");
    }
    if (!isRecord(rawAsset.scope)) {
      addIssue(issues, "invalid_asset", `${path}.scope`, "Asset scope is required");
      continue;
    }
    const appId = rawAsset.scope.appId;
    const versionId = rawAsset.scope.versionId;
    const app = isRecord(document.appsById) && typeof appId === "string"
      ? document.appsById[appId]
      : undefined;
    const version =
      isRecord(app) && isRecord(app.versionsById) && typeof versionId === "string"
        ? app.versionsById[versionId]
        : undefined;
    if (!isAppId(appId) || !isVersionId(versionId) || !isRecord(version)) {
      addIssue(
        issues,
        "invalid_asset",
        `${path}.scope`,
        "Asset scope must reference a version in the same project",
      );
    }
    if (
      rawAsset.kind !== "screenshot" &&
      rawAsset.kind !== "image" &&
      rawAsset.kind !== "font" &&
      rawAsset.kind !== "app-icon"
    ) {
      addIssue(issues, "invalid_asset", `${path}.kind`, "Invalid asset kind");
    }
    if (
      !isNonEmptyString(rawAsset.originalName) ||
      rawAsset.originalName.includes("/") ||
      rawAsset.originalName.includes("\\")
    ) {
      addIssue(issues, "invalid_asset", `${path}.originalName`, "Invalid original name");
    }
    if (typeof rawAsset.mime !== "string" || !MIME_PATTERN.test(rawAsset.mime)) {
      addIssue(issues, "invalid_asset", `${path}.mime`, "Invalid MIME type");
    }
    if (!Number.isSafeInteger(rawAsset.bytes) || Number(rawAsset.bytes) < 0) {
      addIssue(issues, "invalid_asset", `${path}.bytes`, "Asset bytes must be an integer >= 0");
    }
    if (typeof rawAsset.sha256 !== "string" || !HASH_PATTERN.test(rawAsset.sha256)) {
      addIssue(issues, "invalid_asset", `${path}.sha256`, "Invalid asset SHA-256");
    }
    if (
      typeof rawAsset.extension !== "string" ||
      !ASSET_EXTENSION_PATTERN.test(rawAsset.extension)
    ) {
      addIssue(issues, "invalid_asset", `${path}.extension`, "Invalid asset extension");
    }
    if (typeof rawAsset.url !== "string") {
      addIssue(issues, "invalid_asset", `${path}.url`, "Asset URL is required");
      continue;
    }
    const parsed = parseManagedAssetUrl(rawAsset.url);
    if (
      parsed === undefined ||
      parsed.projectId !== document.projectId ||
      parsed.appId !== appId ||
      parsed.versionId !== versionId ||
      parsed.kind !== rawAsset.kind ||
      parsed.sha256 !== rawAsset.sha256 ||
      parsed.extension !== rawAsset.extension
    ) {
      addIssue(
        issues,
        "invalid_asset",
        `${path}.url`,
        "Asset URL must match its project, scope, kind, digest, and extension",
      );
    }
    if (assetsByUrl.has(rawAsset.url)) {
      addIssue(issues, "invalid_asset", `${path}.url`, "Asset URLs must be unique");
    } else {
      assetsByUrl.set(rawAsset.url, { id: assetId, asset: rawAsset });
    }
  }

  if (!isRecord(document.appsById)) return;
  const reachablePublishedAssets = new Set<string>();
  for (const [appId, rawApp] of Object.entries(document.appsById)) {
    if (!isRecord(rawApp) || !isRecord(rawApp.versionsById)) continue;
    for (const [versionId, rawVersion] of Object.entries(rawApp.versionsById)) {
      if (!isRecord(rawVersion)) continue;
      const versionPath = `appsById.${appId}.versionsById.${versionId}`;
      for (const reference of assetReferencesForVersion(rawVersion, versionPath)) {
        const registered = assetsByUrl.get(reference.url);
        const managed = reference.url.startsWith("/vibescreens-assets/");
        if (registered === undefined) {
          if (rawVersion.status === "published") {
            addIssue(
              issues,
              "invalid_asset_reference",
              reference.path,
              managed
                ? "Published asset URL is not registered"
                : "Published versions may only reference managed assets",
            );
          }
          continue;
        }
        const asset = registered.asset;
        const scope = isRecord(asset.scope) ? asset.scope : {};
        if (
          scope.appId !== appId ||
          scope.versionId !== versionId ||
          asset.kind !== reference.kind
        ) {
          addIssue(
            issues,
            "invalid_asset_reference",
            reference.path,
            "Asset reference kind and scope must match its registry entry",
          );
        }
        if (rawVersion.status === "published") reachablePublishedAssets.add(registered.id);
      }
    }
  }

  for (const [assetId, rawAsset] of Object.entries(document.assetsById)) {
    if (!isRecord(rawAsset) || !isRecord(rawAsset.scope)) continue;
    const app =
      isRecord(document.appsById) && typeof rawAsset.scope.appId === "string"
        ? document.appsById[rawAsset.scope.appId]
        : undefined;
    const version =
      isRecord(app) && isRecord(app.versionsById) && typeof rawAsset.scope.versionId === "string"
        ? app.versionsById[rawAsset.scope.versionId]
        : undefined;
    if (isRecord(version) && version.status === "published" && !reachablePublishedAssets.has(assetId)) {
      addIssue(
        issues,
        "invalid_asset_reference",
        `assetsById.${assetId}`,
        "Published asset registry entries must be reachable from their version",
      );
    }
  }
}

function validateTimestamp(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
    addIssue(issues, "invalid_structure", path, "Expected an ISO timestamp");
  }
}

function validateOrder(
  order: unknown,
  map: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  if (!Array.isArray(order) || !isRecord(map)) {
    addIssue(
      issues,
      "invalid_structure",
      path,
      "Expected an order array and matching record",
    );
    return;
  }

  const mapKeys = Object.keys(map);
  const uniqueOrder = new Set(order);
  const exactMatch =
    uniqueOrder.size === order.length &&
    order.every((id) => typeof id === "string" && id in map) &&
    mapKeys.every((id) => uniqueOrder.has(id)) &&
    order.length === mapKeys.length;

  if (!exactMatch) {
    addIssue(
      issues,
      "invalid_order",
      path,
      "Order array must contain every map ID exactly once",
    );
  }
}

function validateUniqueNames(
  records: Record<string, unknown>,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  const seen = new Map<string, string>();
  for (const [id, raw] of Object.entries(records)) {
    if (!isRecord(raw) || !isNonEmptyString(raw.name)) continue;
    const key = normalizedNameKey(raw.name);
    const existing = seen.get(key);
    if (existing !== undefined) {
      addIssue(
        issues,
        "duplicate_name",
        `${path}.${id}.name`,
        `Name duplicates ${existing} after normalization`,
      );
    } else {
      seen.set(key, id);
    }
  }
}

function validateDeck(
  raw: unknown,
  key: string,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  if (!isRecord(raw)) {
    addIssue(issues, "invalid_structure", path, "Expected a deck record");
    return;
  }
  if (!isDeckId(key) || raw.id !== key) {
    addIssue(issues, "invalid_id", `${path}.id`, "Deck ID must match its map key");
  }
  if (typeof raw.device !== "string" || !DEVICES.has(raw.device)) {
    addIssue(issues, "invalid_structure", `${path}.device`, "Invalid device");
  }
  if (raw.orientation !== "portrait" && raw.orientation !== "landscape") {
    addIssue(
      issues,
      "invalid_structure",
      `${path}.orientation`,
      "Invalid orientation",
    );
  }
  if (!isNonEmptyString(raw.locale)) {
    addIssue(issues, "invalid_structure", `${path}.locale`, "Locale is required");
  }
  if (typeof raw.connectedCanvas !== "boolean") {
    addIssue(
      issues,
      "invalid_structure",
      `${path}.connectedCanvas`,
      "connectedCanvas must be boolean",
    );
  }
  for (const field of ["appName", "themeId", "fontId"] as const) {
    if (!isNonEmptyString(raw[field])) {
      addIssue(
        issues,
        "invalid_structure",
        `${path}.${field}`,
        `${field} is required`,
      );
    }
  }
  if (typeof raw.appIcon !== "string") {
    addIssue(issues, "invalid_structure", `${path}.appIcon`, "appIcon must be a string");
  }
  if (raw.importedFont !== undefined) {
    if (!isRecord(raw.importedFont)) {
      addIssue(
        issues,
        "invalid_structure",
        `${path}.importedFont`,
        "importedFont must be an object",
      );
    } else {
      if (!isValidImportedFontSource(raw.importedFont.src)) {
        addIssue(
          issues,
          "invalid_structure",
          `${path}.importedFont.src`,
          "Imported font source must be a safe font URL",
        );
      }
      if (
        typeof raw.importedFont.format !== "string" ||
        !FONT_FORMATS.has(raw.importedFont.format)
      ) {
        addIssue(
          issues,
          "invalid_structure",
          `${path}.importedFont.format`,
          "Unsupported imported font format",
        );
      }
    }
  }
  if (
    raw.crossScreenMockups !== undefined &&
    (!Array.isArray(raw.crossScreenMockups) ||
      !raw.crossScreenMockups.every((entry) => typeof entry === "string"))
  ) {
    addIssue(
      issues,
      "invalid_structure",
      `${path}.crossScreenMockups`,
      "crossScreenMockups must be a string array",
    );
  }
  if (!Array.isArray(raw.slides)) {
    addIssue(issues, "invalid_structure", `${path}.slides`, "slides must be an array");
    return;
  }

  const slideIds = new Set<string>();
  for (const [index, slide] of raw.slides.entries()) {
    if (!isRecord(slide) || !isNonEmptyString(slide.id)) {
      addIssue(
        issues,
        "invalid_structure",
        `${path}.slides.${index}.id`,
        "Every slide must have an ID",
      );
      continue;
    }
    if (slideIds.has(slide.id)) {
      addIssue(
        issues,
        "invalid_id",
        `${path}.slides.${index}.id`,
        "Slide IDs must be unique within a deck",
      );
    }
    slideIds.add(slide.id);
  }
}

function validateVersion(
  raw: unknown,
  key: string,
  appVersions: Record<string, unknown>,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  if (!isRecord(raw)) {
    addIssue(issues, "invalid_structure", path, "Expected a version record");
    return;
  }
  if (!isVersionId(key) || raw.id !== key) {
    addIssue(
      issues,
      "invalid_id",
      `${path}.id`,
      "Version ID must match its map key",
    );
  }
  if (!isNonEmptyString(raw.name)) {
    addIssue(issues, "invalid_name", `${path}.name`, "Version name is required");
  }
  if (raw.status !== "draft" && raw.status !== "published") {
    addIssue(issues, "invalid_structure", `${path}.status`, "Invalid version status");
  }
  validateTimestamp(raw.createdAt, `${path}.createdAt`, issues);
  validateTimestamp(raw.updatedAt, `${path}.updatedAt`, issues);

  if (
    raw.sourceVersionId !== undefined &&
    (!isVersionId(raw.sourceVersionId) || !(raw.sourceVersionId in appVersions))
  ) {
    addIssue(
      issues,
      "invalid_id",
      `${path}.sourceVersionId`,
      "sourceVersionId must reference a version in the same app",
    );
  }

  if (raw.status === "published") {
    if (!isNonEmptyString(raw.publishedAt)) {
      addIssue(
        issues,
        "invalid_published",
        `${path}.publishedAt`,
        "Published versions require publishedAt",
      );
    } else {
      validateTimestamp(raw.publishedAt, `${path}.publishedAt`, issues);
    }
    if (typeof raw.contentHash !== "string" || !HASH_PATTERN.test(raw.contentHash)) {
      addIssue(
        issues,
        "invalid_published",
        `${path}.contentHash`,
        "Published versions require a SHA-256 contentHash",
      );
    }
  } else if (raw.publishedAt !== undefined || raw.contentHash !== undefined) {
    addIssue(
      issues,
      "invalid_published",
      path,
      "Draft versions cannot carry publication metadata",
    );
  }

  validateOrder(raw.deckOrder, raw.decksById, `${path}.deckOrder`, issues);
  if (!isRecord(raw.decksById)) return;
  if (Object.keys(raw.decksById).length === 0) {
    addIssue(
      issues,
      "empty_version",
      `${path}.decksById`,
      "A version must contain at least one deck",
    );
  }

  const axes = new Map<string, string>();
  for (const [deckId, deck] of Object.entries(raw.decksById)) {
    const deckPath = `${path}.decksById.${deckId}`;
    validateDeck(deck, deckId, deckPath, issues);
    if (!isRecord(deck)) continue;
    const axis = [deck.device, deck.orientation, normalizedNameKey(String(deck.locale))].join(
      "\u0000",
    );
    const existing = axes.get(axis);
    if (existing !== undefined) {
      addIssue(
        issues,
        "duplicate_deck_axis",
        deckPath,
        `Deck duplicates ${existing}'s device, orientation, and locale`,
      );
    } else {
      axes.set(axis, deckId);
    }
  }
}

function validateApp(
  raw: unknown,
  key: string,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  if (!isRecord(raw)) {
    addIssue(issues, "invalid_structure", path, "Expected an app record");
    return;
  }
  if (!isAppId(key) || raw.id !== key) {
    addIssue(issues, "invalid_id", `${path}.id`, "App ID must match its map key");
  }
  if (!isNonEmptyString(raw.name)) {
    addIssue(issues, "invalid_name", `${path}.name`, "App name is required");
  }
  validateTimestamp(raw.createdAt, `${path}.createdAt`, issues);
  validateTimestamp(raw.updatedAt, `${path}.updatedAt`, issues);
  validateOrder(raw.versionOrder, raw.versionsById, `${path}.versionOrder`, issues);

  if (!isRecord(raw.versionsById)) return;
  if (Object.keys(raw.versionsById).length === 0) {
    addIssue(
      issues,
      "empty_app",
      `${path}.versionsById`,
      "An app must contain at least one version",
    );
  }
  validateUniqueNames(raw.versionsById, `${path}.versionsById`, issues);
  for (const [versionId, version] of Object.entries(raw.versionsById)) {
    validateVersion(
      version,
      versionId,
      raw.versionsById,
      `${path}.versionsById.${versionId}`,
      issues,
    );
  }
}

function validateMigration(
  raw: unknown,
  issues: ProjectValidationIssue[],
): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    addIssue(issues, "invalid_structure", "migration", "Expected migration metadata");
    return;
  }
  if (raw.from !== 0 && raw.from !== 1 && raw.from !== 2) {
    addIssue(issues, "invalid_structure", "migration.from", "Invalid source schema");
  }
  validateTimestamp(raw.migratedAt, "migration.migratedAt", issues);
  if (!isNonEmptyString(raw.backupPath)) {
    addIssue(
      issues,
      "invalid_structure",
      "migration.backupPath",
      "Migration backup path is required",
    );
  }
  if (
    !Array.isArray(raw.warnings) ||
    !raw.warnings.every((warning) => typeof warning === "string")
  ) {
    addIssue(
      issues,
      "invalid_structure",
      "migration.warnings",
      "Migration warnings must be a string array",
    );
  }
  if (
    raw.sourceFile !== "vibescreens.json" &&
    raw.sourceFile !== "app-store-screenshots.json"
  ) {
    addIssue(
      issues,
      "invalid_structure",
      "migration.sourceFile",
      "Migration source file is not supported",
    );
  }
  if (typeof raw.sourceSha256 !== "string" || !HASH_PATTERN.test(raw.sourceSha256)) {
    addIssue(
      issues,
      "invalid_structure",
      "migration.sourceSha256",
      "Migration sourceSha256 must be a lowercase SHA-256",
    );
  }
}

function selectionIsValid(document: Record<string, unknown>): boolean {
  if (!isRecord(document.selection) || !isRecord(document.appsById)) return false;
  const app = document.appsById[document.selection.appId as string];
  if (!isRecord(app) || !isRecord(app.versionsById)) return false;
  const version = app.versionsById[document.selection.versionId as string];
  if (!isRecord(version) || !isRecord(version.decksById)) return false;
  const deck = version.decksById[document.selection.deckId as string];
  if (!isRecord(deck) || !Array.isArray(deck.slides)) return false;
  const slideId = document.selection.slideId;
  if (slideId === undefined) return true;
  return deck.slides.some(
    (slide) => isRecord(slide) && slide.id === slideId,
  );
}

export function validateProjectDocument(value: unknown): ProjectValidationResult {
  const issues: ProjectValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, "invalid_structure", "$", "Expected a project object");
    return { ok: false, readOnly: false, issues };
  }

  if (typeof value.schemaVersion === "number" && value.schemaVersion > 3) {
    addIssue(
      issues,
      "unsupported_schema",
      "schemaVersion",
      `Schema version ${value.schemaVersion} is newer than supported version 3`,
    );
    return { ok: false, readOnly: true, issues };
  }
  if (value.schemaVersion !== 3) {
    addIssue(issues, "invalid_schema", "schemaVersion", "Expected schema version 3");
    return { ok: false, readOnly: false, issues };
  }

  if (!isProjectId(value.projectId)) {
    addIssue(issues, "invalid_id", "projectId", "Invalid project ID");
  }
  if (!isNonEmptyString(value.name)) {
    addIssue(issues, "invalid_name", "name", "Project name is required");
  }
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) {
    addIssue(issues, "invalid_structure", "revision", "Revision must be an integer >= 1");
  }
  validateTimestamp(value.createdAt, "createdAt", issues);
  validateTimestamp(value.updatedAt, "updatedAt", issues);
  validateMigration(value.migration, issues);
  validateOrder(value.appOrder, value.appsById, "appOrder", issues);

  if (!isRecord(value.appsById)) {
    addIssue(issues, "invalid_structure", "appsById", "Expected an app record");
  } else {
    if (Object.keys(value.appsById).length === 0) {
      addIssue(
        issues,
        "empty_project",
        "appsById",
        "A project must contain at least one app",
      );
    }
    validateUniqueNames(value.appsById, "appsById", issues);
    for (const [appId, app] of Object.entries(value.appsById)) {
      validateApp(app, appId, `appsById.${appId}`, issues);
    }
  }

  validateAssetRegistry(value, issues);

  if (!selectionIsValid(value)) {
    addIssue(
      issues,
      "invalid_selection",
      "selection",
      "Selection must reference one valid app/version/deck/slide chain",
    );
  }

  return { ok: issues.length === 0, readOnly: false, issues };
}

function normalizeOrder<T extends string>(
  order: unknown,
  map: Record<string, unknown>,
): T[] {
  const result: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id === "string" && id in map && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
  }
  for (const id of Object.keys(map).sort()) {
    if (!seen.has(id)) result.push(id);
  }
  return result as T[];
}

function firstSlideId(deck: Record<string, unknown>): string | undefined {
  if (!Array.isArray(deck.slides)) return undefined;
  const first = deck.slides.find(
    (slide) => isRecord(slide) && isNonEmptyString(slide.id),
  );
  return isRecord(first) && typeof first.id === "string" ? first.id : undefined;
}

export function normalizeProjectDocument(value: unknown): ProjectDocumentV3 {
  if (isRecord(value) && typeof value.schemaVersion === "number" && value.schemaVersion > 3) {
    throw new UnsupportedProjectSchemaVersionError(value.schemaVersion);
  }
  if (!isRecord(value) || value.schemaVersion !== 3) {
    const validation = validateProjectDocument(value);
    throw new ProjectSchemaError("Invalid project document", validation.issues);
  }

  const document = structuredClone(value) as Record<string, unknown>;
  if (typeof document.name === "string") {
    document.name = normalizedDisplayName(document.name);
  }

  if (isRecord(document.appsById)) {
    document.appOrder = normalizeOrder<AppId>(document.appOrder, document.appsById);
    for (const app of Object.values(document.appsById)) {
      if (!isRecord(app)) continue;
      if (typeof app.name === "string") app.name = normalizedDisplayName(app.name);
      if (!isRecord(app.versionsById)) continue;
      app.versionOrder = normalizeOrder<VersionId>(app.versionOrder, app.versionsById);
      for (const version of Object.values(app.versionsById)) {
        if (!isRecord(version)) continue;
        if (typeof version.name === "string") {
          version.name = normalizedDisplayName(version.name);
        }
        if (!isRecord(version.decksById)) continue;
        version.deckOrder = normalizeOrder<DeckId>(version.deckOrder, version.decksById);
        for (const deck of Object.values(version.decksById)) {
          if (isRecord(deck) && typeof deck.locale === "string") {
            deck.locale = deck.locale.trim().normalize("NFC");
          }
        }
      }
    }
  }

  if (isRecord(document.appsById) && Array.isArray(document.appOrder)) {
    const requested = isRecord(document.selection) ? document.selection : {};
    const requestedAppId = requested.appId;
    const appId =
      typeof requestedAppId === "string" && requestedAppId in document.appsById
        ? requestedAppId
        : document.appOrder[0];
    const app = typeof appId === "string" ? document.appsById[appId] : undefined;
    if (isRecord(app) && isRecord(app.versionsById) && Array.isArray(app.versionOrder)) {
      const requestedVersionId = requested.versionId;
      const versionId =
        typeof requestedVersionId === "string" &&
        requestedVersionId in app.versionsById
          ? requestedVersionId
          : app.versionOrder[0];
      const version =
        typeof versionId === "string" ? app.versionsById[versionId] : undefined;
      if (
        isRecord(version) &&
        isRecord(version.decksById) &&
        Array.isArray(version.deckOrder)
      ) {
        const requestedDeckId = requested.deckId;
        const deckId =
          typeof requestedDeckId === "string" && requestedDeckId in version.decksById
            ? requestedDeckId
            : version.deckOrder[0];
        const deck =
          typeof deckId === "string" ? version.decksById[deckId] : undefined;
        if (isRecord(deck)) {
          const requestedSlideId = requested.slideId;
          const selectedSlideId =
            typeof requestedSlideId === "string" &&
            Array.isArray(deck.slides) &&
            deck.slides.some(
              (slide) => isRecord(slide) && slide.id === requestedSlideId,
            )
              ? requestedSlideId
              : firstSlideId(deck);
          document.selection = {
            appId,
            versionId,
            deckId,
            ...(selectedSlideId === undefined ? {} : { slideId: selectedSlideId }),
          };
        }
      }
    }
  }

  const validation = validateProjectDocument(document);
  if (!validation.ok) {
    throw new ProjectSchemaError(
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      validation.issues,
      validation.readOnly,
    );
  }
  return document as unknown as ProjectDocumentV3;
}

export function assertValidProjectDocument(
  value: unknown,
): asserts value is ProjectDocumentV3 {
  const validation = validateProjectDocument(value);
  if (!validation.ok) {
    if (validation.readOnly && isRecord(value) && typeof value.schemaVersion === "number") {
      throw new UnsupportedProjectSchemaVersionError(value.schemaVersion);
    }
    throw new ProjectSchemaError("Invalid project document", validation.issues);
  }
}
