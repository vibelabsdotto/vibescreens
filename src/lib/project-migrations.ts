import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { storeAsset, type AssetKind, type StoreAssetInput, type StoredAsset } from "./asset-store";
import {
  hasValidFontSignature,
  MAX_FONT_ASSET_BYTES,
  MAX_IMAGE_ASSET_BYTES,
  type SupportedFontExtension,
} from "./asset-content";
import { type AppId, type DeckId, type VersionId } from "./ids";
import { pickText, resolveScreenshot } from "./locale";
import {
  normalizeProjectDocument,
  type AppRecord,
  type DeckRecord,
  type ProjectDocumentV3,
  type VersionRecord,
} from "./project-schema";
import { sniffImageType } from "./request-guard";
import type {
  Device,
  ImageElement,
  ImportedFont,
  LocalizedText,
  Orientation,
  Slide,
  TextElement,
} from "./types";
import type { ProjectId } from "./workspace";

export type LegacyProjectVersion = 0 | 1 | 2;
export type LegacySourceFile = "vibescreens.json" | "app-store-screenshots.json";

export interface MigrationIssue {
  code:
    | "invalid_project"
    | "schema_marker_mismatch"
    | "defaulted_value"
    | "generated_slide_id"
    | "ignored_extra";
  path: string;
  message: string;
}

export type ProjectContentDetection =
  | { kind: "legacy"; version: LegacyProjectVersion; warnings: MigrationIssue[] }
  | { kind: "current"; version: 3 }
  | { kind: "unsupported"; version: number; readOnly: true }
  | { kind: "invalid"; issues: MigrationIssue[] };

export interface LegacyMigrationContext {
  sourceFile: LegacySourceFile;
  sourceSha256: string;
  backupPath: string;
  migratedAt: string;
  projectName?: string;
}

export interface LegacyAssetCandidate {
  kind: AssetKind;
  path: string;
  source: string;
}

export type ProjectMigrationResult =
  | { status: "current"; document: ProjectDocumentV3 }
  | {
      status: "migrated";
      sourceVersion: LegacyProjectVersion;
      document: ProjectDocumentV3;
      warnings: MigrationIssue[];
      assets: LegacyAssetCandidate[];
    }
  | {
      status: "blocked";
      sourceVersion?: LegacyProjectVersion;
      warnings: MigrationIssue[];
      blockers: MigrationIssue[];
    }
  | { status: "unsupported"; schemaVersion: number; readOnly: true };

export interface AssetMigrationWarning {
  code: "missing_asset" | "external_asset" | "invalid_asset";
  path: string;
  source: string;
  message: string;
}

export interface MaterializeLegacyAssetsOptions {
  rootDirectory?: string;
  store?: (input: StoreAssetInput) => Promise<StoredAsset>;
  /** Reject unresolved sources before persisting any asset. */
  requireAllAssets?: boolean;
}

export type MaterializedProjectMigration = Omit<
  Extract<ProjectMigrationResult, { status: "migrated" }>,
  "warnings"
> & { warnings: Array<MigrationIssue | AssetMigrationWarning> };

type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEVICES: readonly Device[] = [
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
];
const DEVICE_SET = new Set<string>(DEVICES);
const LANDSCAPE_DEVICES = new Set<Device>([
  "tvos",
  "macos",
  "windows",
  "feature-graphic",
]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/font-woff": "woff",
};
const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(
  code: MigrationIssue["code"],
  path: string,
  message: string,
): MigrationIssue {
  return { code, path, message };
}

function hasLocalizedText(raw: JsonRecord): boolean {
  if (!isRecord(raw.slidesByDevice)) return false;
  for (const slides of Object.values(raw.slidesByDevice)) {
    if (!Array.isArray(slides)) continue;
    for (const slide of slides) {
      if (!isRecord(slide)) continue;
      if (isRecord(slide.label) || isRecord(slide.headline)) return true;
    }
  }
  return false;
}

