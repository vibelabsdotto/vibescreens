declare const appIdBrand: unique symbol;
declare const versionIdBrand: unique symbol;
declare const deckIdBrand: unique symbol;
declare const assetIdBrand: unique symbol;

export type AppId = `app_${string}` & {
  readonly [appIdBrand]: "AppId";
};

export type VersionId = `ver_${string}` & {
  readonly [versionIdBrand]: "VersionId";
};

export type DeckId = `deck_${string}` & {
  readonly [deckIdBrand]: "DeckId";
};

export type AssetId = `asset_${string}` & {
  readonly [assetIdBrand]: "AssetId";
};

export const APP_ID_PATTERN = /^app_[A-Za-z0-9_-]{1,64}$/;
export const VERSION_ID_PATTERN = /^ver_[A-Za-z0-9_-]{1,64}$/;
export const DECK_ID_PATTERN = /^deck_[A-Za-z0-9_-]{1,64}$/;
export const ASSET_ID_PATTERN = /^asset_[A-Za-z0-9_-]{1,64}$/;

export function createAppId(): AppId {
  return `app_${globalThis.crypto.randomUUID()}` as AppId;
}

export function createVersionId(): VersionId {
  return `ver_${globalThis.crypto.randomUUID()}` as VersionId;
}

export function createDeckId(): DeckId {
  return `deck_${globalThis.crypto.randomUUID()}` as DeckId;
}

export function createAssetId(): AssetId {
  return `asset_${globalThis.crypto.randomUUID()}` as AssetId;
}

export function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && APP_ID_PATTERN.test(value);
}

export function isVersionId(value: unknown): value is VersionId {
  return typeof value === "string" && VERSION_ID_PATTERN.test(value);
}

export function isDeckId(value: unknown): value is DeckId {
  return typeof value === "string" && DECK_ID_PATTERN.test(value);
}

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === "string" && ASSET_ID_PATTERN.test(value);
}

export function assertAppId(value: unknown): asserts value is AppId {
  if (!isAppId(value)) {
    throw new TypeError(`Invalid app ID: ${String(value)}`);
  }
}

export function assertVersionId(value: unknown): asserts value is VersionId {
  if (!isVersionId(value)) {
    throw new TypeError(`Invalid version ID: ${String(value)}`);
  }
}

export function assertDeckId(value: unknown): asserts value is DeckId {
  if (!isDeckId(value)) {
    throw new TypeError(`Invalid deck ID: ${String(value)}`);
  }
}

export function assertAssetId(value: unknown): asserts value is AssetId {
  if (!isAssetId(value)) {
    throw new TypeError(`Invalid asset ID: ${String(value)}`);
  }
}
