import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import type { ExportManifest } from "../lib/export-plan";
import type { AppId, DeckId, VersionId } from "../lib/ids";
import { createProjectDocument, type DeckInput } from "../lib/project-operations";
import type { ProjectId } from "../lib/workspace";
import { exportProjectBundleWithBrowser } from "./browser-export";

const PROJECT_ID = "prj_browser_export" as ProjectId;
const APP_ID = "app_browser_export" as AppId;
const VERSION_ID = "ver_browser_export" as VersionId;
const DECK_ID = "deck_browser_export" as DeckId;
const directories: string[] = [];
const servers: Server[] = [];

function project() {
  const deck: DeckInput = {
    device: "iphone",
    orientation: "portrait",
    locale: "en",
    connectedCanvas: true,
    appName: "Browser Export",
    themeId: "clean-light",
    fontId: "system-sans",
    appIcon: "",
    slides: [{ id: "slide-browser-export" } as never],
  };
  return createProjectDocument(deck, {
    now: "2026-08-30T10:00:00.000Z",
    projectId: PROJECT_ID,
    projectName: "Browser Export",
    appId: APP_ID,
    appName: "Browser Export",
    versionId: VERSION_ID,
    versionName: "Draft",
    deckId: DECK_ID,
  });
}

function manifestFixture(
  projectId = PROJECT_ID,
  scope: ExportManifest["scope"] = { kind: "all", includeDrafts: true, versionIds: [VERSION_ID], deckIds: [] },
  projectRevision = 1,
): ExportManifest {
  const relativePath = `versions/draft--browser/draft/ios/iphone/portrait/en/1320x2868/01-slide.png`;
  return {
    schemaVersion: 2,
    createdAt: "2026-08-30T10:00:00.000Z",
    rendererVersion: "vibescreens-export-plan@1",
    complete: true,
    plannedJobCount: 1,
    bundleName: "browser-export.zip",
    project: {
      id: projectId,
      name: "Browser Export",
      revision: projectRevision,
      updatedAt: "2026-08-30T10:00:00.000Z",
    },
    scope,
    versions: [{
      versionId: VERSION_ID,
      versionName: "Draft",
      status: "draft",
      projectRevision,
      directory: "versions/draft--browser",
      metadataPath: "versions/draft--browser/version.json",
      deckIds: [DECK_ID],
      jobCount: 1,
      ready: true,
    }],
    jobs: [{
      id: relativePath,
      versionId: VERSION_ID,
      deckId: DECK_ID,
      slideId: "slide-browser-export",
      relativePath,
    }],
    preflight: { errors: [], warnings: [] },
  };
}