export function detectProjectContent(raw: unknown): ProjectContentDetection {
  if (!isRecord(raw)) {
    return {
      kind: "invalid",
      issues: [issue("invalid_project", "$", "Expected a project object")],
    };
  }

  if (Number.isInteger(raw.schemaVersion) && Number(raw.schemaVersion) > 3) {
    return {
      kind: "unsupported",
      version: Number(raw.schemaVersion),
      readOnly: true,
    };
  }
  if (raw.schemaVersion === 3) return { kind: "current", version: 3 };
  if (!isRecord(raw.slidesByDevice)) {
    return {
      kind: "invalid",
      issues: [
        issue(
          "invalid_project",
          "slidesByDevice",
          "Legacy projects require a slidesByDevice record",
        ),
      ],
    };
  }

  const contentVersion: LegacyProjectVersion =
    typeof raw.connectedCanvas === "boolean" || raw.schemaVersion === 2
      ? 2
      : Array.isArray(raw.locales) || hasLocalizedText(raw)
        ? 1
        : 0;
  const warnings: MigrationIssue[] = [];
  if (
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== contentVersion
  ) {
    warnings.push(
      issue(
        "schema_marker_mismatch",
        "schemaVersion",
        `Declared schema ${String(raw.schemaVersion)} uses legacy v${contentVersion} content semantics`,
      ),
    );
  }
  return { kind: "legacy", version: contentVersion, warnings };
}

function normalizedLocales(raw: JsonRecord, warnings: MigrationIssue[]): string[] {
  const candidates = Array.isArray(raw.locales)
    ? raw.locales
    : isNonEmptyString(raw.locale)
      ? [raw.locale]
      : ["en"];
  const locales: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isNonEmptyString(candidate)) continue;
    const locale = candidate.trim().normalize("NFC");
    const key = locale.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    locales.push(locale);
  }
  if (locales.length === 0) {
    warnings.push(issue("defaulted_value", "locales", "No usable locale; defaulted to en"));
    return ["en"];
  }
  return locales;
}

function deterministicSuffix(sourceSha256: string, logicalPath: string): string {
  return createHash("sha256")
    .update(sourceSha256)
    .update("\u0000")
    .update(logicalPath)
    .digest("hex");
}

function deterministicProjectId(sourceSha256: string): ProjectId {
  return `prj_${deterministicSuffix(sourceSha256, "project")}` as ProjectId;
}

function deterministicAppId(sourceSha256: string): AppId {
  return `app_${deterministicSuffix(sourceSha256, "app/0")}` as AppId;
}

function deterministicVersionId(sourceSha256: string): VersionId {
  return `ver_${deterministicSuffix(sourceSha256, "app/0/version/0")}` as VersionId;
}

function deterministicDeckId(
  sourceSha256: string,
  device: Device,
  orientation: Orientation,
  locale: string,
): DeckId {
  return `deck_${deterministicSuffix(
    sourceSha256,
    `device/${device}/orientation/${orientation}/locale/${locale}`,
  )}` as DeckId;
}

function asLocalized(value: unknown): LocalizedText {
  if (typeof value === "string") return { en: value };
  if (!isRecord(value)) return {};
  const localized: LocalizedText = {};
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text === "string") localized[locale] = text;
  }
  return localized;
}

function materializedText(value: unknown, locale: string): LocalizedText {
  const text = pickText(asLocalized(value), locale);
  return text.length === 0 ? {} : { [locale]: text };
}

function materializeImageElement(
  value: unknown,
  locale: string,
): ImageElement | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.src !== "string") {
    return undefined;
  }
  return {
    ...(structuredClone(value) as unknown as ImageElement),
    src: resolveScreenshot(value.src, locale),
  };
}

function materializeTextElement(
  value: unknown,
  locale: string,
): TextElement | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return undefined;
  return {
    ...(structuredClone(value) as unknown as TextElement),
    text: materializedText(value.text, locale),
  };
}

function materializeSlide(
  value: unknown,
  locale: string,
  sourceSha256: string,
  logicalPath: string,
  seenIds: Set<string>,
  warnings: MigrationIssue[],
): Slide {
  const raw = isRecord(value) ? value : {};
  let id = isNonEmptyString(raw.id) ? raw.id : "";
  if (id.length === 0 || seenIds.has(id)) {
    id = `slide_${deterministicSuffix(sourceSha256, logicalPath)}`;
    warnings.push(
      issue(
        "generated_slide_id",
        `${logicalPath}.id`,
        "Generated a deterministic ID for a missing or duplicate slide ID",
      ),
    );
  }
  seenIds.add(id);

  const slide = structuredClone(raw) as unknown as Slide;
  slide.id = id;
  slide.layout = slide.layout ?? "hero";
  slide.label = materializedText(raw.label, locale);
  slide.headline = materializedText(raw.headline, locale);
  slide.screenshot = resolveScreenshot(
    typeof raw.screenshot === "string" ? raw.screenshot : "",
    locale,
  );
  if (typeof raw.screenshotSecondary === "string") {
    slide.screenshotSecondary = resolveScreenshot(raw.screenshotSecondary, locale);
  }
  if (Array.isArray(raw.textElements)) {
    slide.textElements = raw.textElements
      .map((element) => materializeTextElement(element, locale))
      .filter((element): element is TextElement => element !== undefined);
  }
  if (Array.isArray(raw.imageElements)) {
    slide.imageElements = raw.imageElements
      .map((element) => materializeImageElement(element, locale))
      .filter((element): element is ImageElement => element !== undefined);
  }
  return slide;
}

