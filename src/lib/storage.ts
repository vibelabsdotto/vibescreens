"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DEFAULT_PROJECT } from "./defaults";
import type { DeckId, VersionId } from "./ids";
import {
  applyEditorStateToProjectDocument,
  projectDocumentToEditorState,
} from "./project-editor-adapter";
import type { DeckRecord, ProjectDocumentV3 } from "./project-schema";
import type { Device, ProjectState } from "./types";
import { applyUploadReconciliation } from "./upload-reconcile";
import type { ProjectId, WorkspaceRegistry } from "./workspace";
import {
  WorkspaceAbortError,
  WorkspaceConflictError,
  WorkspaceFutureSchemaError,
  cacheProject,
  createWorkspaceClient,
  evictStaleProjectCache,
  loadWorkspaceWithAutoImport,
  readCachedProject,
  type DeckInput,
  type MigrationStatus,
  type ProjectCommand,
  type ProjectSummary,
  type WorkspaceClient,
} from "./workspace-client";

const HISTORY_LIMIT = 25;
const COALESCE_MS = 500;
const SAVE_DEBOUNCE_MS = 300;

type Updater = ProjectState | ((previous: ProjectState) => ProjectState);

export type WorkspaceMigrationStatus = "checking" | MigrationStatus;

export interface ProjectConflictState {
  code: string;
  message: string;
  current: unknown;
}

function applyUpdater(updater: Updater, previous: ProjectState): ProjectState {
  return typeof updater === "function" ? updater(previous) : updater;
}

function selectedVersion(document: ProjectDocumentV3 | null) {
  if (document === null) return undefined;
  const { appId, versionId } = document.selection;
  return document.appsById[appId]?.versionsById[versionId];
}

