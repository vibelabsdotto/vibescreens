import {
  buildExportPlan,
  type BuildExportPlanOptions,
  type ExportJob,
  type ExportPlan,
  type ExportPreflightIssue,
  type ExportScope,
} from "./export-plan";
import type { AppId, VersionId } from "./ids";
import type { ProjectDocumentV3, VersionStatus } from "./project-schema";

export type ProjectExportEntryData = Blob | ArrayBuffer | Uint8Array | string;

export type ProjectExportScopeKind = ExportScope["kind"];

export interface ProjectExportScopeSelection {
  kind: ProjectExportScopeKind;
  selectedVersionOptionIds: readonly string[];
  includeDrafts: boolean;
}

export interface ProjectExportVersionOption {
  id: string;
  appId: AppId;
  versionId: VersionId;
  appName: string;
  versionName: string;
  status: VersionStatus;
}

export function exportVersionOptionId(appId: AppId, versionId: VersionId): string {
  return `export-version-${encodeURIComponent(appId)}--${encodeURIComponent(versionId)}`;
}

export function listProjectExportVersionOptions(
  project: ProjectDocumentV3,
): readonly ProjectExportVersionOption[] {
  const options: ProjectExportVersionOption[] = [];
  for (const appId of project.appOrder) {
    const app = project.appsById[appId];
    for (const versionId of app.versionOrder) {
      const version = app.versionsById[versionId];
      options.push({
        id: exportVersionOptionId(appId, versionId),
        appId,
        versionId,
        appName: app.name,
        versionName: version.name,
        status: version.status,
      });
    }
  }
  return options;
}

export function resolveProjectExportScope(
  project: ProjectDocumentV3,
  selection: ProjectExportScopeSelection,
): ExportScope {
  if (selection.kind === "current") return { kind: "current" };
  if (selection.kind === "all") {
    return selection.includeDrafts
      ? { kind: "all", includeDrafts: true }
      : { kind: "all" };
  }

  const requested = new Set(selection.selectedVersionOptionIds);
  const versions = listProjectExportVersionOptions(project)
    .filter((option) => requested.has(option.id))
    .map(({ appId, versionId }) => ({ appId, versionId }));
  if (versions.length === 0) {
    throw new Error("Select at least one version to export");
  }
  return { kind: "selected", versions };
}

export interface ProjectExportRenderResult {
  /** Must echo the planner job ID supplied to renderJob. */
  jobId: string;
  data: ProjectExportEntryData;
}

export interface ProjectExportEntry {
  path: string;
  kind: "png" | "json";
  data: ProjectExportEntryData;
}

export interface ProjectExportCounter {
  current: number;
  total: number;
}

export interface ProjectExportProgress {
  total: number;
  completed: number;
  /** The next planner-owned path to render, or null once every job is rendered. */
  currentFile: string | null;
  app: ProjectExportCounter;
  version: ProjectExportCounter;
  deck: ProjectExportCounter;
  slide: ProjectExportCounter;
}

export type ProjectExportResultsErrorCode =
  | "duplicate_plan_job"
  | "missing_render_result"
  | "extra_render_result"
  | "duplicate_render_result";

export class ProjectExportResultsError extends Error {
  readonly code: ProjectExportResultsErrorCode;
  readonly jobId: string;

  constructor(code: ProjectExportResultsErrorCode, jobId: string, message: string) {
    super(message);
    this.name = "ProjectExportResultsError";
    this.code = code;
    this.jobId = jobId;
  }
}

export class ProjectExportCancelledError extends Error {
  readonly code = "cancelled" as const;
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("Project export was cancelled");
    this.name = "ProjectExportCancelledError";
    this.reason = reason;
  }
}

export class ProjectExportRenderError extends Error {
  readonly code = "render_failed" as const;
  readonly job: ExportJob;
  override readonly cause: unknown;

  constructor(job: ExportJob, cause: unknown) {
    super(`Failed to render export job ${job.id} (${job.relativePath})`);
    this.name = "ProjectExportRenderError";
    this.job = job;
    this.cause = cause;
  }
}

