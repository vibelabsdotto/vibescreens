"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { ExportContent, ExportPlan, ExportScope } from "@/lib/export-plan";
import {
  exportVersionOptionId,
  listProjectExportVersionOptions,
  resolveProjectExportScope,
  type ProjectExportScopeKind,
  type ProjectExportScopeSelection,
} from "@/lib/project-export-client";
import type { ProjectDocumentV3 } from "@/lib/project-schema";

interface ProjectExportDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  project: ProjectDocumentV3;
  content: ExportContent;
  plan: ExportPlan | null;
  planning: boolean;
  error: string | null;
  onScopeChange(): void;
  onPrepare(scope: ExportScope): void | Promise<void>;
  onExport(): void;
}

function selectedProjectRecords(project: ProjectDocumentV3) {
  const app = project.appsById[project.selection.appId];
  const version = app?.versionsById[project.selection.versionId];
  return { app, version };
}

export function ProjectExportDialog({
  open,
  onOpenChange,
  project,
  content,
  plan,
  planning,
  error,
  onScopeChange,
  onPrepare,
  onExport,
}: ProjectExportDialogProps) {
  const [kind, setKind] = React.useState<ProjectExportScopeKind>("current");
  const [selectedVersionOptionIds, setSelectedVersionOptionIds] = React.useState<string[]>([]);
  const [includeDrafts, setIncludeDrafts] = React.useState(false);
  const options = React.useMemo(() => listProjectExportVersionOptions(project), [project]);
  const { app, version } = selectedProjectRecords(project);

  React.useEffect(() => {
    if (!open) return;
    setKind("current");
    setIncludeDrafts(false);
    setSelectedVersionOptionIds([
      exportVersionOptionId(project.selection.appId, project.selection.versionId),
    ]);
    onScopeChange();
  }, [open, project.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateScope = (next: () => void) => {
    next();
    onScopeChange();
  };

  const selection: ProjectExportScopeSelection = {
    kind,
    selectedVersionOptionIds,
    includeDrafts,
  };
  let scope: ExportScope | null = null;
  let selectionError: string | null = null;
  try {
    scope = resolveProjectExportScope(project, selection);
  } catch (caught) {
    selectionError = caught instanceof Error ? caught.message : String(caught);
  }

  const preflightBlocked = (plan?.preflight.errors.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{content === "device-frames-with-assets" ? "Export device frames with assets" : content === "device-frames" ? "Export device frames" : "Export project bundle"}</DialogTitle>
          <DialogDescription>
            {content === "device-frames-with-assets"
              ? "One transparent PNG per screen at the original canvas size. Includes device frames and image overlays in their designed positions, with rotation, layers and fades preserved. No backgrounds, captions or text elements. Empty devices are skipped; image-only screens are included. Connected screens keep their shared crops."
              : content === "device-frames"
              ? "One transparent PNG per device, at its designed size and rotation. No backgrounds, text, icons or image overlays. Devices are exported in full, even when cropped on the canvas. Empty devices and graphic-only slides are skipped."
              : "Build a deterministic ProjectDocumentV3 bundle. Rendering uses a frozen snapshot and never switches the live editor selection."}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-3" disabled={planning}>
          <legend className="mb-2 text-sm font-medium">Versions to export</legend>
          {(["current", "selected", "all"] as const).map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
            >
              <input
                type="radio"
                name="project-export-scope"
                value={value}
                checked={kind === value}
                onChange={() => updateScope(() => setKind(value))}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">
                  {value === "current"
                    ? "Current version"
                    : value === "selected"
                      ? "Selected versions"
                      : "All published versions"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {value === "current"
                    ? `${project.name} · ${version?.name ?? "Unknown version"} · ${version?.status ?? "unknown"}`
                    : value === "selected"
                      ? "Choose exact project versions below."
                      : "Drafts stay excluded unless explicitly included."
                  }
                </span>
              </span>
            </label>
          ))}

          {kind === "selected" && (
            <div className="grid gap-2 rounded-md border bg-muted/20 p-3" aria-label="Select versions">
              {options.map((option) => {
                const checked = selectedVersionOptionIds.includes(option.id);
                return (
                  <div key={option.id} className="flex items-center gap-2">
                    <input
                      id={option.id}
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        updateScope(() =>
                          setSelectedVersionOptionIds((current) =>
                            checked
                              ? current.filter((id) => id !== option.id)
                              : [...current, option.id],
                          ),
                        )
                      }
                    />
                    <Label htmlFor={option.id} className="flex flex-1 items-center justify-between gap-3 font-normal">
                      <span>{project.name} · {option.versionName}</span>
                      <span className="text-xs text-muted-foreground">{option.status}</span>
                    </Label>
                  </div>
                );
              })}
            </div>
          )}

          {kind === "all" && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/20 p-3">
              <input
                id="project-export-include-drafts"
                type="checkbox"
                checked={includeDrafts}
                onChange={(event) =>
                  updateScope(() => setIncludeDrafts(event.target.checked))
                }
              />
              <Label htmlFor="project-export-include-drafts" className="font-normal">
                Include draft versions
              </Label>
            </div>
          )}
        </fieldset>

        {(selectionError || error) && (
          <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            {selectionError ?? error}
          </p>
        )}

        {plan !== null && (
          <section className="grid gap-2 rounded-md border p-3" aria-label="Export preflight">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Preflight</h3>
              <span className="text-xs text-muted-foreground">
                {plan.jobs.length} render job{plan.jobs.length === 1 ? "" : "s"}
              </span>
            </div>
            {plan.preflight.errors.length === 0 && plan.preflight.warnings.length === 0 && (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Ready to export
              </p>
            )}
            {plan.preflight.errors.map((issue, index) => (
              <p key={`error-${issue.code}-${index}`} className="text-sm text-destructive">
                Error: {issue.message}
              </p>
            ))}
            {plan.preflight.warnings.map((issue, index) => (
              <p key={`warning-${issue.code}-${index}`} className="text-sm text-amber-700 dark:text-amber-300">
                Warning: {issue.message}
              </p>
            ))}
            <p className="break-all text-xs text-muted-foreground">{plan.manifest.bundleName}</p>
          </section>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={planning}>
            Close
          </Button>
          {plan === null ? (
            <Button
              type="button"
              disabled={planning || scope === null}
              onClick={() => scope !== null && void onPrepare(scope)}
            >
              {planning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Review export
            </Button>
          ) : (
            <Button type="button" disabled={preflightBlocked} onClick={onExport}>
              <Download className="h-4 w-4" aria-hidden />
              {content === "device-frames-with-assets" ? "Export frames with assets" : content === "device-frames" ? "Export device frames" : "Export bundle"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
