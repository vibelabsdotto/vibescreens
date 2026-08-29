import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppId, VersionId } from "../ids";
import {
  cloneVersionAssets,
  storeAsset,
  type AssetKind,
  type AssetStoreFileSystem,
  type CloneVersionAssetsInput,
  type StoreAssetInput,
} from "../asset-store";
import type { ProjectId } from "../workspace";

const PROJECT_ID = "prj_project" as ProjectId;
const APP_ID = "app_application" as AppId;
const VERSION_ID = "ver_version" as VersionId;
const TARGET_VERSION_ID = "ver_target" as VersionId;
const temporaryDirectories: string[] = [];

async function useTemporaryWorkingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vibescreens-assets-"));
  temporaryDirectories.push(directory);
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("storeAsset", () => {
  it("writes under an explicit root without consulting process.cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibescreens-assets-root-"));
    temporaryDirectories.push(directory);
    const cwdSpy = vi.spyOn(process, "cwd");

    const stored = await storeAsset({
      rootDir: directory,
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      bytes: Buffer.from("explicit root bytes"),
    });

    expect(cwdSpy).not.toHaveBeenCalled();
    await expect(
      readFile(join(directory, "public", stored.url.slice(1))),
    ).resolves.toEqual(Buffer.from("explicit root bytes"));
  });

  it("stores bytes by full SHA-256 and returns the stable scoped public URL", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const bytes = Buffer.from("asset bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const stored = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "screenshot",
      extension: "png",
      originalName: "screen.png",
      mime: "image/png",
      bytes,
    });

    expect(stored).toEqual({
      id: expect.stringMatching(/^asset_/),
      scope: { appId: APP_ID, versionId: VERSION_ID },
      kind: "screenshot",
      originalName: "screen.png",
      mime: "image/png",
      bytes: bytes.byteLength,
      sha256,
      extension: "png",
      url: `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/screenshots/${sha256}.png`,
    });
    await expect(
      readFile(
        join(
          directory,
          "public",
          "vibescreens-assets",
          PROJECT_ID,
          APP_ID,
          VERSION_ID,
          "screenshots",
          `${sha256}.png`,
        ),
      ),
    ).resolves.toEqual(bytes);
  });

  it("stores app icons under the validated plural app-icons path", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const bytes = Buffer.from("app icon bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const stored = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "app-icon",
      extension: "png",
      bytes,
    });

    expect(stored.url).toBe(
      `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/app-icons/${sha256}.png`,
    );
    await expect(
      readFile(
        join(
          directory,
          "public",
          "vibescreens-assets",
          PROJECT_ID,
          APP_ID,
          VERSION_ID,
          "app-icons",
          `${sha256}.png`,
        ),
      ),
    ).resolves.toEqual(bytes);
  });

  it("deduplicates identical bytes without rewriting the hashed file", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const input: StoreAssetInput = {
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "font",
      extension: "woff2",
      bytes: Buffer.from("same font bytes"),
    };

    const first = await storeAsset(input);
    const target = join(directory, "public", first.url.slice(1));
    const firstModifiedAt = (await stat(target)).mtimeMs;
    await delay(30);

    const second = await storeAsset(input);

    expect(second).toEqual(first);
    expect((await stat(target)).mtimeMs).toBe(firstModifiedAt);
  });

  it("removes its temporary file and exposes no partial target after an interrupted write", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const interruptingFileSystem: AssetStoreFileSystem = {
      access,
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      open: async (path) => {
        const handle = await open(path, "wx", 0o600);
        return {
          writeFile: async (contents) => {
            await handle.writeFile(contents.subarray(0, 3));
            throw new Error("simulated asset write interruption");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      rename,
      unlink,
    };

    await expect(
      storeAsset(
        {
          projectId: PROJECT_ID,
          appId: APP_ID,
          versionId: VERSION_ID,
          kind: "image",
          extension: "jpg",
          bytes: Buffer.from("complete image bytes"),
        },
        interruptingFileSystem,
      ),
    ).rejects.toThrow("simulated asset write interruption");

    await expect(
      readdir(
        join(
          directory,
          "public",
          "vibescreens-assets",
          PROJECT_ID,
          APP_ID,
          VERSION_ID,
          "images",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("serializes concurrent writes to the same content-addressed target", async () => {
    await useTemporaryWorkingDirectory();
    let openCalls = 0;
    let reportFirstRenameStarted!: () => void;
    let releaseFirstRename!: () => void;
    const firstRenameStarted = new Promise<void>((resolve) => {
      reportFirstRenameStarted = resolve;
    });
    const firstRenameGate = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let renameCalls = 0;
    const blockingFileSystem: AssetStoreFileSystem = {
      access,
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      open: async (path) => {
        openCalls += 1;
        const handle = await open(path, "wx", 0o600);
        return {
          writeFile: async (contents) => {
            await handle.writeFile(contents);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      rename: async (source, destination) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          reportFirstRenameStarted();
          await firstRenameGate;
        }
        await rename(source, destination);
      },
      unlink,
    };
    const input: StoreAssetInput = {
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "screenshot",
      extension: "png",
      bytes: Buffer.from("concurrent bytes"),
    };

    const firstStore = storeAsset(input, blockingFileSystem);
    await firstRenameStarted;
    const secondStore = storeAsset(input, blockingFileSystem);
    await delay(20);
    releaseFirstRename();

    const [first, second] = await Promise.all([firstStore, secondStore]);
    expect(second).toEqual(first);
    expect(openCalls).toBe(1);
  });

  it("rejects traversal, invalid IDs, kinds, and non-normalized extensions", async () => {
    await useTemporaryWorkingDirectory();
    const validInput: StoreAssetInput = {
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      bytes: Buffer.from("asset"),
    };
    const invalidInputs: StoreAssetInput[] = [
      { ...validInput, projectId: "prj_../escape" as ProjectId },
      { ...validInput, appId: "app_../escape" as AppId },
      { ...validInput, versionId: "ver_../escape" as VersionId },
      { ...validInput, kind: "../image" as AssetKind },
      { ...validInput, extension: "../png" },
      { ...validInput, extension: ".png" },
      { ...validInput, extension: "PNG" },
    ];

    for (const invalidInput of invalidInputs) {
      await expect(storeAsset(invalidInput)).rejects.toThrow();
    }
  });
});

describe("cloneVersionAssets", () => {
  it("atomically clones registered assets and returns target refs plus a URL map", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const stored = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "screenshot",
      extension: "png",
      originalName: "screen.png",
      mime: "image/png",
      bytes: Buffer.from("registered bytes"),
    });

    const result = await cloneVersionAssets({
      projectId: PROJECT_ID,
      appId: APP_ID,
      sourceVersionId: VERSION_ID,
      targetVersionId: TARGET_VERSION_ID,
      assets: [stored],
    });
    const targetUrl = stored.url.replace(`/${VERSION_ID}/`, `/${TARGET_VERSION_ID}/`);

    expect(result).toBeDefined();
    if (result === undefined) throw new Error("Expected cloned assets");
    expect(result.urlMap).toEqual({ [stored.url]: targetUrl });
    expect(Object.values(result.assetsById)).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^asset_/),
        scope: { appId: APP_ID, versionId: TARGET_VERSION_ID },
        sha256: stored.sha256,
        url: targetUrl,
      }),
    ]);
    await expect(readFile(join(directory, "public", targetUrl.slice(1)))).resolves.toEqual(
      Buffer.from("registered bytes"),
    );
  });

  it("is idempotent when the existing target contains the expected bytes", async () => {
    await useTemporaryWorkingDirectory();
    const stored = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      bytes: Buffer.from("idempotent clone bytes"),
    });
    const input: CloneVersionAssetsInput = {
      projectId: PROJECT_ID,
      appId: APP_ID,
      sourceVersionId: VERSION_ID,
      targetVersionId: TARGET_VERSION_ID,
      assets: [stored],
    };

    const first = await cloneVersionAssets(input);
    const second = await cloneVersionAssets(input);

    expect(first).toBeDefined();
    expect(second).toEqual(first);
  });

  it("rejects a mismatched existing target without overwriting it", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const stored = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      bytes: Buffer.from("expected clone bytes"),
    });
    const input: CloneVersionAssetsInput = {
      projectId: PROJECT_ID,
      appId: APP_ID,
      sourceVersionId: VERSION_ID,
      targetVersionId: TARGET_VERSION_ID,
      assets: [stored],
    };
    const first = await cloneVersionAssets(input);
    if (first === undefined) throw new Error("Expected cloned assets");
    const targetUrl = first.urlMap[stored.url];
    const targetPath = join(directory, "public", targetUrl.slice(1));
    await writeFile(targetPath, "tampered target bytes");

    await expect(cloneVersionAssets(input)).rejects.toThrow(/mismatch|corrupt/i);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("tampered target bytes");
  });

  it("fails closed on a corrupt registered source without leaving a target directory", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const stored = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      originalName: "image.png",
      mime: "image/png",
      bytes: Buffer.from("correct bytes"),
    });
    await writeFile(join(directory, "public", stored.url.slice(1)), "corrupt bytes");

    await expect(
      cloneVersionAssets({
        projectId: PROJECT_ID,
        appId: APP_ID,
        sourceVersionId: VERSION_ID,
        targetVersionId: TARGET_VERSION_ID,
        assets: [stored],
      }),
    ).rejects.toThrow(/hash|size|corrupt/i);
    await expect(
      access(
        join(
          directory,
          "public",
          "vibescreens-assets",
          PROJECT_ID,
          APP_ID,
          TARGET_VERSION_ID,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clones under an explicit root without consulting process.cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibescreens-assets-clone-root-"));
    temporaryDirectories.push(directory);
    const cwdSpy = vi.spyOn(process, "cwd");
    const stored = await storeAsset({
      rootDir: directory,
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      bytes: Buffer.from("clone root bytes"),
    });

    await cloneVersionAssets({
      rootDir: directory,
      projectId: PROJECT_ID,
      appId: APP_ID,
      sourceVersionId: VERSION_ID,
      targetVersionId: TARGET_VERSION_ID,
    });

    expect(cwdSpy).not.toHaveBeenCalled();
    const target = join(directory, "public", stored.url.slice(1)).replace(
      `/${VERSION_ID}/`,
      `/${TARGET_VERSION_ID}/`,
    );
    await expect(readFile(target)).resolves.toEqual(Buffer.from("clone root bytes"));
  });

  it("recursively copies assets into an isolated target-version scope", async () => {
    const directory = await useTemporaryWorkingDirectory();
    const screenshotBytes = Buffer.from("source screenshot");
    const fontBytes = Buffer.from("source font");
    const screenshot = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "screenshot",
      extension: "png",
      bytes: screenshotBytes,
    });
    const font = await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "font",
      extension: "woff2",
      bytes: fontBytes,
    });

    await cloneVersionAssets({
      projectId: PROJECT_ID,
      appId: APP_ID,
      sourceVersionId: VERSION_ID,
      targetVersionId: TARGET_VERSION_ID,
    });

    const sourceScreenshotPath = join(
      directory,
      "public",
      screenshot.url.slice(1),
    );
    const targetScreenshotPath = sourceScreenshotPath.replace(
      `/${VERSION_ID}/`,
      `/${TARGET_VERSION_ID}/`,
    );
    const targetFontPath = join(directory, "public", font.url.slice(1)).replace(
      `/${VERSION_ID}/`,
      `/${TARGET_VERSION_ID}/`,
    );
    await expect(readFile(targetScreenshotPath)).resolves.toEqual(screenshotBytes);
    await expect(readFile(targetFontPath)).resolves.toEqual(fontBytes);

    await writeFile(targetScreenshotPath, Buffer.from("target-only edit"));
    await expect(readFile(sourceScreenshotPath)).resolves.toEqual(screenshotBytes);
  });

  it("validates every scoped ID before deriving clone paths", async () => {
    await useTemporaryWorkingDirectory();
    const validInput: CloneVersionAssetsInput = {
      projectId: PROJECT_ID,
      appId: APP_ID,
      sourceVersionId: VERSION_ID,
      targetVersionId: TARGET_VERSION_ID,
    };
    const invalidInputs: CloneVersionAssetsInput[] = [
      { ...validInput, projectId: "prj_../escape" as ProjectId },
      { ...validInput, appId: "app_../escape" as AppId },
      { ...validInput, sourceVersionId: "ver_../escape" as VersionId },
      { ...validInput, targetVersionId: "ver_../escape" as VersionId },
    ];

    for (const invalidInput of invalidInputs) {
      await expect(cloneVersionAssets(invalidInput)).rejects.toThrow();
    }
  });

  it("rejects cloning a version onto itself", async () => {
    await useTemporaryWorkingDirectory();
    await storeAsset({
      projectId: PROJECT_ID,
      appId: APP_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      bytes: Buffer.from("source image"),
    });

    await expect(
      cloneVersionAssets({
        projectId: PROJECT_ID,
        appId: APP_ID,
        sourceVersionId: VERSION_ID,
        targetVersionId: VERSION_ID,
      }),
    ).rejects.toThrow("Source and target version IDs must differ");
  });

  it("is a no-op when the source-version directory is missing", async () => {
    const directory = await useTemporaryWorkingDirectory();

    await expect(
      cloneVersionAssets({
        projectId: PROJECT_ID,
        appId: APP_ID,
        sourceVersionId: VERSION_ID,
        targetVersionId: TARGET_VERSION_ID,
      }),
    ).resolves.toBeUndefined();

    await expect(
      access(
        join(
          directory,
          "public",
          "vibescreens-assets",
          PROJECT_ID,
          APP_ID,
          TARGET_VERSION_ID,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
