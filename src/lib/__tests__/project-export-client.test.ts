import { describe, expect, it, vi } from "vitest";

import { ExportPlanError, type ExportJob, type ExportPlan } from "../export-plan";
import {
  ProjectExportCancelledError,
  ProjectExportPreflightError,
  ProjectExportRenderError,
  ProjectExportResultsError,
  buildProjectExportEntries,
  executeProjectExportPlan,
  getProjectExportProgress,
  runProjectExport,
  type ProjectExportRenderResult,
} from "../project-export-client";
import type { ProjectDocumentV3 } from "../project-schema";

function job(
  id: string,
  overrides: Partial<ExportJob> = {},
): ExportJob {
  return {
    id,
    appId: "app_one" as ExportJob["appId"],
    versionId: "ver_one" as ExportJob["versionId"],
    deckId: "deck_one" as ExportJob["deckId"],
    slideId: "slide-one",
    status: "draft",
    platform: "ios",
    device: "iphone",
    orientation: "portrait",
    locale: "en-US",
    width: 1320,
    height: 2868,
    sizeLabel: "6.9-inch",
    slideIndex: 0,
    layout: "hero",
    relativePath: `planner/${id}.png`,
    ...overrides,
  };
}

function makePlan(overrides: Partial<ExportPlan> = {}): ExportPlan {
  const jobs = [
    job("job-a"),
    job("job-b", {
      appId: "app_two" as ExportJob["appId"],
      versionId: "ver_two" as ExportJob["versionId"],
      deckId: "deck_two" as ExportJob["deckId"],
      slideId: "slide-two",
      relativePath: "planner/custom-second.png",
    }),
  ];
  const versions = [
    {
      appId: jobs[0].appId,
      versionId: jobs[0].versionId,
      status: "draft" as const,
      directory: "planner/version-a",
      metadataPath: "planner/version-a/custom-metadata.json",
      metadata: {
        schemaVersion: 2 as const,
        versionId: jobs[0].versionId,
        versionName: "Version One",
        status: "draft" as const,
        projectRevision: 4,
        deckIds: [jobs[0].deckId],
        jobCount: 1,
        ready: true,
      },
      deckIds: [jobs[0].deckId],
      jobCount: 1,
      ready: true,
    },
    {
      appId: jobs[1].appId,
      versionId: jobs[1].versionId,
      status: "published" as const,
      directory: "planner/version-b",
      metadataPath: "planner/version-b/version-from-planner.json",
      metadata: {
        schemaVersion: 2 as const,
        versionId: jobs[1].versionId,
        versionName: "Version Two",
        status: "published" as const,
        publishedAt: "2026-08-28T00:00:00.000Z",
        contentHash: "a".repeat(64),
        deckIds: [jobs[1].deckId],
        jobCount: 1,
        ready: true,
      },
      deckIds: [jobs[1].deckId],
      jobCount: 1,
      ready: true,
    },
  ];
  const preflight = { errors: [], warnings: [] };
  const scope = {
    kind: "selected" as const,
    versions: versions.map(({ appId, versionId }) => ({ appId, versionId })),
    deckIds: versions.flatMap((version) => version.deckIds),
  };
  const manifest = {
    schemaVersion: 2 as const,
    createdAt: "2026-08-28T00:00:00.000Z",
    rendererVersion: "test@1",
    complete: true,
    plannedJobCount: jobs.length,
    bundleName: "exact-planner-bundle.zip",
    project: {
      id: "prj_test" as ProjectDocumentV3["projectId"],
      name: "Test",
      revision: 4,
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
    scope: {
      kind: scope.kind,
      versionIds: scope.versions.map(({ versionId }) => versionId),
      deckIds: scope.deckIds,
    },
    versions: versions.map((version) => ({
      ...version.metadata,
      directory: version.directory,
      metadataPath: version.metadataPath,
    })),
    jobs: jobs.map(({ id, versionId, deckId, slideId, relativePath }) => ({
      id,
      versionId,
      deckId,
      slideId,
      relativePath,
    })),
    preflight,
  };

  return {
    snapshot: {} as Readonly<ProjectDocumentV3>,
    scope,
    versions,
    jobs,
    preflight,
    manifestPath: "manifest.json",
    manifest,
    ...overrides,
  };
}

function rendered(jobId: string, byte: number): ProjectExportRenderResult {
  return { jobId, data: new Uint8Array([byte]) };
}

describe("buildProjectExportEntries", () => {
  it("uses planner paths, metadata, and order with the manifest last", () => {
    const plan = makePlan();
    const entries = buildProjectExportEntries(plan, [
      rendered("job-b", 2),
      rendered("job-a", 1),
    ]);

    expect(entries.map((entry) => [entry.kind, entry.path])).toEqual([
      ["png", "planner/job-a.png"],
      ["png", "planner/custom-second.png"],
      ["json", "planner/version-a/custom-metadata.json"],
      ["json", "planner/version-b/version-from-planner.json"],
      ["json", "manifest.json"],
    ]);
    expect(entries[0].data).toEqual(new Uint8Array([1]));
    expect(entries[1].data).toEqual(new Uint8Array([2]));
    expect(JSON.parse(entries[2].data as string)).toEqual(plan.versions[0].metadata);
    expect(JSON.parse(entries[3].data as string)).toEqual(plan.versions[1].metadata);
    expect(JSON.parse(entries[4].data as string)).toEqual(plan.manifest);
  });

  it("rejects a missing render result", () => {
    const plan = makePlan();

    expect(() => buildProjectExportEntries(plan, [rendered("job-a", 1)])).toThrow(
      expect.objectContaining<Partial<ProjectExportResultsError>>({
        code: "missing_render_result",
        jobId: "job-b",
      }),
    );
  });

  it("rejects an extra render result", () => {
    const plan = makePlan();

    expect(() =>
      buildProjectExportEntries(plan, [
        rendered("job-a", 1),
        rendered("job-b", 2),
        rendered("not-planned", 3),
      ]),
    ).toThrow(
      expect.objectContaining<Partial<ProjectExportResultsError>>({
        code: "extra_render_result",
        jobId: "not-planned",
      }),
    );
  });

  it("rejects a duplicate render result", () => {
    const plan = makePlan();

    expect(() =>
      buildProjectExportEntries(plan, [
        rendered("job-a", 1),
        rendered("job-a", 9),
        rendered("job-b", 2),
      ]),
    ).toThrow(
      expect.objectContaining<Partial<ProjectExportResultsError>>({
        code: "duplicate_render_result",
        jobId: "job-a",
      }),
    );
  });
});

describe("getProjectExportProgress", () => {
  it("reports file progress and stable hierarchical counters from planner jobs", () => {
    const jobs = [
      job("a-size-1"),
      job("a-size-2", { relativePath: "planner/a-size-2.png" }),
      job("a-slide-2", {
        slideId: "slide-two",
        slideIndex: 1,
        relativePath: "planner/a-slide-2.png",
      }),
      job("b-slide-1", {
        appId: "app_two" as ExportJob["appId"],
        versionId: "ver_two" as ExportJob["versionId"],
        deckId: "deck_two" as ExportJob["deckId"],
        slideId: "slide-one",
        relativePath: "planner/b-slide-1.png",
      }),
    ];

    expect(getProjectExportProgress(jobs, 0)).toEqual({
      total: 4,
      completed: 0,
      currentFile: "planner/a-size-1.png",
      version: { current: 1, total: 2 },
      deck: { current: 1, total: 2 },
      slide: { current: 1, total: 3 },
    });
    expect(getProjectExportProgress(jobs, 1)).toMatchObject({
      completed: 1,
      currentFile: "planner/a-size-2.png",
      slide: { current: 1, total: 3 },
    });
    expect(getProjectExportProgress(jobs, 2)).toMatchObject({
      completed: 2,
      currentFile: "planner/a-slide-2.png",
      slide: { current: 2, total: 3 },
    });
    expect(getProjectExportProgress(jobs, 3)).toMatchObject({
      currentFile: "planner/b-slide-1.png",
      version: { current: 2, total: 2 },
      deck: { current: 2, total: 2 },
      slide: { current: 3, total: 3 },
    });
    expect(getProjectExportProgress(jobs, 4)).toMatchObject({
      completed: 4,
      currentFile: null,
      version: { current: 2, total: 2 },
      deck: { current: 2, total: 2 },
      slide: { current: 3, total: 3 },
    });
  });
});

describe("executeProjectExportPlan", () => {
  it("renders in planner order, writes one complete archive, and downloads the planner bundle", async () => {
    const plan = makePlan();
    const calls: string[] = [];
    const progress: Array<{ completed: number; currentFile: string | null }> = [];
    const renderJob = vi.fn(async (exportJob: ExportJob) => {
      calls.push(exportJob.id);
      return rendered(exportJob.id, calls.length);
    });
    const archiveWriter = vi.fn(async (entries) => {
      expect(entries.at(-1)?.path).toBe(plan.manifestPath);
      return "complete-archive";
    });
    const downloadSink = vi.fn(async () => undefined);

    const result = await executeProjectExportPlan<string>(plan, {
      signal: new AbortController().signal,
      renderJob,
      archiveWriter,
      downloadSink,
      onProgress: (value) => progress.push(value),
    });

    expect(calls).toEqual(["job-a", "job-b"]);
    expect(progress.map(({ completed, currentFile }) => ({ completed, currentFile }))).toEqual([
      { completed: 0, currentFile: "planner/job-a.png" },
      { completed: 1, currentFile: "planner/custom-second.png" },
      { completed: 2, currentFile: null },
    ]);
    expect(archiveWriter).toHaveBeenCalledTimes(1);
    expect(downloadSink).toHaveBeenCalledWith(
      {
        archive: "complete-archive",
        fileName: "exact-planner-bundle.zip",
      },
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      status: "completed",
      archive: "complete-archive",
      plan,
    });
  });

  it("cancels after rendering without creating or downloading a partial archive", async () => {
    const plan = makePlan();
    const controller = new AbortController();
    const archiveWriter = vi.fn(async () => "must-not-be-created");
    const downloadSink = vi.fn(async () => undefined);

    await expect(
      executeProjectExportPlan(plan, {
        signal: controller.signal,
        renderJob: async (exportJob) => rendered(exportJob.id, 1),
        archiveWriter,
        downloadSink,
        onProgress: ({ completed, total }) => {
          if (completed === total) controller.abort("user cancelled");
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProjectExportCancelledError>>({
        code: "cancelled",
        reason: "user cancelled",
      }),
    );
    expect(archiveWriter).not.toHaveBeenCalled();
    expect(downloadSink).not.toHaveBeenCalled();
  });

  it("wraps renderer failures with the exact planner job and never writes or downloads", async () => {
    const plan = makePlan();
    const failure = new Error("canvas failed");
    const archiveWriter = vi.fn(async () => "must-not-be-created");
    const downloadSink = vi.fn(async () => undefined);

    const promise = executeProjectExportPlan(plan, {
      signal: new AbortController().signal,
      renderJob: async (exportJob) => {
        if (exportJob.id === "job-b") throw failure;
        return rendered(exportJob.id, 1);
      },
      archiveWriter,
      downloadSink,
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining<Partial<ProjectExportRenderError>>({
        code: "render_failed",
        job: plan.jobs[1],
        cause: failure,
      }),
    );
    expect(archiveWriter).not.toHaveBeenCalled();
    expect(downloadSink).not.toHaveBeenCalled();
  });

  it("propagates published preflight errors before rendering", async () => {
    const issue = {
      code: "content_hash_mismatch" as const,
      severity: "error" as const,
      message: "Published version changed",
      appId: "app_two" as ExportJob["appId"],
      versionId: "ver_two" as ExportJob["versionId"],
    };
    const plan = makePlan({
      preflight: { errors: [issue], warnings: [] },
    });
    const renderJob = vi.fn(async (exportJob: ExportJob) => rendered(exportJob.id, 1));
    const archiveWriter = vi.fn(async () => "must-not-be-created");
    const downloadSink = vi.fn(async () => undefined);

    await expect(
      executeProjectExportPlan(plan, {
        signal: new AbortController().signal,
        renderJob,
        archiveWriter,
        downloadSink,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProjectExportPreflightError>>({
        code: "preflight_failed",
        issues: [issue],
      }),
    );
    expect(renderJob).not.toHaveBeenCalled();
    expect(archiveWriter).not.toHaveBeenCalled();
    expect(downloadSink).not.toHaveBeenCalled();
  });
});

describe("runProjectExport", () => {
  it("propagates planner errors before rendering", async () => {
    const renderJob = vi.fn(async (exportJob: ExportJob) => rendered(exportJob.id, 1));
    const archiveWriter = vi.fn(async () => "must-not-be-created");
    const downloadSink = vi.fn(async () => undefined);

    await expect(
      runProjectExport(
        { schemaVersion: 3 } as ProjectDocumentV3,
        { kind: "current" },
        {
          signal: new AbortController().signal,
          renderJob,
          archiveWriter,
          downloadSink,
        },
      ),
    ).rejects.toBeInstanceOf(ExportPlanError);
    expect(renderJob).not.toHaveBeenCalled();
    expect(archiveWriter).not.toHaveBeenCalled();
    expect(downloadSink).not.toHaveBeenCalled();
  });
});
