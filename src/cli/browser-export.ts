import { access, link, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import JSZip from "jszip";
import { chromium } from "playwright-core";

import { canonicalJson } from "../lib/canonical-json";
import type { ExportManifest, ExportScope } from "../lib/export-plan";
import { exportVersionOptionId } from "../lib/project-export-client";
import type { ProjectDocumentV3 } from "../lib/project-schema";

export interface BrowserExportInput {
  url: string;
  outputPath: string;
  project: ProjectDocumentV3;
  scope: ExportScope;
  expectedManifest: ExportManifest;
}

export interface BrowserExportResult {
  outputPath: string;
  bytes: number;
  files: number;
  pngs: number;
  manifest: ExportManifest;
}

function assertLocalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("--url must use http or https");
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new TypeError("--url must point to localhost");
  }
  return url.href;
}

function expectedVersionIds(project: ProjectDocumentV3, scope: ExportScope): string[] {
  if (scope.kind === "current") return [project.selection.versionId];
  if (scope.kind === "selected") return scope.versions.map((version) => version.versionId).sort();
  return project.appOrder.flatMap((appId) => {
    const app = project.appsById[appId];
    return app.versionOrder.filter((versionId) => (
      scope.includeDrafts === true || app.versionsById[versionId].status === "published"
    ));
  }).sort();
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertManifestScope(
  manifest: ExportManifest,
  project: ProjectDocumentV3,
  scope: ExportScope,
): void {
  const includeDraftsMatches = scope.kind !== "all"
    || manifest.scope.includeDrafts === (scope.includeDrafts === true);
  if (
    manifest.scope.kind !== scope.kind
    || !includeDraftsMatches
    || !sameValues(manifest.scope.versionIds, expectedVersionIds(project, scope))
    || manifest.scope.deckIds.length !== 0
  ) {
    throw new Error("Export archive belongs to a different export scope");
  }
}

function parseManifest(value: unknown): ExportManifest {
  if (
    typeof value !== "object"
    || value === null
    || (value as { schemaVersion?: unknown }).schemaVersion !== 2
    || !Array.isArray((value as { versions?: unknown }).versions)
    || !Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    throw new Error("Export archive contains an invalid manifest v2 document");
  }
  return value as ExportManifest;
}

function assertManifestMatchesExpected(
  manifest: ExportManifest,
  expected: ExportManifest,
): void {
  if (canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("Export archive manifest does not match the frozen export plan");
  }
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await access(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Output already exists: ${outputPath}`);
}

export async function exportProjectBundleWithBrowser(
  input: BrowserExportInput,
): Promise<BrowserExportResult> {
  const url = assertLocalUrl(input.url);
  const outputPath = resolve(input.outputPath);
  await assertOutputDoesNotExist(outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${globalThis.crypto.randomUUID()}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(url, { waitUntil: "networkidle" });
    assertLocalUrl(page.url());
    await page.getByRole("button", { name: "Export bundle", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export project bundle" });
    await dialog.waitFor();

    await dialog.locator(
      `input[name="project-export-scope"][value="${input.scope.kind}"]`,
    ).check();
    if (input.scope.kind === "selected") {
      const checkboxes = dialog.locator('[aria-label="Select versions"] input[type="checkbox"]');
      for (let index = 0; index < await checkboxes.count(); index += 1) {
        await checkboxes.nth(index).uncheck();
      }
      for (const version of input.scope.versions) {
        const optionId = exportVersionOptionId(version.appId, version.versionId);
        await dialog.locator(`input[id="${optionId}"]`).check();
      }
    }
    if (input.scope.kind === "all" && input.scope.includeDrafts === true) {
      await dialog.locator("#project-export-include-drafts").check();
    }

    await dialog.getByRole("button", { name: "Review export", exact: true }).click();
    const preflight = dialog.getByRole("region", { name: "Export preflight" });
    await preflight.waitFor();
    const exportButton = dialog.getByRole("button", { name: "Export bundle", exact: true });
    if (await exportButton.isDisabled()) {
      throw new Error(`Export preflight failed: ${await preflight.innerText()}`);
    }

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportButton.click(),
    ]);
    const downloadError = await download.failure();
    if (downloadError !== null) throw new Error(`Browser export failed: ${downloadError}`);
    await download.saveAs(temporaryPath);

    const archiveBytes = await readFile(temporaryPath);
    const archive = await JSZip.loadAsync(archiveBytes);
    const manifestEntry = archive.file("manifest.json");
    if (manifestEntry === null) throw new Error("Export archive is missing manifest.json");
    const manifest = parseManifest(JSON.parse(await manifestEntry.async("string")) as unknown);
    const files = Object.values(archive.files).filter((entry) => !entry.dir);
    const pngs = files.filter((entry) => entry.name.endsWith(".png")).length;
    if (manifest.project.id !== input.project.projectId) {
      throw new Error(
        `Export archive belongs to a different project: expected ${input.project.projectId}, received ${manifest.project.id}`,
      );
    }
    if (manifest.project.revision !== input.project.revision) {
      throw new Error(
        `Export archive belongs to a different project revision: expected ${input.project.revision}, received ${manifest.project.revision}`,
      );
    }
    assertManifestScope(manifest, input.project, input.scope);
    assertManifestMatchesExpected(manifest, input.expectedManifest);
    if (!manifest.complete || pngs !== manifest.plannedJobCount) {
      throw new Error(
        `Export archive verification failed: complete=${manifest.complete}, planned=${manifest.plannedJobCount}, pngs=${pngs}`,
      );
    }
    const expectedFiles = [
      "manifest.json",
      ...manifest.versions.map((version) => version.metadataPath),
      ...manifest.jobs.map((job) => job.relativePath),
    ].sort();
    const actualFiles = files.map((entry) => entry.name).sort();
    if (!sameValues(actualFiles, expectedFiles)) {
      throw new Error("Export archive entries do not match the frozen export plan");
    }
    for (const version of manifest.versions) {
      const metadataEntry = archive.file(version.metadataPath);
      if (metadataEntry === null) {
        throw new Error(`Export archive is missing ${version.metadataPath}`);
      }
      const metadata = JSON.parse(await metadataEntry.async("string")) as unknown;
      const expectedMetadata = {
        schemaVersion: 2,
        versionId: version.versionId,
        versionName: version.versionName,
        status: version.status,
        ...(version.projectRevision === undefined ? {} : { projectRevision: version.projectRevision }),
        ...(version.publishedAt === undefined ? {} : { publishedAt: version.publishedAt }),
        ...(version.contentHash === undefined ? {} : { contentHash: version.contentHash }),
        deckIds: version.deckIds,
        jobCount: version.jobCount,
        ready: version.ready,
      };
      if (canonicalJson(metadata) !== canonicalJson(expectedMetadata)) {
        throw new Error(`Export archive metadata does not match ${version.versionId}`);
      }
    }

    await link(temporaryPath, outputPath);
    const info = await stat(outputPath);
    return { outputPath, bytes: info.size, files: files.length, pngs, manifest };
  } finally {
    await Promise.allSettled([
      browser.close(),
      rm(temporaryPath, { force: true }),
    ]);
  }
}