function orientationsFor(raw: JsonRecord, device: Device): Orientation[] {
  if (LANDSCAPE_DEVICES.has(device)) return ["landscape"];
  if (
    (device === "android-7" || device === "android-10") &&
    raw.device === device &&
    raw.orientation === "landscape"
  ) {
    return ["portrait", "landscape"];
  }
  return ["portrait"];
}

function validImportedFont(value: unknown): ImportedFont | undefined {
  if (!isRecord(value) || typeof value.src !== "string") return undefined;
  if (
    value.format !== "woff2" &&
    value.format !== "woff" &&
    value.format !== "truetype" &&
    value.format !== "opentype"
  ) {
    return undefined;
  }
  return { src: value.src, format: value.format };
}

function candidateAssets(document: ProjectDocumentV3): LegacyAssetCandidate[] {
  const candidates: LegacyAssetCandidate[] = [];
  const add = (kind: AssetKind, path: string, source: unknown) => {
    if (typeof source === "string" && source.length > 0) {
      candidates.push({ kind, path, source });
    }
  };

  for (const appId of document.appOrder) {
    const app = document.appsById[appId];
    for (const versionId of app.versionOrder) {
      const version = app.versionsById[versionId];
      for (const deckId of version.deckOrder) {
        const deck = version.decksById[deckId];
        const base = `appsById.${appId}.versionsById.${versionId}.decksById.${deckId}`;
        add("app-icon", `${base}.appIcon`, deck.appIcon);
        add("font", `${base}.importedFont.src`, deck.importedFont?.src);
        deck.crossScreenMockups?.forEach((source, index) =>
          add("image", `${base}.crossScreenMockups.${index}`, source),
        );
        deck.slides.forEach((slide, slideIndex) => {
          const slidePath = `${base}.slides.${slideIndex}`;
          add("screenshot", `${slidePath}.screenshot`, slide.screenshot);
          add(
            "screenshot",
            `${slidePath}.screenshotSecondary`,
            slide.screenshotSecondary,
          );
          slide.imageElements?.forEach((element, elementIndex) =>
            add("image", `${slidePath}.imageElements.${elementIndex}.src`, element.src),
          );
        });
      }
    }
  }
  return candidates;
}

function validateContext(context: LegacyMigrationContext): void {
  if (!SHA256_PATTERN.test(context.sourceSha256)) {
    throw new TypeError("sourceSha256 must be a lowercase SHA-256 digest");
  }
  if (
    context.sourceFile !== "vibescreens.json" &&
    context.sourceFile !== "app-store-screenshots.json"
  ) {
    throw new TypeError("Unsupported legacy source filename");
  }
  if (!isNonEmptyString(context.backupPath)) {
    throw new TypeError("backupPath is required");
  }
  if (!isNonEmptyString(context.migratedAt) || !Number.isFinite(Date.parse(context.migratedAt))) {
    throw new TypeError("migratedAt must be a valid timestamp");
  }
}

