import { storeAsset as storeManagedAsset, type StoreAssetInput } from "./asset-store";
import { assertAppId, assertVersionId, type AppId, type VersionId } from "./ids";
import {
  ProjectRevisionConflictError,
  PublishedVersionMutationError,
} from "./project-repository";
import {
  assetIdFor,
  parseManagedAssetUrl,
  type AssetKind,
  type AssetRef,
  type ProjectDocumentV3,
} from "./project-schema";
import {
  createWorkspaceProjectService,
  type WorkspaceProjectService,
} from "./server-service";
import { assertProjectId, type ProjectId } from "./workspace";

export type AssetUploadProjectService = Pick<
  WorkspaceProjectService,
  "getWorkspace" | "getProject" | "saveProject"
>;

export interface AssetUploadInput {
  projectId?: string;
  appId?: string;
  versionId?: string;
  kind: AssetKind;
  extension: string;
  originalName?: string;
  mime?: string;
  bytes: Uint8Array;
}

export interface AssetUploadResult {
  asset: AssetRef;
  project: ProjectDocumentV3;
}

export interface AssetUploadService {
  uploadAsset(input: AssetUploadInput): Promise<AssetUploadResult>;
}

export interface AssetUploadServiceOptions {
  rootDir?: string;
  projectService?: AssetUploadProjectService;
  storeAsset?: (input: StoreAssetInput) => Promise<AssetRef>;
}

const ASSET_KINDS: ReadonlySet<AssetKind> = new Set([
  "screenshot",
  "image",
  "font",
  "app-icon",
]);
const EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function assertPlainFilename(value: unknown): asserts value is string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError("Asset originalName must be a plain filename");
  }
}

function assertAssetInput(input: AssetUploadInput): void {
  if (!ASSET_KINDS.has(input.kind)) {
    throw new TypeError(`Invalid asset kind: ${String(input.kind)}`);
  }
  if (!EXTENSION_PATTERN.test(input.extension)) {
    throw new TypeError(`Invalid normalized asset extension: ${String(input.extension)}`);
  }
  assertPlainFilename(input.originalName);
  if (input.mime !== undefined && !MIME_PATTERN.test(input.mime)) {
    throw new TypeError(`Invalid asset MIME type: ${String(input.mime)}`);
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError("Asset bytes must be a Uint8Array");
  }
}

function targetAppId(document: ProjectDocumentV3, requested: string | undefined): AppId {
  const appId = requested ?? document.selection.appId;
  assertAppId(appId);
  if (document.appsById[appId] === undefined) {
    throw new TypeError(`App ${appId} does not exist in project ${document.projectId}`);
  }
  return appId;
}

function targetVersionId(
  document: ProjectDocumentV3,
  appId: AppId,
  requested: string | undefined,
): VersionId {
  const versionId = requested ?? document.selection.versionId;
  assertVersionId(versionId);
  if (document.appsById[appId].versionsById[versionId] === undefined) {
    throw new TypeError(`Version ${versionId} does not exist in app ${appId}`);
  }
  return versionId;
}

function assertStoredAssetOwnership(
  asset: AssetRef,
  projectId: ProjectId,
  appId: AppId,
  versionId: VersionId,
  kind: AssetKind,
): void {
  const parsed = parseManagedAssetUrl(asset.url);
  const expectedId = assetIdFor(versionId, kind, asset.sha256, asset.extension);
  if (
    asset.id !== expectedId ||
    asset.scope.appId !== appId ||
    asset.scope.versionId !== versionId ||
    asset.kind !== kind ||
    parsed === undefined ||
    parsed.projectId !== projectId ||
    parsed.appId !== appId ||
    parsed.versionId !== versionId ||
    parsed.kind !== kind ||
    parsed.sha256 !== asset.sha256 ||
    parsed.extension !== asset.extension
  ) {
    throw new TypeError("Stored asset does not match its requested project scope");
  }
}

function registeredAsset(saved: ProjectDocumentV3, asset: AssetRef): AssetRef {
  const registered = saved.assetsById[asset.id];
  if (
    registered === undefined ||
    registered.url !== asset.url ||
    registered.sha256 !== asset.sha256 ||
    registered.scope.appId !== asset.scope.appId ||
    registered.scope.versionId !== asset.scope.versionId ||
    registered.kind !== asset.kind
  ) {
    throw new Error("Asset persistence completed without the expected registry entry");
  }
  return registered;
}

export function createAssetUploadService(
  options: AssetUploadServiceOptions = {},
): AssetUploadService {
  const rootDir = options.rootDir ?? process.cwd();
  const projectService =
    options.projectService ?? createWorkspaceProjectService({ rootDir });
  const persistBytes = options.storeAsset ?? storeManagedAsset;

  return {
    async uploadAsset(input) {
      assertAssetInput(input);

      let projectId: ProjectId;
      if (input.projectId === undefined) {
        const { workspace } = await projectService.getWorkspace();
        if (workspace.activeProjectId === null) {
          throw new TypeError("No active project is available for this upload");
        }
        projectId = workspace.activeProjectId;
      } else {
        assertProjectId(input.projectId);
        projectId = input.projectId;
      }

      let current = await projectService.getProject(projectId);
      if (current.projectId !== projectId) {
        throw new TypeError(`Loaded project ${current.projectId} does not match ${projectId}`);
      }
      const appId = targetAppId(current, input.appId);
      const versionId = targetVersionId(current, appId, input.versionId);
      const version = current.appsById[appId].versionsById[versionId];
      if (version.status !== "draft") {
        throw new PublishedVersionMutationError(
          `Published version ${versionId} cannot receive uploaded assets`,
        );
      }

      const asset = await persistBytes({
        rootDir,
        projectId,
        appId,
        versionId,
        kind: input.kind,
        extension: input.extension,
        originalName: input.originalName,
        mime: input.mime,
        bytes: input.bytes,
      });
      assertStoredAssetOwnership(asset, projectId, appId, versionId, input.kind);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = structuredClone(current);
        candidate.assetsById[asset.id] = asset;
        try {
          const saved = await projectService.saveProject({
            projectId,
            baseRevision: current.revision,
            document: candidate,
          });
          return { asset: registeredAsset(saved, asset), project: saved };
        } catch (error) {
          if (!(error instanceof ProjectRevisionConflictError) || attempt === 2) throw error;
          current = await projectService.getProject(projectId);
          const latestAppId = targetAppId(current, appId);
          const latestVersionId = targetVersionId(current, latestAppId, versionId);
          if (latestAppId !== appId || latestVersionId !== versionId) {
            throw new TypeError("Upload target changed during concurrent registration");
          }
          if (current.appsById[appId].versionsById[versionId].status !== "draft") {
            throw new PublishedVersionMutationError(
              `Published version ${versionId} cannot receive uploaded assets`,
            );
          }
        }
      }
      throw new Error("Upload registration exhausted its retry budget");
    },
  };
}