async function archiveBytes(
  projectId = PROJECT_ID,
  scope: ExportManifest["scope"] = { kind: "all", includeDrafts: true, versionIds: [VERSION_ID], deckIds: [] },
  projectRevision = 1,
): Promise<Buffer> {
  const manifest = manifestFixture(projectId, scope, projectRevision);
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  const version = manifest.versions[0];
  zip.file(version.metadataPath, JSON.stringify({
    schemaVersion: 2,
    versionId: version.versionId,
    versionName: version.versionName,
    status: version.status,
    projectRevision: version.projectRevision,
    deckIds: version.deckIds,
    jobCount: version.jobCount,
    ready: version.ready,
  }));
  zip.file(manifest.jobs[0].relativePath, Buffer.from("png"));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function fixtureServer(
  zip: Buffer,
  onBundleRequest?: () => Promise<void>,
): Promise<string> {
  const html = `<!doctype html>
  <button id="open">Export bundle</button>
  <div role="dialog" aria-label="Export project bundle" hidden>
    <input type="radio" name="project-export-scope" value="current" checked>
    <input type="radio" name="project-export-scope" value="selected">
    <input type="radio" name="project-export-scope" value="all">
    <div aria-label="Select versions"><input id="unused-version" type="checkbox"></div>
    <input id="project-export-include-drafts" type="checkbox">
    <button id="review">Review export</button>
    <section role="region" aria-label="Export preflight" hidden>Ready</section>
    <button id="download" disabled>Export bundle</button>
  </div>
  <script>
    const dialog = document.querySelector('[role="dialog"]');
    document.querySelector('#open').onclick = () => { dialog.hidden = false; };
    document.querySelector('#review').onclick = () => {
      document.querySelector('[aria-label="Export preflight"]').hidden = false;
      document.querySelector('#download').disabled = false;
    };
    document.querySelector('#download').onclick = () => {
      const anchor = document.createElement('a');
      anchor.href = '/bundle.zip';
      anchor.download = 'bundle.zip';
      anchor.click();
    };
  </script>`;
  const server = createServer(async (request, response) => {
    if (request.url === "/bundle.zip") {
      await onBundleRequest?.();
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": "attachment; filename=bundle.zip",
      });
      response.end(zip);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server has no port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("browser export", () => {
  it("drives the real browser download and verifies the resulting archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-browser-export-"));
    directories.push(root);
    const url = await fixtureServer(await archiveBytes());
    const outputPath = join(root, "exports", "bundle.zip");

    const result = await exportProjectBundleWithBrowser({
      url,
      outputPath,
      project: project(),
      scope: { kind: "all", includeDrafts: true },
      expectedManifest: manifestFixture(),
    });

    expect(result).toMatchObject({ outputPath, pngs: 1, files: 3 });
    expect(result.bytes).toBeGreaterThan(0);
    await expect(readFile(outputPath)).resolves.toHaveLength(result.bytes);
  }, 30_000);

  it("rejects a ZIP rendered for a different project", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-browser-export-"));
    directories.push(root);
    const url = await fixtureServer(await archiveBytes("prj_other" as ProjectId));

    await expect(exportProjectBundleWithBrowser({
      url,
      outputPath: join(root, "exports", "wrong-project.zip"),
      project: project(),
      scope: { kind: "all", includeDrafts: true },
      expectedManifest: manifestFixture(),
    })).rejects.toThrow("different project");
  }, 30_000);

  it("rejects a ZIP rendered for a different version scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-browser-export-"));
    directories.push(root);
    const url = await fixtureServer(await archiveBytes(PROJECT_ID, {
      kind: "all",
      includeDrafts: false,
      versionIds: [],
      deckIds: [],
    }));

    await expect(exportProjectBundleWithBrowser({
      url,
      outputPath: join(root, "exports", "wrong-scope.zip"),
      project: project(),
      scope: { kind: "all", includeDrafts: true },
      expectedManifest: manifestFixture(),
    })).rejects.toThrow("different export scope");
  }, 30_000);

  it("rejects a ZIP rendered from a different project revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-browser-export-"));
    directories.push(root);
    const url = await fixtureServer(await archiveBytes(
      PROJECT_ID,
      { kind: "all", includeDrafts: true, versionIds: [VERSION_ID], deckIds: [] },
      2,
    ));

    await expect(exportProjectBundleWithBrowser({
      url,
      outputPath: join(root, "exports", "wrong-revision.zip"),
      project: project(),
      scope: { kind: "all", includeDrafts: true },
      expectedManifest: manifestFixture(),
    })).rejects.toThrow("different project revision");
  }, 30_000);

  it("never overwrites an output created while the browser is rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibescreens-browser-export-"));
    directories.push(root);
    const outputPath = join(root, "exports", "contended.zip");
    const url = await fixtureServer(await archiveBytes(), async () => {
      await writeFile(outputPath, "competing writer");
    });

    await expect(exportProjectBundleWithBrowser({
      url,
      outputPath,
      project: project(),
      scope: { kind: "all", includeDrafts: true },
      expectedManifest: manifestFixture(),
    })).rejects.toThrow();
    await expect(readFile(outputPath, "utf8")).resolves.toBe("competing writer");
  }, 30_000);
});