export function migrateProject(
  raw: unknown,
  context: LegacyMigrationContext,
): ProjectMigrationResult {
  const detection = detectProjectContent(raw);
  if (detection.kind === "unsupported") {
    return {
      status: "unsupported",
      schemaVersion: detection.version,
      readOnly: true,
    };
  }
  if (detection.kind === "invalid") {
    return { status: "blocked", warnings: [], blockers: detection.issues };
  }
  if (detection.kind === "current") {
    return { status: "current", document: normalizeProjectDocument(raw) };
  }

  validateContext(context);
  const legacy = raw as JsonRecord;
  const warnings = [...detection.warnings];
  const locales = normalizedLocales(legacy, warnings);
  const projectName =
    context.projectName?.trim() ||
    (isNonEmptyString(legacy.appName) ? legacy.appName.trim() : "Imported Project");
  const appId = deterministicAppId(context.sourceSha256);
  const versionId = deterministicVersionId(context.sourceSha256);
  const deckOrder: DeckId[] = [];
  const decksById = {} as Record<DeckId, DeckRecord>;
  const slidesByDevice = legacy.slidesByDevice as JsonRecord;
  const crossScreenMockups = isRecord(legacy.crossScreenMockupsByDevice)
    ? legacy.crossScreenMockupsByDevice
    : {};

  for (const [deviceValue, rawSlides] of Object.entries(slidesByDevice)) {
    if (!DEVICE_SET.has(deviceValue) || !Array.isArray(rawSlides)) continue;
    const device = deviceValue as Device;
    for (const orientation of orientationsFor(legacy, device)) {
      for (const locale of locales) {
        const deckId = deterministicDeckId(
          context.sourceSha256,
          device,
          orientation,
          locale,
        );
        const seenSlideIds = new Set<string>();
        const slides = rawSlides.map((slide, index) =>
          materializeSlide(
            slide,
            locale,
            context.sourceSha256,
            `slidesByDevice.${device}.${index}`,
            seenSlideIds,
            warnings,
          ),
        );
        const mockups = Array.isArray(crossScreenMockups[device])
          ? (crossScreenMockups[device] as unknown[]).filter(
              (source): source is string => typeof source === "string" && source.length > 0,
            )
          : undefined;
        decksById[deckId] = {
          id: deckId,
          device,
          orientation,
          locale,
          connectedCanvas:
            detection.version === 2 && typeof legacy.connectedCanvas === "boolean"
              ? legacy.connectedCanvas
              : false,
          appName: projectName,
          themeId: isNonEmptyString(legacy.themeId) ? legacy.themeId : "clean-light",
          fontId: isNonEmptyString(legacy.fontId) ? legacy.fontId : "system-sans",
          importedFont: validImportedFont(legacy.importedFont),
          appIcon: typeof legacy.appIcon === "string" ? legacy.appIcon : "",
          ...(mockups === undefined ? {} : { crossScreenMockups: structuredClone(mockups) }),
          slides,
        };
        deckOrder.push(deckId);
      }
    }
  }

  if (deckOrder.length === 0) {
    const blocker = issue(
      "invalid_project",
      "slidesByDevice",
      "No supported device deck could be migrated",
    );
    return {
      status: "blocked",
      sourceVersion: detection.version,
      warnings,
      blockers: [blocker],
    };
  }

  const activeLocale = isNonEmptyString(legacy.locale)
    ? legacy.locale.trim().normalize("NFC")
    : locales[0];
  const selectedDeckId =
    deckOrder.find((deckId) => {
      const deck = decksById[deckId];
      return (
        deck.device === legacy.device &&
        deck.locale === activeLocale &&
        (legacy.orientation !== "landscape" || deck.orientation === "landscape")
      );
    }) ?? deckOrder[0];
  const selectedDeck = decksById[selectedDeckId];
  const timestamp = context.migratedAt;
  const version: VersionRecord = {
    id: versionId,
    name: "Imported v2",
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    deckOrder,
    decksById,
  };
  const app: AppRecord = {
    id: appId,
    name: projectName,
    createdAt: timestamp,
    updatedAt: timestamp,
    versionOrder: [versionId],
    versionsById: { [versionId]: version } as Record<VersionId, VersionRecord>,
  };
  const document = normalizeProjectDocument({
    schemaVersion: 3,
    projectId: deterministicProjectId(context.sourceSha256),
    name: projectName,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    appOrder: [appId],
    appsById: { [appId]: app },
    assetsById: {},
    selection: {
      appId,
      versionId,
      deckId: selectedDeckId,
      ...(selectedDeck.slides[0]?.id === undefined
        ? {}
        : { slideId: selectedDeck.slides[0].id }),
    },
    migration: {
      from: detection.version,
      migratedAt: timestamp,
      backupPath: context.backupPath,
      warnings: warnings.map((warning) => warning.message),
      sourceFile: context.sourceFile,
      sourceSha256: context.sourceSha256,
    },
  });

  return {
    status: "migrated",
    sourceVersion: detection.version,
    document,
    warnings,
    assets: candidateAssets(document),
  };
}

function isScopedAsset(source: string): boolean {
  return source.startsWith("/vibescreens-assets/");
}

