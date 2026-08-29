import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/project-v2-minimal.json";
import {
  detectProjectContent,
  materializeLegacyAssets,
  migrateProject,
} from "../project-migrations";
import { validateProjectDocument } from "../project-schema";

const sourceSha256 = createHash("sha256")
  .update(JSON.stringify(fixture))
  .digest("hex");
const context = {
  sourceFile: "vibescreens.json" as const,
  sourceSha256,
  backupPath: `.vibescreens/backups/vibescreens.${sourceSha256}.json`,
  migratedAt: "2026-08-28T00:00:00.000Z",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("legacy project migration", () => {
  it("detects schemas from content and keeps future documents read-only", () => {
    expect(detectProjectContent(fixture)).toMatchObject({
      kind: "legacy",
      version: 2,
    });
    expect(
      detectProjectContent({
        ...fixture,
        schemaVersion: undefined,
        connectedCanvas: undefined,
      }),
    ).toMatchObject({ kind: "legacy", version: 1 });
    expect(
      detectProjectContent({
        ...fixture,
        schemaVersion: undefined,
        connectedCanvas: undefined,
        locales: undefined,
        slidesByDevice: {
          iphone: [{ ...fixture.slidesByDevice.iphone[0], label: "Label", headline: "Headline" }],
        },
      }),
    ).toMatchObject({ kind: "legacy", version: 0 });
    expect(detectProjectContent({ schemaVersion: 4 })).toEqual({
      kind: "unsupported",
      version: 4,
      readOnly: true,
    });
  });

  it("rejects a future root schema read-only before creating backup, project, workspace, or asset files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-future-migration-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "vibescreens.json");
    const sourceBytes = '{"schemaVersion":4,"future":true}\n';
    await writeFile(sourcePath, sourceBytes);

    const result = migrateProject(JSON.parse(sourceBytes), context);

    expect(result).toEqual({
      status: "unsupported",
      schemaVersion: 4,
      readOnly: true,
    });
    await expect(access(join(root, ".vibescreens"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(root, "public", "vibescreens-assets")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sourcePath, "utf8")).resolves.toBe(sourceBytes);
  });

  it("migrates v2 into deterministic app/version/decks without dropping render content", () => {
    const first = migrateProject(fixture, context);
    const second = migrateProject(structuredClone(fixture), context);

    expect(first.status).toBe("migrated");
    expect(second).toEqual(first);
    if (first.status !== "migrated") throw new Error("Expected migration");

    const { document } = first;
    const app = document.appsById[document.appOrder[0]];
    const version = app.versionsById[app.versionOrder[0]];
    const decks = version.deckOrder.map((deckId) => version.decksById[deckId]);

    expect(document).toMatchObject({
      schemaVersion: 3,
      revision: 1,
      name: "Legacy App",
      migration: {
        from: 2,
        sourceFile: "vibescreens.json",
        sourceSha256,
      },
    });
    expect(app.name).toBe("Legacy App");
    expect(version).toMatchObject({ name: "Imported v2", status: "draft" });
    expect(decks.map(({ device, locale }) => [device, locale])).toEqual([
      ["iphone", "en"],
      ["iphone", "de"],
      ["android-10", "en"],
      ["android-10", "de"],
    ]);
    expect(decks[1]).toMatchObject({
      connectedCanvas: true,
      appName: "Legacy App",
      themeId: "ocean-fresh",
      fontId: "self-hosted",
      importedFont: fixture.importedFont,
      appIcon: "/app-icon.png",
      crossScreenMockups: ["/screenshots/mockup.png"],
      slides: [
        expect.objectContaining({
          id: "slide-one",
          label: { de: "WILLKOMMEN" },
          headline: { de: "Hallo" },
          screenshot: "/screenshots/de/phone.png",
          imageElements: [expect.objectContaining({ src: "/screenshots/de/logo.png" })],
        }),
      ],
    });
    expect(document.selection).toMatchObject({
      appId: app.id,
      versionId: version.id,
      slideId: "slide-one",
    });
    expect(version.decksById[document.selection.deckId]).toMatchObject({
      device: "iphone",
      locale: "de",
      orientation: "portrait",
    });
    expect(validateProjectDocument(document)).toMatchObject({ ok: true });
    expect(first.assets.map((asset) => asset.source)).toEqual(
      expect.arrayContaining([
        "/app-icon.png",
        "/fonts/imported/custom.woff2",
        "/screenshots/de/phone.png",
        "/screenshots/de/logo.png",
        "/screenshots/mockup.png",
      ]),
    );
  });

  it("normalizes v0 string text safely and preserves explicit v2 connectedCanvas", () => {
    const v0 = {
      ...structuredClone(fixture),
      schemaVersion: undefined,
      connectedCanvas: undefined,
      locales: undefined,
      locale: "fr",
      slidesByDevice: {
        iphone: [
          {
            ...fixture.slidesByDevice.iphone[0],
            label: "Legacy label",
            headline: "Legacy headline",
          },
        ],
      },
    };

    const migratedV0 = migrateProject(v0, context);
    const migratedV2 = migrateProject(
      { ...structuredClone(fixture), connectedCanvas: false },
      context,
    );
    if (migratedV0.status !== "migrated" || migratedV2.status !== "migrated") {
      throw new Error("Expected migrations");
    }

    const v0Deck =
      migratedV0.document.appsById[migratedV0.document.appOrder[0]].versionsById[
        migratedV0.document.appsById[migratedV0.document.appOrder[0]].versionOrder[0]
      ].decksById[migratedV0.document.selection.deckId];
    const v2Deck =
      migratedV2.document.appsById[migratedV2.document.appOrder[0]].versionsById[
        migratedV2.document.appsById[migratedV2.document.appOrder[0]].versionOrder[0]
      ].decksById[migratedV2.document.selection.deckId];

    expect(v0Deck).toMatchObject({
      locale: "fr",
      connectedCanvas: false,
      slides: [
        expect.objectContaining({
          label: { fr: "Legacy label" },
          headline: { fr: "Legacy headline" },
        }),
      ],
    });
    expect(v2Deck.connectedCanvas).toBe(false);
  });

  it("materializes local assets into scoped SHA-256 storage and warns without erasing missing references", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-migration-"));
    temporaryDirectories.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);

    const localFiles: Record<string, string> = {
      "public/app-icon.png": "icon bytes",
      "public/fonts/imported/custom.woff2": "font bytes",
      "public/screenshots/de/phone.png": "phone bytes",
      "public/screenshots/de/logo.png": "logo bytes",
      "public/screenshots/mockup.png": "mockup bytes",
    };
    for (const [path, contents] of Object.entries(localFiles)) {
      const absolutePath = join(root, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }

    const raw = structuredClone(fixture) as unknown as {
      slidesByDevice: { iphone: Array<Record<string, unknown>> };
    };
    raw.slidesByDevice.iphone[0].screenshotSecondary =
      "/screenshots/{locale}/missing.png";
    const migrated = migrateProject(raw, context);
    if (migrated.status !== "migrated") throw new Error("Expected migration");

    const materialized = await materializeLegacyAssets(migrated, { rootDirectory: root });
    const app = materialized.document.appsById[materialized.document.appOrder[0]];
    const version = app.versionsById[app.versionOrder[0]];
    const selectedDeck = version.decksById[materialized.document.selection.deckId];
    const selectedSlide = selectedDeck.slides[0];

    expect(selectedDeck.appIcon).toMatch(
      /^\/vibescreens-assets\/prj_[^/]+\/app_[^/]+\/ver_[^/]+\/app-icons\/[a-f0-9]{64}\.png$/,
    );
    expect(selectedDeck.importedFont?.src).toMatch(/\/fonts\/[a-f0-9]{64}\.woff2$/);
    expect(selectedSlide.screenshot).toMatch(/\/screenshots\/[a-f0-9]{64}\.png$/);
    expect(selectedSlide.imageElements?.[0].src).toMatch(/\/images\/[a-f0-9]{64}\.png$/);
    expect(selectedDeck.crossScreenMockups?.[0]).toMatch(
      /\/images\/[a-f0-9]{64}\.png$/,
    );
    expect(Object.values(materialized.document.assetsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^asset_/),
          scope: { appId: app.id, versionId: version.id },
          kind: "screenshot",
          originalName: "phone.png",
          mime: "image/png",
          bytes: Buffer.byteLength("phone bytes"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          extension: "png",
          url: selectedSlide.screenshot,
        }),
      ]),
    );
    expect(selectedSlide.screenshotSecondary).toBe(
      "/screenshots/de/missing.png",
    );
    expect(materialized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_asset",
          source: "/screenshots/de/missing.png",
        }),
      ]),
    );
    expect(materialized.document.migration?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/screenshots/de/missing.png"),
      ]),
    );

    const iconUrl = selectedDeck.appIcon;
    await expect(readFile(join(root, "public", iconUrl.slice(1)))).resolves.toEqual(
      Buffer.from("icon bytes"),
    );

    const repeated = await materializeLegacyAssets(materialized, {
      rootDirectory: root,
    });
    expect(repeated).toEqual(materialized);
  });
});
