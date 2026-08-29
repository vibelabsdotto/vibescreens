"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rocket,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AppId, VersionId } from "@/lib/ids";
import type { AppRecord, ProjectDocumentV3, VersionRecord } from "@/lib/project-schema";
import type { ProjectConflictState, WorkspaceMigrationStatus } from "@/lib/storage";
import type { ProjectId, WorkspaceRegistry } from "@/lib/workspace";
import type { ProjectSummary } from "@/lib/workspace-client";

type MaybePromise = void | Promise<void>;

export interface WorkspaceBarProps {
  workspace: WorkspaceRegistry | null;
  projects: readonly ProjectSummary[];
  project: ProjectDocumentV3 | null;
  loading?: boolean;
  saving?: boolean;
  readOnly?: boolean;
  workspaceReadOnly?: boolean;
  migrationStatus?: WorkspaceMigrationStatus;
  error?: string | null;
  conflict?: ProjectConflictState | null;
  onReloadLatest?: () => MaybePromise;

  onSelectProject: (projectId: ProjectId) => MaybePromise;
  onCreateProject: (name: string) => MaybePromise;
  onRenameProject: (projectId: ProjectId, name: string) => MaybePromise;
  onDeleteProject: (projectId: ProjectId) => MaybePromise;

  onSelectApp: (appId: AppId) => MaybePromise;
  onCreateApp: (name: string) => MaybePromise;
  onRenameApp: (appId: AppId, name: string) => MaybePromise;
  onDeleteApp: (appId: AppId) => MaybePromise;

  onSelectVersion: (appId: AppId, versionId: VersionId) => MaybePromise;
  onCreateVersion: (appId: AppId, name: string) => MaybePromise;
  onCloneVersion: (
    appId: AppId,
    sourceVersionId: VersionId,
    name: string,
  ) => MaybePromise;
  onRenameVersion: (
    appId: AppId,
    versionId: VersionId,
    name: string,
  ) => MaybePromise;
  onDeleteVersion: (appId: AppId, versionId: VersionId) => MaybePromise;
  onPublishVersion: (appId: AppId, versionId: VersionId) => MaybePromise;
}

interface NameDialogConfig {
  key: string;
  title: string;
  description: string;
  label: string;
  initialValue?: string;
  submitLabel: string;
  onConfirm(value: string): MaybePromise;
}

interface ExactNameDialogConfig {
  key: string;
  title: string;
  description: string;
  currentName: string;
  onConfirm(): MaybePromise;
}

interface PublishDialogConfig {
  key: string;
  versionName: string;
  onConfirm(): MaybePromise;
}

function settle(callback: () => MaybePromise): void {
  void Promise.resolve(callback()).catch(() => {
    // The parent owns visible operation errors through the `error` prop.
  });
}