export class ProjectExportPreflightError extends Error {
  readonly code = "preflight_failed" as const;
  readonly issues: readonly ExportPreflightIssue[];
  readonly plan: ExportPlan;

  constructor(plan: ExportPlan) {
    super(
      `Project export preflight failed: ${plan.preflight.errors
        .map((issue) => issue.message)
        .join("; ")}`,
    );
    this.name = "ProjectExportPreflightError";
    this.issues = plan.preflight.errors;
    this.plan = plan;
  }
}

function jsonEntry(path: string, value: unknown): ProjectExportEntry {
  return Object.freeze({
    path,
    kind: "json" as const,
    data: `${JSON.stringify(value, null, 2)}\n`,
  });
}

/**
 * Produces the stable ZIP order: planner jobs, planner version metadata, then
 * the planner manifest. Paths and payload metadata are copied from the plan;
 * this layer never reconstructs either from names or IDs.
 */
export function buildProjectExportEntries(
  plan: ExportPlan,
  renderedJobs: readonly ProjectExportRenderResult[],
): readonly ProjectExportEntry[] {
  const plannedIds = new Set<string>();
  for (const exportJob of plan.jobs) {
    if (plannedIds.has(exportJob.id)) {
      throw new ProjectExportResultsError(
        "duplicate_plan_job",
        exportJob.id,
        `The export plan contains duplicate job ID ${exportJob.id}`,
      );
    }
    plannedIds.add(exportJob.id);
  }

  const resultByJobId = new Map<string, ProjectExportRenderResult>();
  for (const result of renderedJobs) {
    if (!plannedIds.has(result.jobId)) {
      throw new ProjectExportResultsError(
        "extra_render_result",
        result.jobId,
        `Renderer returned unplanned job ${result.jobId}`,
      );
    }
    if (resultByJobId.has(result.jobId)) {
      throw new ProjectExportResultsError(
        "duplicate_render_result",
        result.jobId,
        `Renderer returned job ${result.jobId} more than once`,
      );
    }
    resultByJobId.set(result.jobId, result);
  }

  for (const exportJob of plan.jobs) {
    if (!resultByJobId.has(exportJob.id)) {
      throw new ProjectExportResultsError(
        "missing_render_result",
        exportJob.id,
        `Renderer did not return planned job ${exportJob.id}`,
      );
    }
  }

  const entries: ProjectExportEntry[] = plan.jobs.map((exportJob) =>
    Object.freeze({
      path: exportJob.relativePath,
      kind: "png" as const,
      data: resultByJobId.get(exportJob.id)!.data,
    }),
  );
  for (const version of plan.versions) {
    entries.push(jsonEntry(version.metadataPath, version.metadata));
  }
  entries.push(jsonEntry(plan.manifestPath, plan.manifest));
  return Object.freeze(entries);
}

type JobHierarchy = {
  app: string;
  version: string;
  deck: string;
  slide: string;
};

function hierarchyFor(exportJob: ExportJob): JobHierarchy {
  const app = String(exportJob.appId);
  const version = `${app}\u0000${exportJob.versionId}`;
  const deck = `${version}\u0000${exportJob.deckId}`;
  return {
    app,
    version,
    deck,
    slide: `${deck}\u0000${exportJob.slideId}`,
  };
}

function orderedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function counter(
  orderedKeys: readonly string[],
  currentKey: string | undefined,
  complete: boolean,
): ProjectExportCounter {
  if (orderedKeys.length === 0) return { current: 0, total: 0 };
  return {
    current: complete
      ? orderedKeys.length
      : Math.max(0, orderedKeys.indexOf(currentKey ?? "") + 1),
    total: orderedKeys.length,
  };
}