function localAssetPath(rootDirectory: string, source: string): string | undefined {
  const withoutQuery = source.split(/[?#]/, 1)[0];
  if (withoutQuery.includes("\\")) return undefined;
  const publicRoot = resolve(rootDirectory, "public");
  const relativeSource = withoutQuery.startsWith("/")
    ? withoutQuery.slice(1)
    : withoutQuery;
  if (relativeSource.length === 0 || isAbsolute(relativeSource)) return undefined;
  const absolute = resolve(publicRoot, relativeSource);
  const pathFromRoot = relative(publicRoot, absolute);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    return undefined;
  }
  return absolute;
}

async function readLocalAsset(
  rootDirectory: string,
  sourcePath: string,
  byteLimit: number,
): Promise<Uint8Array | undefined> {
  const publicRoot = resolve(rootDirectory, "public");
  let component = publicRoot;
  for (const segment of ["", ...relative(publicRoot, sourcePath).split(sep)]) {
    component = join(component, segment);
    if ((await lstat(component)).isSymbolicLink()) return undefined;
  }
  const realPublicRoot = await realpath(publicRoot);
  const realSourcePath = await realpath(sourcePath);
  const pathFromRoot = relative(realPublicRoot, realSourcePath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    return undefined;
  }
  const handle = await open(realSourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > byteLimit) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseDataUrl(source: string): { bytes: Uint8Array; extension: string } | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(source);
  if (match === null) return undefined;
  const extension = MIME_EXTENSIONS[match[1].toLocaleLowerCase("en-US")];
  if (extension === undefined) return undefined;
  try {
    const bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { bytes, extension };
  } catch {
    return undefined;
  }
}

function normalizedExtension(source: string, kind: AssetKind): string | undefined {
  const extension = extname(source.split(/[?#]/, 1)[0]).slice(1).toLocaleLowerCase("en-US");
  if (/^[a-z0-9]{1,10}$/.test(extension)) return extension;
  if (kind === "font") return undefined;
  return undefined;
}

function warningMessage(warning: AssetMigrationWarning): string {
  return `${warning.code}: ${warning.path} (${warning.source})`;
}

function uniqueWarnings(
  warnings: Array<MigrationIssue | AssetMigrationWarning>,
): Array<MigrationIssue | AssetMigrationWarning> {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}\u0000${warning.path}\u0000${"source" in warning ? warning.source : ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function materializeLegacyAssets(
  migration: Omit<
    Extract<ProjectMigrationResult, { status: "migrated" }>,
    "warnings"
  > & { warnings: Array<MigrationIssue | AssetMigrationWarning> },
  options: MaterializeLegacyAssetsOptions = {},
): Promise<MaterializedProjectMigration> {
  const document = structuredClone(migration.document);
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const persist = options.store ?? storeAsset;
  const appId = document.appOrder[0];
  const app = document.appsById[appId];
  const versionId = app.versionOrder[0];
  const warnings: Array<MigrationIssue | AssetMigrationWarning> = [
    ...migration.warnings,
  ];
  const preparedBySource = new Map<string, StoreAssetInput>();
  const storedBySource = new Map<string, StoredAsset>();

  const prepareAsset = async (
    source: string,
    kind: AssetKind,
    path: string,
  ): Promise<string> => {
    if (source.length === 0 || isScopedAsset(source)) return source;
    const memoKey = `${kind}\u0000${source}`;
    if (preparedBySource.has(memoKey)) return source;

    if (/^(?:https?:|blob:)/i.test(source)) {
      warnings.push({
        code: "external_asset",
        path,
        source,
        message: `External asset remains recoverable at ${source}`,
      });
      return source;
    }

    const byteLimit = kind === "font" ? MAX_FONT_ASSET_BYTES : MAX_IMAGE_ASSET_BYTES;
    let bytes: Uint8Array;
    let extension: string | undefined;
    if (source.startsWith("data:")) {
      const parsed = parseDataUrl(source);
      if (parsed === undefined) {
        warnings.push({
          code: "invalid_asset",
          path,
          source,
          message: `Unsupported data URL remains unchanged at ${path}`,
        });
        return source;
      }
      bytes = parsed.bytes;
      extension = parsed.extension;
    } else {
      const sourcePath = localAssetPath(rootDirectory, source);
      extension = normalizedExtension(source, kind);
      if (sourcePath === undefined || extension === undefined) {
        warnings.push({
          code: "invalid_asset",
          path,
          source,
          message: `Unsafe or extensionless asset remains unchanged at ${path}: ${source}`,
        });
        return source;
      }
      try {
        const localBytes = await readLocalAsset(rootDirectory, sourcePath, byteLimit);
        if (localBytes === undefined) {
          warnings.push({
            code: "invalid_asset",
            path,
            source,
            message: `Unsafe or oversized asset remains unchanged at ${path}: ${source}`,
          });
          return source;
        }
        bytes = localBytes;
      } catch (error) {
        if (
          isRecord(error) &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          warnings.push({
            code: "missing_asset",
            path,
            source,
            message: `Missing asset remains recoverable at ${source}`,
          });
          return source;
        }
        throw error;
      }
    }

    const mime = source.startsWith("data:")
      ? /^data:([^;,]+)/i.exec(source)?.[1].toLocaleLowerCase("en-US")
      : EXTENSION_MIMES[extension];
    if (mime === undefined) {
      warnings.push({
        code: "invalid_asset",
        path,
        source,
        message: `Unsupported asset MIME remains unchanged at ${path}: ${source}`,
      });
      return source;
    }
    const validContent = kind === "font"
      ? hasValidFontSignature(bytes, extension as SupportedFontExtension)
      : sniffImageType(Buffer.from(bytes)) === mime;
    if (bytes.byteLength === 0 || bytes.byteLength > byteLimit || !validContent) {
      warnings.push({
        code: "invalid_asset",
        path,
        source,
        message: `Invalid or oversized asset remains unchanged at ${path}: ${source}`,
      });
      return source;
    }
    const originalName = source.startsWith("data:")
      ? `inline.${extension}`
      : basename(source.split(/[?#]/, 1)[0]);
    preparedBySource.set(memoKey, {
      rootDir: rootDirectory,
      projectId: document.projectId,
      appId,
      versionId,
      kind,
      extension,
      originalName,
      mime,
      bytes,
    });
    return source;
  };

  // Read every source first. A rejected external import must not publish a
  // valid subset of its assets, and persistence must use these validated bytes.
  for (const candidate of candidateAssets(document)) {
    await prepareAsset(candidate.source, candidate.kind, candidate.path);
  }
  if (options.requireAllAssets) {
    const assetWarnings = warnings.filter((warning) => "source" in warning);
    if (assetWarnings.length > 0) {
      throw new Error(`External import has unresolved assets: ${assetWarnings.map(({ message }) => message).join("; ")}`);
    }
  }
  for (const [memoKey, input] of preparedBySource) {
    const stored = await persist(input);
    storedBySource.set(memoKey, stored);
    document.assetsById[stored.id] = stored;
  }
  const materialize = async (source: string, kind: AssetKind, _path: string): Promise<string> =>
    storedBySource.get(`${kind}\u0000${source}`)?.url ?? source;

  for (const deckId of app.versionsById[versionId].deckOrder) {
    const deck = app.versionsById[versionId].decksById[deckId];
    const deckPath = `appsById.${appId}.versionsById.${versionId}.decksById.${deckId}`;
    deck.appIcon = await materialize(deck.appIcon, "app-icon", `${deckPath}.appIcon`);
    if (deck.importedFont !== undefined) {
      deck.importedFont.src = await materialize(
        deck.importedFont.src,
        "font",
        `${deckPath}.importedFont.src`,
      );
    }
    if (deck.crossScreenMockups !== undefined) {
      deck.crossScreenMockups = await Promise.all(
        deck.crossScreenMockups.map((source, index) =>
          materialize(source, "image", `${deckPath}.crossScreenMockups.${index}`),
        ),
      );
    }
    for (const [slideIndex, slide] of deck.slides.entries()) {
      const slidePath = `${deckPath}.slides.${slideIndex}`;
      slide.screenshot = await materialize(
        slide.screenshot,
        "screenshot",
        `${slidePath}.screenshot`,
      );
      if (slide.screenshotSecondary !== undefined) {
        slide.screenshotSecondary = await materialize(
          slide.screenshotSecondary,
          "screenshot",
          `${slidePath}.screenshotSecondary`,
        );
      }
      if (slide.imageElements !== undefined) {
        for (const [elementIndex, element] of slide.imageElements.entries()) {
          element.src = await materialize(
            element.src,
            "image",
            `${slidePath}.imageElements.${elementIndex}.src`,
          );
        }
      }
    }
  }

  const combinedWarnings = uniqueWarnings(warnings);
  if (document.migration !== undefined) {
    document.migration.warnings = combinedWarnings.map((warning) =>
      "source" in warning ? warningMessage(warning) : warning.message,
    );
  }
  const normalized = normalizeProjectDocument(document);
  return {
    ...migration,
    document: normalized,
    warnings: combinedWarnings,
    assets: candidateAssets(normalized),
  };
}