function NameDialog({
  config,
  onClose,
}: {
  config: NameDialogConfig | null;
  onClose(): void;
}) {
  const [value, setValue] = React.useState("");

  React.useEffect(() => {
    setValue(config?.initialValue ?? "");
  }, [config?.key, config?.initialValue]);

  const trimmed = value.trim();
  return (
    <Dialog open={config !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config?.title}</DialogTitle>
          <DialogDescription>{config?.description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (config === null || !trimmed) return;
            settle(() => config.onConfirm(trimmed));
            onClose();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="workspace-bar-name">{config?.label}</Label>
            <Input
              id="workspace-bar-name"
              autoFocus
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed}>
              {config?.submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExactNameDialog({
  config,
  onClose,
}: {
  config: ExactNameDialogConfig | null;
  onClose(): void;
}) {
  const [confirmation, setConfirmation] = React.useState("");

  React.useEffect(() => {
    setConfirmation("");
  }, [config?.key]);

  return (
    <Dialog open={config !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config?.title}</DialogTitle>
          <DialogDescription>{config?.description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (config === null || confirmation !== config.currentName) return;
            settle(config.onConfirm);
            onClose();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="workspace-bar-confirm-name">
              Type <span className="font-semibold text-foreground">{config?.currentName}</span> to confirm
            </Label>
            <Input
              id="workspace-bar-confirm-name"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={config === null || confirmation !== config.currentName}
            >
              Delete permanently
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PublishDialog({
  config,
  onClose,
}: {
  config: PublishDialogConfig | null;
  onClose(): void;
}) {
  return (
    <Dialog open={config !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish {config?.versionName}?</DialogTitle>
          <DialogDescription>
            Publishing seals this version. Its content becomes read-only; future edits require cloning it to a draft.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (config === null) return;
              settle(config.onConfirm);
              onClose();
            }}
          >
            <Rocket aria-hidden />
            Publish version
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  const colors =
    tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs font-medium ${colors}`}>
      {children}
    </span>
  );
}

function selectedRecords(project: ProjectDocumentV3 | null): {
  app?: AppRecord;
  version?: VersionRecord;
} {
  if (project === null) return {};
  const app = project.appsById[project.selection.appId];
  return {
    app,
    version: app?.versionsById[project.selection.versionId],
  };
}

export function WorkspaceBar(props: WorkspaceBarProps) {
  const [nameDialog, setNameDialog] = React.useState<NameDialogConfig | null>(null);
  const [deleteDialog, setDeleteDialog] =
    React.useState<ExactNameDialogConfig | null>(null);
  const [publishDialog, setPublishDialog] =
    React.useState<PublishDialogConfig | null>(null);

  const { app, version } = selectedRecords(props.project);
  const activeProjectId = props.workspace?.activeProjectId ?? undefined;
  const mutationLocked =
    props.workspaceReadOnly ??
    (props.readOnly === true && version?.status !== "published");
  const busy = props.loading === true || props.saving === true;
  const appId = app?.id;
  const versionId = version?.id;

  const openCreateProject = () =>
    setNameDialog({
      key: "create-project",
      title: "Create project",
      description: "Create a separate VibeScreens project in this workspace.",
      label: "Project name",
      submitLabel: "Create project",
      onConfirm: props.onCreateProject,
    });

  const empty = props.projects.length === 0;

  return (
    <>
      <section
        aria-label="Workspace controls"
        className="border-b bg-card/95 px-3 py-2 shadow-sm backdrop-blur"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-44 flex-1 sm:max-w-64">
            <Select
              value={activeProjectId}
              disabled={busy || props.projects.length === 0}
              onValueChange={(value) => settle(() => props.onSelectProject(value as ProjectId))}
            >
              <SelectTrigger aria-label="Select project">
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                {props.projects.map((entry) => (
                  <SelectItem key={entry.projectId} value={entry.projectId}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Project actions"
                disabled={busy || mutationLocked}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuItem onSelect={openCreateProject}>
                <Plus aria-hidden /> Create project
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={props.project === null}
                onSelect={() => {
                  if (props.project === null) return;
                  const current = props.project;
                  setNameDialog({
                    key: `rename-project-${current.projectId}`,
                    title: "Rename project",
                    description: "Update the project name shown in this workspace.",
                    label: "Project name",
                    initialValue: current.name,
                    submitLabel: "Rename project",
                    onConfirm: (name) => props.onRenameProject(current.projectId, name),
                  });
                }}
              >
                Rename project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={props.project === null}
                onSelect={() => {
                  if (props.project === null) return;
                  const current = props.project;
                  setDeleteDialog({
                    key: `delete-project-${current.projectId}`,
                    title: "Delete project?",
                    description: "The project, its versions, and all uploaded asset files will be moved out of the active workspace. This cannot be undone from the editor.",
                    currentName: current.name,
                    onConfirm: () => props.onDeleteProject(current.projectId),
                  });
                }}
              >
                Delete project…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span aria-hidden className="hidden h-6 w-px bg-border sm:block" />

          <div className="min-w-40 flex-1 sm:max-w-56">
            <Select
              value={appId}
              disabled={busy || props.project === null}
              onValueChange={(value) => settle(() => props.onSelectApp(value as AppId))}
            >
              <SelectTrigger aria-label="Select app">
                <SelectValue placeholder="No app" />
              </SelectTrigger>
              <SelectContent>
                {props.project?.appOrder.map((id) => (
                  <SelectItem key={id} value={id}>
                    {props.project?.appsById[id].name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="App actions"
                disabled={busy || mutationLocked || props.project === null}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>App</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() =>
                  setNameDialog({
                    key: "create-app",
                    title: "Create app",
                    description: "Add another app with a new draft version.",
                    label: "App name",
                    submitLabel: "Create app",
                    onConfirm: props.onCreateApp,
                  })
                }
              >
                <Plus aria-hidden /> Create app
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={app === undefined}
                onSelect={() => {
                  if (app === undefined) return;
                  const current = app;
                  setNameDialog({
                    key: `rename-app-${current.id}`,
                    title: "Rename app",
                    description: "Change the organizational name for this app.",
                    label: "App name",
                    initialValue: current.name,
                    submitLabel: "Rename app",
                    onConfirm: (name) => props.onRenameApp(current.id, name),
                  });
                }}
              >
                Rename app
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={app === undefined || props.project?.appOrder.length === 1}
                onSelect={() => {
                  if (app === undefined) return;
                  const current = app;
                  setDeleteDialog({
                    key: `delete-app-${current.id}`,
                    title: "Delete app?",
                    description:
                      "Every version and deck in this app will be removed from the project, together with their uploaded asset files.",
                    currentName: current.name,
                    onConfirm: () => props.onDeleteApp(current.id),
                  });
                }}
              >
                Delete app…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="min-w-40 flex-1 sm:max-w-56">
            <Select
              value={versionId}
              disabled={busy || app === undefined}
              onValueChange={(value) => {
                if (appId !== undefined) {
                  settle(() => props.onSelectVersion(appId, value as VersionId));
                }
              }}
            >
              <SelectTrigger aria-label="Select version">
                <SelectValue placeholder="No version" />
              </SelectTrigger>
              <SelectContent>
                {app?.versionOrder.map((id) => {
                  const entry = app.versionsById[id];
                  return (
                    <SelectItem key={id} value={id}>
                      {entry.name} · {entry.status}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Version actions"
                disabled={busy || mutationLocked || app === undefined}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Version</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={appId === undefined}
                onSelect={() => {
                  if (appId === undefined) return;
                  const targetAppId = appId;
                  setNameDialog({
                    key: `create-version-${targetAppId}`,
                    title: "Create new draft",
                    description: "Start a fresh draft version using the current editor axes.",
                    label: "Version name",
                    submitLabel: "Create draft",
                    onConfirm: (name) => props.onCreateVersion(targetAppId, name),
                  });
                }}
              >
                <Plus aria-hidden /> New draft
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={appId === undefined || versionId === undefined}
                onSelect={() => {
                  if (appId === undefined || versionId === undefined) return;
                  const sourceAppId = appId;
                  const sourceVersionId = versionId;
                  setNameDialog({
                    key: `clone-version-${sourceVersionId}`,
                    title: version?.status === "published" ? "Clone to Draft" : "Clone version",
                    description: "Copy every deck and managed asset into a new editable draft.",
                    label: "Draft name",
                    initialValue: `${version?.name ?? "Version"} Copy`,
                    submitLabel: version?.status === "published" ? "Clone to Draft" : "Clone version",
                    onConfirm: (name) =>
                      props.onCloneVersion(sourceAppId, sourceVersionId, name),
                  });
                }}
              >
                <GitBranch aria-hidden />
                {version?.status === "published" ? "Clone to Draft" : "Clone version"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={version === undefined || version.status === "published"}
                onSelect={() => {
                  if (appId === undefined || version === undefined) return;
                  const targetAppId = appId;
                  const current = version;
                  setNameDialog({
                    key: `rename-version-${current.id}`,
                    title: "Rename version",
                    description: "Published versions cannot be renamed.",
                    label: "Version name",
                    initialValue: current.name,
                    submitLabel: "Rename version",
                    onConfirm: (name) =>
                      props.onRenameVersion(targetAppId, current.id, name),
                  });
                }}
              >
                Rename version
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={version === undefined || version.status === "published"}
                onSelect={() => {
                  if (appId === undefined || version === undefined) return;
                  const targetAppId = appId;
                  const current = version;
                  setPublishDialog({
                    key: `publish-version-${current.id}`,
                    versionName: current.name,
                    onConfirm: () => props.onPublishVersion(targetAppId, current.id),
                  });
                }}
              >
                <Rocket aria-hidden /> Publish…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={
                  app === undefined ||
                  version === undefined ||
                  app.versionOrder.length === 1
                }
                onSelect={() => {
                  if (appId === undefined || version === undefined) return;
                  const targetAppId = appId;
                  const current = version;
                  setDeleteDialog({
                    key: `delete-version-${current.id}`,
                    title: "Delete version?",
                    description:
                      "Every deck in this version will be removed, together with the version's uploaded asset files.",
                    currentName: current.name,
                    onConfirm: () =>
                      props.onDeleteVersion(targetAppId, current.id),
                  });
                }}
              >
                Delete version…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center gap-1.5" aria-live="polite">
            {props.project !== null && (
              <StatusPill>r{props.project.revision}</StatusPill>
            )}
            {version !== undefined && (
              <StatusPill tone={version.status === "published" ? "success" : "neutral"}>
                {version.status === "published" && <CheckCircle2 aria-hidden />}
                {version.status}
              </StatusPill>
            )}
            {props.readOnly && (
              <StatusPill tone="warning">
                <Lock aria-hidden /> Locked
              </StatusPill>
            )}
            {busy && (
              <StatusPill>
                <Loader2 className="animate-spin" aria-hidden />
                {props.saving ? "Saving" : "Loading"}
              </StatusPill>
            )}
          </div>
        </div>

        {(props.migrationStatus === "checking" ||
          props.migrationStatus === "imported" ||
          props.migrationStatus === "unsupported" ||
          props.migrationStatus === "blocked" ||
          props.conflict != null ||
          Boolean(props.error) ||
          empty) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
            {props.migrationStatus === "checking" && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Checking workspace and legacy data…
              </span>
            )}
            {props.migrationStatus === "imported" && (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                Legacy project imported successfully.
              </span>
            )}
            {(props.migrationStatus === "unsupported" ||
              props.migrationStatus === "blocked") && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {props.migrationStatus === "unsupported"
                  ? "This project uses a newer schema and is read-only here."
                  : "Legacy import is blocked; resolve migration issues before editing."}
              </span>
            )}
            {props.conflict !== null && props.conflict !== undefined && (
              <span className="inline-flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {props.conflict.message}
                {props.onReloadLatest !== undefined && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => settle(props.onReloadLatest!)}
                  >
                    <RefreshCw aria-hidden /> Reload latest
                  </Button>
                )}
              </span>
            )}
            {props.error && !props.conflict && (
              <span className="inline-flex items-center gap-1 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {props.error}
              </span>
            )}
            {empty && props.migrationStatus !== "checking" && !mutationLocked && (
              <Button type="button" size="sm" className="h-7" onClick={openCreateProject}>
                <Plus aria-hidden /> Create your first project
              </Button>
            )}
          </div>
        )}
      </section>

      <NameDialog config={nameDialog} onClose={() => setNameDialog(null)} />
      <ExactNameDialog
        config={deleteDialog}
        onClose={() => setDeleteDialog(null)}
      />
      <PublishDialog
        config={publishDialog}
        onClose={() => setPublishDialog(null)}
      />
    </>
  );
}