export function getProjectExportProgress(
  jobs: readonly ExportJob[],
  completed: number,
): ProjectExportProgress {
  if (!Number.isInteger(completed) || completed < 0 || completed > jobs.length) {
    throw new RangeError(`Completed export jobs must be between 0 and ${jobs.length}`);
  }

  const hierarchy = jobs.map(hierarchyFor);
  const currentJob = jobs[completed];
  const currentHierarchy = hierarchy[completed];
  const complete = completed === jobs.length;

  return {
    total: jobs.length,
    completed,
    currentFile: currentJob?.relativePath ?? null,
    app: counter(
      orderedUnique(hierarchy.map((item) => item.app)),
      currentHierarchy?.app,
      complete,
    ),
    version: counter(
      orderedUnique(hierarchy.map((item) => item.version)),
      currentHierarchy?.version,
      complete,
    ),
    deck: counter(
      orderedUnique(hierarchy.map((item) => item.deck)),
      currentHierarchy?.deck,
      complete,
    ),
    slide: counter(
      orderedUnique(hierarchy.map((item) => item.slide)),
      currentHierarchy?.slide,
      complete,
    ),
  };
}

export interface ProjectExportDownload<TArchive> {
  archive: TArchive;
  fileName: string;
}

export interface ExecuteProjectExportOptions<TArchive> {
  signal: AbortSignal;
  renderJob: (
    job: ExportJob,
    signal: AbortSignal,
  ) => Promise<ProjectExportRenderResult>;
  /** Called only after every render result has been collected and validated. */
  archiveWriter: (
    entries: readonly ProjectExportEntry[],
    signal: AbortSignal,
  ) => Promise<TArchive>;
  downloadSink: (
    download: ProjectExportDownload<TArchive>,
    signal: AbortSignal,
  ) => Promise<void>;
  onProgress?: (progress: ProjectExportProgress) => void;
}

export interface CompletedProjectExport<TArchive> {
  status: "completed";
  plan: ExportPlan;
  entries: readonly ProjectExportEntry[];
  archive: TArchive;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ProjectExportCancelledError(signal.reason);
}

export async function executeProjectExportPlan<TArchive>(
  plan: ExportPlan,
  options: ExecuteProjectExportOptions<TArchive>,
): Promise<CompletedProjectExport<TArchive>> {
  if (plan.preflight.errors.length > 0) {
    throw new ProjectExportPreflightError(plan);
  }

  const { signal } = options;
  throwIfCancelled(signal);

  const renderedJobs: ProjectExportRenderResult[] = [];
  options.onProgress?.(getProjectExportProgress(plan.jobs, 0));
  for (const exportJob of plan.jobs) {
    throwIfCancelled(signal);
    let result: ProjectExportRenderResult;
    try {
      result = await options.renderJob(exportJob, signal);
    } catch (cause) {
      if (signal.aborted) throw new ProjectExportCancelledError(signal.reason);
      throw new ProjectExportRenderError(exportJob, cause);
    }
    throwIfCancelled(signal);
    renderedJobs.push(result);
    options.onProgress?.(getProjectExportProgress(plan.jobs, renderedJobs.length));
  }

  // Cancellation and result validation happen before the archive writer sees any data.
  throwIfCancelled(signal);
  const entries = buildProjectExportEntries(plan, renderedJobs);
  throwIfCancelled(signal);

  let archive: TArchive;
  try {
    archive = await options.archiveWriter(entries, signal);
  } catch (cause) {
    if (signal.aborted) throw new ProjectExportCancelledError(signal.reason);
    throw cause;
  }
  throwIfCancelled(signal);

  try {
    await options.downloadSink(
      { archive, fileName: plan.manifest.bundleName },
      signal,
    );
  } catch (cause) {
    if (signal.aborted) throw new ProjectExportCancelledError(signal.reason);
    throw cause;
  }

  return { status: "completed", plan, entries, archive };
}

export interface RunProjectExportOptions<TArchive>
  extends ExecuteProjectExportOptions<TArchive> {
  planOptions?: BuildExportPlanOptions;
}

export async function runProjectExport<TArchive>(
  document: ProjectDocumentV3,
  scope: ExportScope,
  options: RunProjectExportOptions<TArchive>,
): Promise<CompletedProjectExport<TArchive>> {
  const plan = await buildExportPlan(document, scope, options.planOptions);
  return executeProjectExportPlan(plan, options);
}
