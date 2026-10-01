import { getExportSizes } from "./constants";
import type { AppId, DeckId, VersionId } from "./ids";
import {
  computePublishedVersionContentHash,
  validateProjectDocument,
  type AppRecord,
  type DeckRecord,
  type ProjectDocumentV3,
  type VersionRecord,
  type VersionStatus,
} from "./project-schema";
import type { Device, Orientation, Platform, SlideLayout } from "./types";

export interface ExportVersionRef {
  appId: AppId;
  versionId: VersionId;
}

interface ExportScopeBase {
  /** Limit every resolved version to these stable deck IDs. */
  deckIds?: readonly DeckId[];
}

export type ExportScope =
  | ({ kind: "current" } & ExportScopeBase)
  | ({
      kind: "selected";
      versions: readonly ExportVersionRef[];
    } & ExportScopeBase)
  | ({
      kind: "all";
      /** The all scope is published-only unless drafts are explicitly requested. */
      includeDrafts?: boolean;
    } & ExportScopeBase);

export interface BuildExportPlanOptions {
  /** Injected so tests and callers, rather than the planner, own the clock. */
  createdAt?: string;
  rendererVersion?: string;
  /**
   * Returns whether a managed asset URL exists on disk. Injected by the export
   * client (fetch HEAD) and tests; when omitted, only registry consistency is
   * validated and file existence is assumed until render time.
   */
  assetFileExists?: (url: string) => Promise<boolean>;
}

export type ExportPreflightIssueCode =
  | "content_hash_mismatch"
  | "missing_content_hash"
  | "missing_screenshot"
  | "missing_asset_file"
  | "reused_secondary_screenshot";

export interface ExportPreflightIssue {
  code: ExportPreflightIssueCode;
  severity: "error" | "warning";
  message: string;
  versionId: VersionId;
  deckId?: DeckId;
  slideId?: string;
}

export type ExportContent = "screens" | "device-frames";

export interface DeviceFrameExport {
  element: "device" | "deviceSecondary";
  src: string;
  width: number;
  height: number;
  rotation: number;
}

export interface ExportJob {
  id: string;
  appId: AppId;
  versionId: VersionId;
  deckId: DeckId;
  slideId: string;
  status: VersionStatus;
  platform: Platform;
  device: Device;
  orientation: Orientation;
  locale: string;
  width: number;
  height: number;
  sizeLabel: string;
  slideIndex: number;
  layout: SlideLayout;
  relativePath: string;
  /** Present only for an isolated, transparent marketing PNG. */
  deviceFrame?: DeviceFrameExport;
}

export interface ExportVersionMetadata {
  schemaVersion: 2;
  versionId: VersionId;
  versionName: string;
  status: VersionStatus;
  projectRevision?: number;
  publishedAt?: string;
  contentHash?: string;
  deckIds: readonly DeckId[];
  jobCount: number;
  ready: boolean;
}

export interface ExportVersionPlan {
  appId: AppId;
  versionId: VersionId;
  status: VersionStatus;
  directory: string;
  metadataPath: string;
  metadata: ExportVersionMetadata;
  deckIds: readonly DeckId[];
  jobCount: number;
  ready: boolean;
}

export interface ExportManifestVersion {
  versionId: VersionId;
  versionName: string;
  status: VersionStatus;
  projectRevision?: number;
  publishedAt?: string;
  contentHash?: string;
  directory: string;
  metadataPath: string;
  deckIds: readonly DeckId[];
  jobCount: number;
  ready: boolean;
}

export interface NormalizedExportScope {
  kind: ExportScope["kind"];
  includeDrafts?: boolean;
  versions: readonly ExportVersionRef[];
  deckIds: readonly DeckId[];
}

export interface ExportManifestScope {
  kind: ExportScope["kind"];
  includeDrafts?: boolean;
  versionIds: readonly VersionId[];
  deckIds: readonly DeckId[];
}