function isPublishedSelection(document: ProjectDocumentV3 | null): boolean {
  return selectedVersion(document)?.status === "published";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deckInputFromEditorState(state: ProjectState): DeckInput {
  return {
    device: state.device,
    orientation: state.orientation,
    locale: state.locale,
    connectedCanvas: state.connectedCanvas,
    appName: state.appName,
    themeId: state.themeId,
    fontId: state.fontId ?? "system-sans",
    importedFont: state.importedFont,
    appIcon: state.appIcon ?? "",
    slides: structuredClone(state.slidesByDevice[state.device] ?? []),
  };
}

function resetCandidateRevision(
  candidate: ProjectDocumentV3,
  base: ProjectDocumentV3,
): ProjectDocumentV3 {
  return {
    ...candidate,
    revision: base.revision,
    updatedAt: base.updatedAt,
  };
}

export function useProject() {
  const clientRef = useRef<WorkspaceClient | null>(null);
  if (clientRef.current === null) clientRef.current = createWorkspaceClient();

  const [state, setEditorState] = useState<ProjectState>(DEFAULT_PROJECT);
  const [workspace, setWorkspaceState] = useState<WorkspaceRegistry | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [project, setProjectState] = useState<ProjectDocumentV3 | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflictState] = useState<ProjectConflictState | null>(null);
  const [structuralReadOnly, setStructuralReadOnly] = useState(false);
  const [migrationStatus, setMigrationStatus] =
    useState<WorkspaceMigrationStatus>("checking");

  const mountedRef = useRef(false);
  const workspaceRef = useRef<WorkspaceRegistry | null>(null);
  const projectRef = useRef<ProjectDocumentV3 | null>(null);
  const editorStateRef = useRef<ProjectState>(DEFAULT_PROJECT);
  const structuralReadOnlyRef = useRef(false);
  const readOnlyRef = useRef(false);
  const dirtyRef = useRef(false);
  const changeVersionRef = useRef(0);
  const conflictRef = useRef<ProjectConflictState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingPromiseRef = useRef<Promise<void> | null>(null);
  const controllersRef = useRef(new Set<AbortController>());

  const pastRef = useRef<ProjectState[]>([]);
  const futureRef = useRef<ProjectState[]>([]);
  const lastPushAtRef = useRef(0);

  const readOnly = structuralReadOnly || isPublishedSelection(project);
  readOnlyRef.current = readOnly;
  structuralReadOnlyRef.current = structuralReadOnly;
  workspaceRef.current = workspace;
  projectRef.current = project;
  editorStateRef.current = state;
  conflictRef.current = conflict;

  const setWorkspace = useCallback((next: WorkspaceRegistry | null) => {
    workspaceRef.current = next;
    if (mountedRef.current) setWorkspaceState(next);
  }, []);

  const setConflict = useCallback((next: ProjectConflictState | null) => {
    conflictRef.current = next;
    if (mountedRef.current) setConflictState(next);
  }, []);

  const withAbort = useCallback(
    async <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        return await operation(controller.signal);
      } finally {
        controllersRef.current.delete(controller);
      }
    },
    [],
  );

  const noteError = useCallback(
    (caught: unknown, saveFailure = false) => {
      if (!mountedRef.current || caught instanceof WorkspaceAbortError) return;
      if (caught instanceof WorkspaceConflictError) {
        setConflict({
          code: caught.code,
          message: caught.message,
          current: caught.current,
        });
      }
      if (caught instanceof WorkspaceFutureSchemaError) {
        structuralReadOnlyRef.current = true;
        setStructuralReadOnly(true);
        setMigrationStatus("unsupported");
      }
      const message = errorMessage(caught);
      setError(message);
      if (saveFailure) setSaveError(message);
    },
    [setConflict],
  );

  const cacheAcceptedProject = useCallback((next: ProjectDocumentV3) => {
    if (typeof window === "undefined") return;
    try {
      cacheProject(window.localStorage, next);
    } catch (caught) {
      if (mountedRef.current) {
        setError(`Local project cache is unavailable: ${errorMessage(caught)}`);
      }
    }
  }, []);

  const acceptProject = useCallback(
    (
      next: ProjectDocumentV3,
      options: { preserveUnsaved?: boolean; resetHistory?: boolean } = {},
    ) => {
      if (!mountedRef.current) return;
      const preserveUnsaved = options.preserveUnsaved === true;
      let projected: ProjectState;
      if (preserveUnsaved) {
        try {
          const pending = applyEditorStateToProjectDocument(
            next,
            editorStateRef.current,
          );
          projected = projectDocumentToEditorState(pending);
        } catch {
          projected = editorStateRef.current;
        }
      } else {
        projected = projectDocumentToEditorState(next);
      }

      projectRef.current = next;
      editorStateRef.current = projected;
      dirtyRef.current = preserveUnsaved;
      setProjectState(next);
      setEditorState(projected);
      setProjectSummaries((current) => {
        const replacement: ProjectSummary = {
          projectId: next.projectId,
          name: next.name,
          revision: next.revision,
          updatedAt: next.updatedAt,
        };
        const index = current.findIndex(
          (entry) => entry.projectId === next.projectId,
        );
        if (index < 0) return [...current, replacement];
        const copy = [...current];
        copy[index] = replacement;
        return copy;
      });
      if (options.resetHistory !== false && !preserveUnsaved) {
        pastRef.current = [];
        futureRef.current = [];
        lastPushAtRef.current = 0;
      }
      cacheAcceptedProject(next);
    },
    [cacheAcceptedProject],
  );

  const clearProject = useCallback(() => {
    projectRef.current = null;
    editorStateRef.current = DEFAULT_PROJECT;
    dirtyRef.current = false;
    pastRef.current = [];
    futureRef.current = [];
    lastPushAtRef.current = 0;
    if (mountedRef.current) {
      setProjectState(null);
      setEditorState(DEFAULT_PROJECT);
    }
  }, []);

  const refreshWorkspaceAndProject = useCallback(
    async (signal: AbortSignal) => {
      const client = clientRef.current!;
      const snapshot = await client.getWorkspace(signal);
      if (!mountedRef.current) return;
      setWorkspace(snapshot.workspace);
      setProjectSummaries(snapshot.projects);
      if (typeof window !== "undefined") {
        try {
          evictStaleProjectCache(window.localStorage, snapshot.projects);
        } catch {
          // The server remains the source of truth when localStorage is unavailable.
        }
      }
      const activeProjectId = snapshot.workspace.activeProjectId;
      if (activeProjectId === null) {
        clearProject();
        return;
      }
      const latest = await client.getProject(activeProjectId, signal);
      acceptProject(latest);
    },
    [acceptProject, clearProject, setWorkspace],
  );

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setMigrationStatus("checking");

    void withAbort(async (signal) => {
      const client = clientRef.current!;
      const result = await loadWorkspaceWithAutoImport(client, signal);
      if (!mountedRef.current) return;

      setWorkspace(result.snapshot.workspace);
      setProjectSummaries(result.snapshot.projects);
      setMigrationStatus(result.migrationStatus);
      structuralReadOnlyRef.current = result.readOnly;
      setStructuralReadOnly(result.readOnly);

      if (typeof window !== "undefined") {
        try {
          evictStaleProjectCache(
            window.localStorage,
            result.snapshot.projects,
          );
        } catch {
          // A cache failure must not replace the server source of truth.
        }
      }

      const activeProjectId = result.snapshot.workspace.activeProjectId;
      if (activeProjectId === null || result.readOnly) {
        clearProject();
        setHydrated(true);
        return;
      }

      const activeSummary = result.snapshot.projects.find(
        (entry) => entry.projectId === activeProjectId,
      );
      if (activeSummary !== undefined && typeof window !== "undefined") {
        try {
          const cached = readCachedProject(
            window.localStorage,
            activeProjectId,
            activeSummary.revision,
          );
          if (cached !== null) {
            acceptProject(cached);
            setHydrated(true);
          }
        } catch {
          // Cache is optional; the authoritative fetch below still runs.
        }
      }

      const latest = await client.getProject(activeProjectId, signal);
      acceptProject(latest);
      setHydrated(true);
    })
      .catch((caught: unknown) => {
        noteError(caught);
        if (mountedRef.current) setHydrated(true);
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });

    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    };
  }, [acceptProject, clearProject, noteError, setWorkspace, withAbort]);

  const performSave = useCallback(async (): Promise<void> => {
    if (savingPromiseRef.current !== null) {
      await savingPromiseRef.current;
      if (dirtyRef.current && conflictRef.current === null) {
        await performSave();
      }
      return;
    }

    const base = projectRef.current;
    if (
      base === null ||
      !dirtyRef.current ||
      readOnlyRef.current ||
      conflictRef.current !== null ||
      structuralReadOnlyRef.current
    ) {
      return;
    }

    const requestedChangeVersion = changeVersionRef.current;
    const editorSnapshot = editorStateRef.current;
    let candidate: ProjectDocumentV3;
    try {
      candidate = resetCandidateRevision(
        applyEditorStateToProjectDocument(base, editorSnapshot),
        base,
      );
    } catch (caught) {
      dirtyRef.current = true;
      noteError(caught, true);
      throw caught;
    }

    const savePromise = (async () => {
      if (mountedRef.current) setSaving(true);
      try {
        const saved = await withAbort((signal) =>
          clientRef.current!.saveProject(
            base.projectId,
            base.revision,
            candidate,
            signal,
          ),
        );
        if (!mountedRef.current) return;
        const preserveUnsaved =
          changeVersionRef.current !== requestedChangeVersion;
        acceptProject(saved, {
          preserveUnsaved,
          resetHistory: !preserveUnsaved,
        });
        setSavedAt(Date.now());
        setSaveError(null);
        setError(null);
        setConflict(null);
      } catch (caught) {
        dirtyRef.current = true;
        noteError(caught, true);
        throw caught;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    })();

    savingPromiseRef.current = savePromise;
    try {
      await savePromise;
    } finally {
      if (savingPromiseRef.current === savePromise) {
        savingPromiseRef.current = null;
      }
    }
  }, [acceptProject, noteError, setConflict, withAbort]);

  const flushPendingSave = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (savingPromiseRef.current !== null) await savingPromiseRef.current;
    if (dirtyRef.current) await performSave();
  }, [performSave]);

  const prepareExportSnapshot = useCallback(async (): Promise<ProjectDocumentV3> => {
    await flushPendingSave();
    if (projectRef.current === null) throw new Error("No project is selected.");
    if (dirtyRef.current || conflictRef.current !== null) {
      throw new Error("Save or reload the project before preparing an export.");
    }
    // Read the accepted save result, not a React closure captured before the save.
    return structuredClone(projectRef.current);
  }, [flushPendingSave]);

  /**
   * Reconcile a server-side mutation that happened outside the normal editor
   * save path (asset uploads register an asset and bump the durable revision).
   * Without this, the next autosave reuses the pre-upload revision and gets a
   * 409. Unsaved local edits survive: the uploaded document becomes the new
   * base and the autosave then persists the edits on top of it.
   */
  const reconcileUpload = useCallback(
    (uploaded: ProjectDocumentV3) => {
      const result = applyUploadReconciliation(
        {
          document: projectRef.current!,
          dirty: dirtyRef.current,
          changeVersion: changeVersionRef.current,
        },
        uploaded,
      );
      if (!result.applied) return result;

      acceptProject(result.project, { preserveUnsaved: result.dirty, resetHistory: false });
      if (result.conflict !== null) {
        setConflict({
          code: result.conflict.code,
          message: result.conflict.message,
          current: result.conflict.current,
        });
      }
      return result;
    },
    [acceptProject, setConflict],
  );

  useEffect(() => {
    if (
      !hydrated ||
      !dirtyRef.current ||
      readOnly ||
      conflict !== null ||
      project === null
    ) {
      return;
    }
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void performSave().catch(() => {
        // Error state is recorded by performSave; background saves do not leak rejections.
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [conflict, hydrated, performSave, project, readOnly, state]);

  const setState = useCallback((updater: Updater) => {
    if (readOnlyRef.current || projectRef.current === null) return;
    setEditorState((previous) => {
      const updated = applyUpdater(updater, previous);
      if (updated === previous) return previous;

      let next = updated;
      const axesChanged =
        updated.device !== previous.device ||
        updated.orientation !== previous.orientation ||
        updated.locale !== previous.locale;
      if (axesChanged && projectRef.current !== null) {
        try {
          const selected = applyEditorStateToProjectDocument(
            projectRef.current,
            updated,
          );
          next = projectDocumentToEditorState(selected);
        } catch {
          // The save path reports a missing axis. Keep the user's unsaved choice.
        }
      }

      const now = Date.now();
      if (now - lastPushAtRef.current > COALESCE_MS) {
        pastRef.current.push(previous);
        if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
        futureRef.current = [];
      }
      lastPushAtRef.current = now;
      editorStateRef.current = next;
      changeVersionRef.current += 1;
      dirtyRef.current = true;
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    if (readOnlyRef.current || projectRef.current === null) return;
    setEditorState((current) => {
      const previous = pastRef.current.pop();
      if (previous === undefined) return current;
      futureRef.current.push(current);
      lastPushAtRef.current = 0;
      editorStateRef.current = previous;
      changeVersionRef.current += 1;
      dirtyRef.current = true;
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    if (readOnlyRef.current || projectRef.current === null) return;
    setEditorState((current) => {
      const next = futureRef.current.pop();
      if (next === undefined) return current;
      pastRef.current.push(current);
      lastPushAtRef.current = 0;
      editorStateRef.current = next;
      changeVersionRef.current += 1;
      dirtyRef.current = true;
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setState(DEFAULT_PROJECT);
  }, [setState]);

  const resetDevice = useCallback(
    (device: Device) => {
      setState((previous) => ({
        ...previous,
        slidesByDevice: {
          ...previous.slidesByDevice,
          [device]: structuredClone(DEFAULT_PROJECT.slidesByDevice[device]),
        },
      }));
    },
    [setState],
  );

  const setLocale = useCallback(
    (locale: string) => {
      setState((previous) => ({ ...previous, locale }));
    },
    [setState],
  );

  const addLocale = useCallback(
    (locale: string) => {
      const normalized = locale.trim();
      if (!normalized) return;
      setState((previous) =>
        previous.locales.some(
          (entry) => entry.toLocaleLowerCase("en-US") === normalized.toLocaleLowerCase("en-US"),
        )
          ? previous
          : { ...previous, locales: [...previous.locales, normalized] },
      );
    },
    [setState],
  );

  const removeLocale = useCallback(
    (locale: string) => {
      setState((previous) => {
        if (previous.locales.length <= 1) return previous;
        const locales = previous.locales.filter((entry) => entry !== locale);
        if (locales.length === previous.locales.length) return previous;
        return {
          ...previous,
          locales,
          locale: previous.locale === locale ? locales[0] : previous.locale,
        };
      });
    },
    [setState],
  );

  const runProjectCommand = useCallback(
    async (
      createCommand: (current: ProjectDocumentV3) => ProjectCommand,
    ): Promise<void> => {
      try {
        await flushPendingSave();
        if (conflictRef.current !== null || structuralReadOnlyRef.current) return;
        const current = projectRef.current;
        if (current === null) throw new Error("No project is selected");
        if (mountedRef.current) setLoading(true);
        const requestedChangeVersion = changeVersionRef.current;
        const response = await withAbort((signal) =>
          clientRef.current!.executeProjectCommand(
            current.projectId,
            createCommand(current),
            signal,
          ),
        );
        if (!mountedRef.current) return;
        acceptProject(response.project, {
          preserveUnsaved:
            changeVersionRef.current !== requestedChangeVersion,
        });
        setSavedAt(Date.now());
        setError(null);
        setSaveError(null);
      } catch (caught) {
        noteError(caught);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [acceptProject, flushPendingSave, noteError, withAbort],
  );

  const createProject = useCallback(
    async (name: string): Promise<void> => {
      try {
        await flushPendingSave();
        const currentWorkspace = workspaceRef.current;
        if (currentWorkspace === null || conflictRef.current !== null) return;
        setLoading(true);
        const response = await withAbort((signal) =>
          clientRef.current!.executeWorkspaceCommand(
            {
              action: "create",
              baseRevision: currentWorkspace.revision,
              name,
            },
            signal,
          ),
        );
        if (!mountedRef.current) return;
        setWorkspace(response.workspace);
        acceptProject(response.project);
        setStructuralReadOnly(false);
        setError(null);
      } catch (caught) {
        noteError(caught);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [acceptProject, flushPendingSave, noteError, setWorkspace, withAbort],
  );

  const switchProject = useCallback(
    async (projectId: ProjectId): Promise<void> => {
      try {
        await flushPendingSave();
        const currentWorkspace = workspaceRef.current;
        if (currentWorkspace === null || conflictRef.current !== null) return;
        setLoading(true);
        const response = await withAbort((signal) =>
          clientRef.current!.executeWorkspaceCommand(
            {
              action: "switch",
              baseRevision: currentWorkspace.revision,
              projectId,
            },
            signal,
          ),
        );
        if (!mountedRef.current) return;
        setWorkspace(response.workspace);
        const latest = await withAbort((signal) =>
          clientRef.current!.getProject(projectId, signal),
        );
        acceptProject(latest);
        setStructuralReadOnly(false);
        setError(null);
      } catch (caught) {
        noteError(caught);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [acceptProject, flushPendingSave, noteError, setWorkspace, withAbort],
  );

  const renameProject = useCallback(
    async (projectId: ProjectId, name: string): Promise<void> => {
      try {
        await flushPendingSave();
        const currentWorkspace = workspaceRef.current;
        const target = projectSummaries.find(
          (entry) => entry.projectId === projectId,
        );
        if (
          currentWorkspace === null ||
          target === undefined ||
          conflictRef.current !== null
        ) {
          return;
        }
        setLoading(true);
        const response = await withAbort((signal) =>
          clientRef.current!.executeWorkspaceCommand(
            {
              action: "rename",
              baseWorkspaceRevision: currentWorkspace.revision,
              baseProjectRevision: target.revision,
              projectId,
              name,
            },
            signal,
          ),
        );
        if (!mountedRef.current) return;
        setWorkspace(response.workspace);
        if (currentWorkspace.activeProjectId === projectId) {
          acceptProject(response.project);
        } else {
          setProjectSummaries((current) =>
            current.map((entry) =>
              entry.projectId === projectId
                ? {
                    projectId,
                    name: response.project.name,
                    revision: response.project.revision,
                    updatedAt: response.project.updatedAt,
                  }
                : entry,
            ),
          );
        }
        setError(null);
      } catch (caught) {
        noteError(caught);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [
      acceptProject,
      flushPendingSave,
      noteError,
      projectSummaries,
      setWorkspace,
      withAbort,
    ],
  );

  const deleteProject = useCallback(
    async (projectId: ProjectId): Promise<void> => {
      try {
        await flushPendingSave();
        const currentWorkspace = workspaceRef.current;
        if (currentWorkspace === null || conflictRef.current !== null) return;
        setLoading(true);
        const response = await withAbort((signal) =>
          clientRef.current!.executeWorkspaceCommand(
            {
              action: "delete",
              baseRevision: currentWorkspace.revision,
              projectId,
            },
            signal,
          ),
        );
        if (!mountedRef.current) return;
        setWorkspace(response.workspace);
        setProjectSummaries((current) =>
          current.filter((entry) => entry.projectId !== projectId),
        );
        if (response.workspace.activeProjectId === null) {
          clearProject();
        } else if (currentWorkspace.activeProjectId === projectId) {
          const latest = await withAbort((signal) =>
            clientRef.current!.getProject(
              response.workspace.activeProjectId!,
              signal,
            ),
          );
          acceptProject(latest);
        }
        if (typeof window !== "undefined") {
          try {
            const latestSnapshot = await withAbort((signal) =>
              clientRef.current!.getWorkspace(signal),
            );
            if (mountedRef.current) {
              setProjectSummaries(latestSnapshot.projects);
              evictStaleProjectCache(
                window.localStorage,
                latestSnapshot.projects,
              );
            }
          } catch (caught) {
            if (!(caught instanceof WorkspaceAbortError)) throw caught;
          }
        }
        setError(null);
      } catch (caught) {
        noteError(caught);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [
      acceptProject,
      clearProject,
      flushPendingSave,
      noteError,
      setWorkspace,
      withAbort,
    ],
  );

  const createVersion = useCallback(
    (name: string) =>
      runProjectCommand((current) => ({
        action: "createVersion",
        baseRevision: current.revision,
        name,
        initialDeck: deckInputFromEditorState(editorStateRef.current),
      })),
    [runProjectCommand],
  );

  const cloneVersion = useCallback(
    (sourceVersionId: VersionId, name: string) =>
      runProjectCommand((current) => ({
        action: "cloneVersion",
        baseRevision: current.revision,
        sourceVersionId,
        name,
      })),
    [runProjectCommand],
  );

  const renameVersion = useCallback(
    (versionId: VersionId, name: string) =>
      runProjectCommand((current) => ({
        action: "renameVersion",
        baseRevision: current.revision,
        versionId,
        name,
      })),
    [runProjectCommand],
  );

  const publishVersion = useCallback(
    (versionId: VersionId) =>
      runProjectCommand((current) => ({
        action: "publishVersion",
        baseRevision: current.revision,
        versionId,
      })),
    [runProjectCommand],
  );

  const deleteVersion = useCallback(
    (versionId: VersionId) =>
      runProjectCommand((current) => ({
        action: "deleteVersion",
        baseRevision: current.revision,
        versionId,
      })),
    [runProjectCommand],
  );

  const createDeck = useCallback(
    (versionId: VersionId, deck: DeckInput) =>
      runProjectCommand((current) => ({
        action: "createDeck",
        baseRevision: current.revision,
        versionId,
        deck,
      })),
    [runProjectCommand],
  );

  const updateDeck = useCallback(
    (
      versionId: VersionId,
      deckId: DeckId,
      changes: Partial<Omit<DeckRecord, "id">>,
    ) =>
      runProjectCommand((current) => ({
        action: "updateDeck",
        baseRevision: current.revision,
        versionId,
        deckId,
        changes,
      })),
    [runProjectCommand],
  );

  const deleteDeck = useCallback(
    (versionId: VersionId, deckId: DeckId) =>
      runProjectCommand((current) => ({
        action: "deleteDeck",
        baseRevision: current.revision,
        versionId,
        deckId,
      })),
    [runProjectCommand],
  );

  const selectVersion = useCallback(
    (
      versionId: VersionId,
      deckId?: DeckId,
      slideId?: string,
    ) =>
      runProjectCommand((current) => ({
        action: "selectVersion",
        baseRevision: current.revision,
        versionId,
        deckId,
        slideId,
      })),
    [runProjectCommand],
  );

  const selectDeck = useCallback(
    (
      versionId: VersionId,
      deckId: DeckId,
      slideId?: string,
    ) =>
      runProjectCommand((current) => ({
        action: "selectDeck",
        baseRevision: current.revision,
        versionId,
        deckId,
        slideId,
      })),
    [runProjectCommand],
  );

  const reloadLatest = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dirtyRef.current = false;
    setConflict(null);
    setError(null);
    setSaveError(null);
    if (mountedRef.current) setLoading(true);
    try {
      await withAbort(refreshWorkspaceAndProject);
      structuralReadOnlyRef.current = false;
      if (mountedRef.current) setStructuralReadOnly(false);
    } catch (caught) {
      noteError(caught);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [noteError, refreshWorkspaceAndProject, setConflict, withAbort]);

  return {
    state,
    setState,
    hydrated,
    savedAt,
    saveError,
    reset,
    resetDevice,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    setLocale,
    addLocale,
    removeLocale,

    workspace,
    projects: projectSummaries,
    projectSummaries,
    project,
    currentProject: project,
    loading,
    saving,
    error,
    conflict,
    readOnly,
    workspaceReadOnly: structuralReadOnly,
    migrationStatus,
    flushPendingSave,
    prepareExportSnapshot,
    reloadLatest,
    reconcileUpload,

    createProject,
    switchProject,
    renameProject,
    deleteProject,
    createVersion,
    cloneVersion,
    cloneToDraft: cloneVersion,
    renameVersion,
    publishVersion,
    deleteVersion,
    createDeck,
    updateDeck,
    deleteDeck,
    selectVersion,
    selectDeck,
  };
}
