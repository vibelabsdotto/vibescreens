import { createHash, randomUUID } from "node:crypto";
import {
  access as accessFile,
  copyFile,
  cp as copyDirectory,
  mkdir as makeDirectory,
  open as openFile,
  readFile,
  rename as renameFile,
  rm as removeDirectory,
  unlink as unlinkFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import {
  assertAppId,
  assertVersionId,
  type AssetId,
  type AppId,
  type VersionId,
} from "./ids";
import {
  assetIdFor,
  assetKindDirectory,
  managedAssetUrl,
  parseManagedAssetUrl,
  type AssetKind,
  type AssetRef,
} from "./project-schema";
import { assertProjectId, type ProjectId } from "./workspace";

export type { AssetKind } from "./project-schema";

export interface StoreAssetInput {
  rootDir?: string;
  projectId: ProjectId;
  appId: AppId;
  versionId: VersionId;
  kind: AssetKind;
  extension: string;
  originalName?: string;
  mime?: string;
  bytes: Uint8Array;
}

export interface CloneVersionAssetsInput {
  rootDir?: string;
  projectId: ProjectId;
  appId: AppId;
  sourceVersionId: VersionId;
  targetVersionId: VersionId;
  assets?: readonly AssetRef[];
}

export type StoredAsset = AssetRef;

export interface CloneVersionAssetsResult {
  assetsById: Record<AssetId, AssetRef>;
  urlMap: Record<string, string>;
}

export interface AssetStoreFileHandle {
  writeFile(contents: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AssetStoreFileSystem {
  access(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  open(path: string): Promise<AssetStoreFileHandle>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: AssetStoreFileSystem = {
  access: accessFile,
  mkdir: async (path) => {
    await makeDirectory(path, { recursive: true });
  },
  open: async (path) => {
    const handle = await openFile(path, "wx", 0o600);
    return {
      writeFile: async (contents) => {
        await handle.writeFile(contents);
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: renameFile,
  unlink: unlinkFile,
};

const ASSET_KINDS = new Set<AssetKind>([
  "screenshot",
  "image",
  "font",
  "app-icon",
]);
const NORMALIZED_EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

function assertAssetKind(value: unknown): asserts value is AssetKind {
  if (!ASSET_KINDS.has(value as AssetKind)) {
    throw new TypeError(`Invalid asset kind: ${String(value)}`);
  }
}

function assertNormalizedExtension(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NORMALIZED_EXTENSION_PATTERN.test(value)) {
    throw new TypeError(`Invalid normalized asset extension: ${String(value)}`);
  }
}

function normalizedOriginalName(value: string | undefined, extension: string): string {
  const name = value ?? `asset.${extension}`;
  if (name.length === 0 || name.includes("/") || name.includes("\\")) {
    throw new TypeError("Asset originalName must be a plain filename");
  }
  return name.normalize("NFC");
}

function normalizedMime(value: string | undefined, extension: string): string {
  const mime = (value ?? EXTENSION_MIMES[extension] ?? "application/octet-stream").toLocaleLowerCase(
    "en-US",
  );
  if (!MIME_PATTERN.test(mime)) throw new TypeError(`Invalid asset MIME type: ${mime}`);
  return mime;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const targetWriteTails = new Map<string, Promise<void>>();

async function withTargetWriteLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = targetWriteTails.get(targetPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  targetWriteTails.set(targetPath, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (targetWriteTails.get(targetPath) === tail) {
      targetWriteTails.delete(targetPath);
    }
  }
}

export async function storeAsset(
  input: StoreAssetInput,
  fileSystem: AssetStoreFileSystem = nodeFileSystem,
): Promise<StoredAsset> {
  assertProjectId(input.projectId);
  assertAppId(input.appId);
  assertVersionId(input.versionId);
  assertAssetKind(input.kind);
  assertNormalizedExtension(input.extension);
  const originalName = normalizedOriginalName(input.originalName, input.extension);
  const mime = normalizedMime(input.mime, input.extension);

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const kindDirectory = assetKindDirectory(input.kind);
  const directory = join(
    input.rootDir ?? process.cwd(),
    "public",
    "vibescreens-assets",
    input.projectId,
    input.appId,
    input.versionId,
    kindDirectory,
  );
  const filename = `${sha256}.${input.extension}`;
  const targetPath = join(directory, filename);

  await withTargetWriteLock(targetPath, async () => {
    await fileSystem.mkdir(directory);
    try {
      await fileSystem.access(targetPath);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;

      const temporaryPath = join(
        directory,
        `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      let temporaryFileCreated = false;
      try {
        const handle = await fileSystem.open(temporaryPath);
        temporaryFileCreated = true;
        try {
          await handle.writeFile(input.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fileSystem.rename(temporaryPath, targetPath);
      } catch (writeError) {
        if (temporaryFileCreated) {
          try {
            await fileSystem.unlink(temporaryPath);
          } catch (cleanupError) {
            if (!isNotFoundError(cleanupError)) {
              throw new AggregateError(
                [writeError, cleanupError],
                "Asset write failed and its temporary file could not be removed",
              );
            }
          }
        }
        throw writeError;
      }
    }
  });

  const url = managedAssetUrl({
    projectId: input.projectId,
    appId: input.appId,
    versionId: input.versionId,
    kind: input.kind,
    sha256,
    extension: input.extension,
  });
  return {
    id: assetIdFor(input.versionId, input.kind, sha256, input.extension),
    scope: { appId: input.appId, versionId: input.versionId },
    kind: input.kind,
    originalName,
    mime,
    bytes: input.bytes.byteLength,
    sha256,
    extension: input.extension,
    url,
  };
}

function cloneRef(
  projectId: ProjectId,
  appId: AppId,
  targetVersionId: VersionId,
  asset: AssetRef,
): AssetRef {
  const url = managedAssetUrl({
    projectId,
    appId,
    versionId: targetVersionId,
    kind: asset.kind,
    sha256: asset.sha256,
    extension: asset.extension,
  });
  return {
    ...structuredClone(asset),
    id: assetIdFor(targetVersionId, asset.kind, asset.sha256, asset.extension),
    scope: { appId, versionId: targetVersionId },
    url,
  };
}

function assertSourceAsset(
  projectId: ProjectId,
  appId: AppId,
  sourceVersionId: VersionId,
  asset: AssetRef,
): void {
  const parsed = parseManagedAssetUrl(asset.url);
  if (
    asset.scope.appId !== appId ||
    asset.scope.versionId !== sourceVersionId ||
    parsed === undefined ||
    parsed.projectId !== projectId ||
    parsed.appId !== appId ||
    parsed.versionId !== sourceVersionId ||
    parsed.kind !== asset.kind ||
    parsed.sha256 !== asset.sha256 ||
    parsed.extension !== asset.extension
  ) {
    throw new TypeError(`Asset ${asset.id} is not owned by the source version`);
  }
}

async function readVerifiedAssetBytes(
  path: string,
  asset: AssetRef,
  location: "source" | "target",
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (location === "target" && isNotFoundError(error)) {
      throw new Error(`Asset ${asset.id} target mismatch; expected file is missing`);
    }
    throw error;
  }
  if (bytes.byteLength !== asset.bytes) {
    throw new Error(
      `Asset ${asset.id} ${location} size mismatch; ${location} is corrupt`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(
      `Asset ${asset.id} ${location} hash mismatch; ${location} is corrupt`,
    );
  }
  return bytes;
}

export async function cloneVersionAssets(
  input: CloneVersionAssetsInput,
): Promise<CloneVersionAssetsResult | undefined> {
  assertProjectId(input.projectId);
  assertAppId(input.appId);
  assertVersionId(input.sourceVersionId);
  assertVersionId(input.targetVersionId);
  if (input.sourceVersionId === input.targetVersionId) {
    throw new TypeError("Source and target version IDs must differ");
  }

  const rootDir = input.rootDir ?? process.cwd();
  const appAssetDirectory = join(
    rootDir,
    "public",
    "vibescreens-assets",
    input.projectId,
    input.appId,
  );
  const sourceDirectory = join(appAssetDirectory, input.sourceVersionId);
  const targetDirectory = join(appAssetDirectory, input.targetVersionId);

  return withTargetWriteLock(targetDirectory, async () => {
    let targetExists = false;
    try {
      await accessFile(targetDirectory);
      targetExists = true;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    if (targetExists) {
      if (input.assets === undefined) {
        throw new Error(`Target asset directory already exists for ${input.targetVersionId}`);
      }
      const assetsById = {} as Record<AssetId, AssetRef>;
      const urlMap: Record<string, string> = {};
      for (const asset of input.assets) {
        assertSourceAsset(input.projectId, input.appId, input.sourceVersionId, asset);
        const sourcePath = join(rootDir, "public", asset.url.slice(1));
        await readVerifiedAssetBytes(sourcePath, asset, "source");
        const cloned = cloneRef(input.projectId, input.appId, input.targetVersionId, asset);
        const targetPath = join(rootDir, "public", cloned.url.slice(1));
        await readVerifiedAssetBytes(targetPath, cloned, "target");
        assetsById[cloned.id] = cloned;
        urlMap[asset.url] = cloned.url;
      }
      return { assetsById, urlMap };
    }

    try {
      await accessFile(sourceDirectory);
    } catch (error) {
      if (isNotFoundError(error) && (input.assets?.length ?? 0) === 0) return undefined;
      throw error;
    }

    const stagingDirectory = join(
      appAssetDirectory,
      `.${input.targetVersionId}.${process.pid}.${randomUUID()}.tmp`,
    );
    const assetsById = {} as Record<AssetId, AssetRef>;
    const urlMap: Record<string, string> = {};

    try {
      if (input.assets === undefined) {
        await copyDirectory(sourceDirectory, stagingDirectory, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } else {
        await makeDirectory(stagingDirectory, { recursive: false });
        for (const asset of input.assets) {
          assertSourceAsset(input.projectId, input.appId, input.sourceVersionId, asset);
          const sourcePath = join(rootDir, "public", asset.url.slice(1));
          await readVerifiedAssetBytes(sourcePath, asset, "source");

          const cloned = cloneRef(input.projectId, input.appId, input.targetVersionId, asset);
          const targetPath = join(
            stagingDirectory,
            assetKindDirectory(cloned.kind),
            `${cloned.sha256}.${cloned.extension}`,
          );
          await makeDirectory(join(stagingDirectory, assetKindDirectory(cloned.kind)), {
            recursive: true,
          });
          await copyFile(sourcePath, targetPath);
          assetsById[cloned.id] = cloned;
          urlMap[asset.url] = cloned.url;
        }
      }
      await renameFile(stagingDirectory, targetDirectory);
      return { assetsById, urlMap };
    } catch (error) {
      await removeDirectory(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  });
}