export interface ExportManifest {
  schemaVersion: 2;
  content?: ExportContent;
  createdAt: string;
  rendererVersion: string;
  complete: boolean;
  plannedJobCount: number;
  bundleName: string;
  project: {
    id: ProjectDocumentV3["projectId"];
    name: string;
    revision: number;
    updatedAt: string;
  };
  scope: ExportManifestScope;
  versions: readonly ExportManifestVersion[];
  jobs: readonly {
    id: string;
    versionId: VersionId;
    deckId: DeckId;
    slideId: string;
    relativePath: string;
  }[];
  preflight: {
    errors: readonly ExportPreflightIssue[];
    warnings: readonly ExportPreflightIssue[];
  };
}

export interface ExportPlan {
  snapshot: Readonly<ProjectDocumentV3>;
  scope: NormalizedExportScope;
  versions: readonly ExportVersionPlan[];
  jobs: readonly ExportJob[];
  preflight: {
    errors: readonly ExportPreflightIssue[];
    warnings: readonly ExportPreflightIssue[];
  };
  manifestPath: "manifest.json";
  manifest: ExportManifest;
}

export type ExportPlanErrorCode =
  | "invalid_document"
  | "not_found"
  | "empty_scope"
  | "path_collision";

export class ExportPlanError extends Error {
  readonly code: ExportPlanErrorCode;

  constructor(code: ExportPlanErrorCode, message: string) {
    super(message);
    this.name = "ExportPlanError";
    this.code = code;
  }
}

interface ResolvedVersion {
  app: AppRecord;
  version: VersionRecord;
  decks: DeckRecord[];
}

const DEFAULT_RENDERER_VERSION = "vibescreens-export-plan@1";

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function slugSegment(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function stableFallbackToken(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(8, "0").slice(0, 8);
}

function shortId(value: string): string {
  const withoutKnownPrefix = value.replace(/^(?:app|ver|deck|slide)[_-]/i, "");
  const token = slugSegment(withoutKnownPrefix, "");
  return (token || stableFallbackToken(value)).slice(0, 8);
}

function platformFor(device: Device): Platform {
  if (device === "macos" || device === "windows") return "desktop";
  if (
    device === "iphone" ||
    device === "ipad" ||
    device === "tvos" ||
    device === "watchos" ||
    device === "carplay"
  ) {
    return "ios";
  }
  return "android";
}

function slideNeedsScreenshot(device: Device, layout: SlideLayout): boolean {
  return (
    device !== "feature-graphic" &&
    layout !== "no-device" &&
    layout !== "feature-graphic"
  );
}

function versionKey(ref: ExportVersionRef): string {
  return `${ref.appId}\u0000${ref.versionId}`;
}

function scopeVersionRefs(
  document: ProjectDocumentV3,
  scope: ExportScope,
): ExportVersionRef[] {
  if (scope.kind === "current") {
    return [
      {
        appId: document.selection.appId,
        versionId: document.selection.versionId,
      },
    ];
  }

  const requested = new Set<string>();
  if (scope.kind === "selected") {
    if (scope.versions.length === 0) {
      throw new ExportPlanError("empty_scope", "Select at least one version to export");
    }
    for (const ref of scope.versions) {
      const app = document.appsById[ref.appId];
      if (app === undefined || app.versionsById[ref.versionId] === undefined) {
        throw new ExportPlanError(
          "not_found",
          `Version ${ref.versionId} does not exist in app ${ref.appId}`,
        );
      }
      requested.add(versionKey(ref));
    }
  }

  const refs: ExportVersionRef[] = [];
  for (const appId of document.appOrder) {
    const app = document.appsById[appId];
    for (const versionId of app.versionOrder) {
      const version = app.versionsById[versionId];
      const ref = { appId, versionId };
      if (scope.kind === "selected" && !requested.has(versionKey(ref))) continue;
      if (scope.kind === "all" && version.status === "draft" && !scope.includeDrafts) {
        continue;
      }
      refs.push(ref);
    }
  }

  if (refs.length === 0) {
    throw new ExportPlanError("empty_scope", "The export scope contains no versions");
  }
  return refs;
}

function resolveVersions(
  document: ProjectDocumentV3,
  scope: ExportScope,
): ResolvedVersion[] {
  const refs = scopeVersionRefs(document, scope);
  const requestedDecks = scope.deckIds === undefined ? undefined : new Set(scope.deckIds);
  if (requestedDecks !== undefined && requestedDecks.size === 0) {
    throw new ExportPlanError("empty_scope", "Select at least one deck to export");
  }

  const foundDecks = new Set<DeckId>();
  const versions: ResolvedVersion[] = [];
  for (const ref of refs) {
    const app = document.appsById[ref.appId];
    const version = app.versionsById[ref.versionId];
    const decks = version.deckOrder
      .filter((deckId) => requestedDecks === undefined || requestedDecks.has(deckId))
      .map((deckId) => {
        foundDecks.add(deckId);
        return version.decksById[deckId];
      });
    if (decks.length > 0) versions.push({ app, version, decks });
  }

  if (requestedDecks !== undefined) {
    for (const deckId of requestedDecks) {
      if (!foundDecks.has(deckId)) {
        throw new ExportPlanError(
          "not_found",
          `Deck ${deckId} does not exist in the selected versions`,
        );
      }
    }
  }
  if (versions.length === 0) {
    throw new ExportPlanError("empty_scope", "The export scope contains no decks");
  }
  return versions;
}

function makeIssue(
  severity: ExportPreflightIssue["severity"],
  code: ExportPreflightIssueCode,
  resolved: ResolvedVersion,
  message: string,
  deck?: DeckRecord,
  slideId?: string,
): ExportPreflightIssue {
  return {
    code,
    severity,
    message,
    versionId: resolved.version.id,
    ...(deck === undefined ? {} : { deckId: deck.id }),
    ...(slideId === undefined ? {} : { slideId }),
  };
}

/** Every managed URL a version's decks reference for rendering. */
function managedAssetUrlsForDecks(decks: readonly DeckRecord[]): string[] {
  const urls = new Set<string>();
  for (const deck of decks) {
    if (deck.appIcon.startsWith("/vibescreens-assets/")) urls.add(deck.appIcon);
    if (deck.importedFont?.src.startsWith("/vibescreens-assets/")) {
      urls.add(deck.importedFont.src);
    }
    for (const url of deck.crossScreenMockups ?? []) {
      if (url.startsWith("/vibescreens-assets/")) urls.add(url);
    }
    for (const slide of deck.slides) {
      for (const raw of [slide.screenshot, slide.screenshotSecondary]) {
        if (raw?.startsWith("/vibescreens-assets/")) urls.add(raw);
      }
      for (const image of slide.imageElements ?? []) {
        if (image.src?.startsWith("/vibescreens-assets/")) urls.add(image.src);
      }
    }
  }
  return [...urls].sort();
}

async function preflightVersion(
  document: ProjectDocumentV3,
  resolved: ResolvedVersion,
  options: BuildExportPlanOptions = {},
): Promise<ExportPreflightIssue[]> {
  const issues: ExportPreflightIssue[] = [];
  const { version } = resolved;

  if (version.status === "published") {
    if (version.contentHash === undefined) {
      issues.push(
        makeIssue(
          "error",
          "missing_content_hash",
          resolved,
          "Published version has no content hash",
        ),
      );
    } else {
      const actualHash = await computePublishedVersionContentHash(
        document,
        resolved.app.id,
        version.id,
      );
      if (actualHash !== version.contentHash) {
        issues.push(
          makeIssue(
            "error",
            "content_hash_mismatch",
            resolved,
            "Published version content no longer matches its stored hash",
          ),
        );
      }
    }
  }

  if (options.assetFileExists !== undefined) {
    const assetFileExists = options.assetFileExists;
    for (const url of managedAssetUrlsForDecks(resolved.decks)) {
      const registered = Object.values(document.assetsById).some(
        (asset) => asset.url === url,
      );
      if (!registered) {
        issues.push(
          makeIssue(
            version.status === "published" ? "error" : "warning",
            "missing_asset_file",
            resolved,
            `Managed asset ${url} is referenced but not registered`,
          ),
        );
        continue;
      }
      if (!(await assetFileExists(url))) {
        issues.push(
          makeIssue(
            "error",
            "missing_asset_file",
            resolved,
            `Managed asset file is missing for ${url}`,
          ),
        );
      }
    }
  }

  for (const deck of resolved.decks) {
    for (const slide of deck.slides) {
      if (slideNeedsScreenshot(deck.device, slide.layout) && !slide.screenshot) {
        issues.push(
          makeIssue(
            version.status === "published" ? "error" : "warning",
            "missing_screenshot",
            resolved,
            version.status === "published"
              ? "Published slide is missing its primary screenshot"
              : "Draft slide will render with an empty device placeholder",
            deck,
            slide.id,
          ),
        );
      }
      if (
        deck.device !== "feature-graphic" &&
        slide.layout === "two-devices" &&
        slide.screenshot &&
        !slide.screenshotSecondary
      ) {
        issues.push(
          makeIssue(
            "warning",
            "reused_secondary_screenshot",
            resolved,
            "Two-device slide will reuse its primary screenshot in back",
            deck,
            slide.id,
          ),
        );
      }
    }
  }
  return issues;
}

function versionDirectory(version: VersionRecord): string {
  return [
    "versions",
    `${slugSegment(version.name, "version")}--${shortId(version.id)}`,
  ].join("/");
}

/** Build jobs for an already-resolved scope; callers own preflight gating. */
export function createVersionExportJobs(
  resolved: ResolvedVersion,
  directory: string,
): ExportJob[] {
  const jobs: ExportJob[] = [];
  for (const deck of resolved.decks) {
    const platform = platformFor(deck.device);
    for (const size of getExportSizes(deck.device, deck.orientation)) {
      for (const [slideIndex, slide] of deck.slides.entries()) {
        const filename = `${String(slideIndex + 1).padStart(2, "0")}-${shortId(
          slide.id,
        )}-${slugSegment(slide.layout, "slide")}.png`;
        const relativePath = [
          directory,
          resolved.version.status,
          platform,
          deck.device,
          deck.orientation,
          slugSegment(deck.locale, "locale"),
          `${size.w}x${size.h}`,
          filename,
        ].join("/");
        jobs.push({
          id: relativePath,
          appId: resolved.app.id,
          versionId: resolved.version.id,
          deckId: deck.id,
          slideId: slide.id,
          status: resolved.version.status,
          platform,
          device: deck.device,
          orientation: deck.orientation,
          locale: deck.locale,
          width: size.w,
          height: size.h,
          sizeLabel: size.label,
          slideIndex,
          layout: slide.layout,
          relativePath,
        });
      }
    }
  }
  return jobs;
}

function assertUniquePath(path: string, paths: Set<string>): void {
  if (paths.has(path)) {
    throw new ExportPlanError(
      "path_collision",
      `Multiple export entries resolve to ${path}`,
    );
  }
  paths.add(path);
}

function compactUtc(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return "undated";
  return parsed
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-");
}

function normalizedScope(
  scope: ExportScope,
  resolved: readonly ResolvedVersion[],
): NormalizedExportScope {
  return {
    kind: scope.kind,
    ...(scope.kind === "all" ? { includeDrafts: scope.includeDrafts === true } : {}),
    versions: resolved.map(({ app, version }) => ({
      appId: app.id,
      versionId: version.id,
    })),
    deckIds: scope.deckIds === undefined ? [] : [...new Set(scope.deckIds)],
  };
}

function manifestScope(scope: NormalizedExportScope): ExportManifestScope {
  return {
    kind: scope.kind,
    ...(scope.includeDrafts === undefined ? {} : { includeDrafts: scope.includeDrafts }),
    versionIds: scope.versions.map(({ versionId }) => versionId),
    deckIds: scope.deckIds,
  };
}

export async function buildExportPlan(
  document: ProjectDocumentV3,
  scope: ExportScope,
  options: BuildExportPlanOptions = {},
): Promise<ExportPlan> {
  const validation = validateProjectDocument(document);
  if (!validation.ok) {
    throw new ExportPlanError(
      "invalid_document",
      `Cannot plan an invalid project: ${validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  // Never freeze or retain the caller's live editor state. Every lookup and hash below
  // uses this isolated snapshot, so later UI switches cannot change an in-flight plan.
  const snapshot = deepFreeze(structuredClone(document));
  const resolved = resolveVersions(snapshot, scope);
  const errors: ExportPreflightIssue[] = [];
  const warnings: ExportPreflightIssue[] = [];
  const issuesByVersion = new Map<string, ExportPreflightIssue[]>();

  for (const version of resolved) {
    const issues = await preflightVersion(snapshot, version, options);
    issuesByVersion.set(
      versionKey({ appId: version.app.id, versionId: version.version.id }),
      issues,
    );
    for (const issue of issues) {
      (issue.severity === "error" ? errors : warnings).push(issue);
    }
  }

  const paths = new Set<string>();
  const jobs: ExportJob[] = [];
  const versions: ExportVersionPlan[] = [];
  for (const item of resolved) {
    const directory = versionDirectory(item.version);
    const metadataPath = `${directory}/version.json`;
    assertUniquePath(metadataPath, paths);
    const issues =
      issuesByVersion.get(
        versionKey({ appId: item.app.id, versionId: item.version.id }),
      ) ?? [];
    const ready = !issues.some((issue) => issue.severity === "error");
    const versionJobs = ready ? createVersionExportJobs(item, directory) : [];
    for (const job of versionJobs) {
      assertUniquePath(job.relativePath, paths);
      jobs.push(job);
    }

    const metadata: ExportVersionMetadata = {
      schemaVersion: 2,
      versionId: item.version.id,
      versionName: item.version.name,
      status: item.version.status,
      ...(item.version.status === "draft"
        ? { projectRevision: snapshot.revision }
        : {}),
      ...(item.version.publishedAt === undefined
        ? {}
        : { publishedAt: item.version.publishedAt }),
      ...(item.version.contentHash === undefined
        ? {}
        : { contentHash: item.version.contentHash }),
      deckIds: item.decks.map((deck) => deck.id),
      jobCount: versionJobs.length,
      ready,
    };
    versions.push({
      appId: item.app.id,
      versionId: item.version.id,
      status: item.version.status,
      directory,
      metadataPath,
      metadata,
      deckIds: metadata.deckIds,
      jobCount: versionJobs.length,
      ready,
    });
  }

  const versionIds = versions.map((version) => version.versionId);
  if (new Set(versionIds).size !== versionIds.length) {
    throw new ExportPlanError(
      "invalid_document",
      "Version IDs must be unique across a Project before export",
    );
  }
  const normalized = normalizedScope(scope, resolved);
  const createdAt = options.createdAt ?? snapshot.updatedAt;
  const rendererVersion = options.rendererVersion ?? DEFAULT_RENDERER_VERSION;
  const scopeLabel =
    scope.kind === "all" && scope.includeDrafts ? "all-with-drafts" : scope.kind;
  const manifestVersions: ExportManifestVersion[] = versions.map((versionPlan) => ({
    versionId: versionPlan.metadata.versionId,
    versionName: versionPlan.metadata.versionName,
    status: versionPlan.metadata.status,
    ...(versionPlan.metadata.projectRevision === undefined
      ? {}
      : { projectRevision: versionPlan.metadata.projectRevision }),
    ...(versionPlan.metadata.publishedAt === undefined
      ? {}
      : { publishedAt: versionPlan.metadata.publishedAt }),
    ...(versionPlan.metadata.contentHash === undefined
      ? {}
      : { contentHash: versionPlan.metadata.contentHash }),
    directory: versionPlan.directory,
    metadataPath: versionPlan.metadataPath,
    deckIds: versionPlan.deckIds,
    jobCount: versionPlan.jobCount,
    ready: versionPlan.ready,
  }));
  const preflight = { errors, warnings };
  const manifest: ExportManifest = {
    schemaVersion: 2,
    createdAt,
    rendererVersion,
    complete: errors.length === 0,
    plannedJobCount: jobs.length,
    bundleName: `vibescreens-${scopeLabel}-${compactUtc(createdAt)}.zip`,
    project: {
      id: snapshot.projectId,
      name: snapshot.name,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
    },
    scope: manifestScope(normalized),
    versions: manifestVersions,
    jobs: jobs.map((job) => ({
      id: job.id,
      versionId: job.versionId,
      deckId: job.deckId,
      slideId: job.slideId,
      relativePath: job.relativePath,
    })),
    preflight,
  };

  return deepFreeze({
    snapshot,
    scope: normalized,
    versions,
    jobs,
    preflight,
    manifestPath: "manifest.json" as const,
    manifest,
  });
}
