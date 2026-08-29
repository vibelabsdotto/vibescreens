"use client";
import * as React from "react";
import JSZip from "jszip";
import { toPng } from "html-to-image";
import { Lock, Plus } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  hasTheme,
  SCREENSHOT_FONTS,
  supportsLandscape,
  themeById,
} from "@/lib/constants";
import { nid } from "@/lib/defaults";
import { imageElementKey, isBuiltInElementId, isImageElementId, isTextElementId, textElementKey } from "@/lib/elements";
import { preloadImages } from "@/lib/image-cache";
import { resolveScreenshot, writeLocalized } from "@/lib/locale";
import { applyEditorStateToProjectDocument } from "@/lib/project-editor-adapter";
import { buildExportPlan, type ExportJob, type ExportPlan, type ExportScope } from "@/lib/export-plan";
import {
  executeProjectExportPlan,
  ProjectExportCancelledError,
  type ProjectExportEntry,
  type ProjectExportProgress,
} from "@/lib/project-export-client";
import type { DeckRecord } from "@/lib/project-schema";
import { useProject } from "@/lib/storage";
import type {
  BuiltInElementId,
  Device,
  ElementId,
  ElementTransform,
  ImageElement,
  SelectedElement,
  Slide,
} from "@/lib/types";
import { Inspector } from "./inspector";
import { PreviewStage } from "./preview-stage";
import { ProjectExportDialog } from "./project-export-dialog";
import { Sidebar } from "./sidebar";
import { DeckCanvas, getCanvas } from "./slide-canvas";
import { Toolbar } from "./toolbar";
import { WorkspaceBar } from "./workspace-bar";

type ExportRenderFrame = {
  job: ExportJob;
  deck: DeckRecord;
};

export function ScreenshotEditor() {
  const {
    state,
    setState,
    hydrated,
    savedAt,
    saveError,
    resetDevice,
    undo,
    redo,
    canUndo,
    canRedo,
    workspace,
    projects,
    project,
    loading,
    saving,
    error,
    conflict,
    readOnly,
    workspaceReadOnly,
    migrationStatus,
    flushPendingSave,
    reloadLatest,
    reconcileUpload,
    createProject,
    switchProject,
    renameProject,
    deleteProject,
    createApp,
    renameApp,
    deleteApp,
    createVersion,
    cloneVersion,
    renameVersion,
    publishVersion,
    deleteVersion,
    selectAppVersion,
  } = useProject();
  const [activeSlideId, setActiveSlideId] = React.useState<string | null>(null);
  const [selectedElement, setSelectedElement] = React.useState<SelectedElement | null>(null);
  const [ready, setReady] = React.useState(false);
  const [exportDialogOpen, setExportDialogOpen] = React.useState(false);
  const [exportPlan, setExportPlan] = React.useState<ExportPlan | null>(null);
  const [exportPlanning, setExportPlanning] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [exportProgress, setExportProgress] = React.useState<ProjectExportProgress | null>(null);
  const [exportRunning, setExportRunning] = React.useState(false);
  const [exportFrame, setExportFrame] = React.useState<ExportRenderFrame | null>(null);
  const exportControllerRef = React.useRef<AbortController | null>(null);
  const exportRef = React.useRef<HTMLDivElement | null>(null);

  const currentSlides = state.slidesByDevice[state.device] || [];
  const activeSlide =
    currentSlides.find((s) => s.id === activeSlideId) || currentSlides[0] || null;
  const theme = themeById(state.themeId);
  const fontFamily = state.fontId === "self-hosted" && state.importedFont
    ? '"ImportedScreenshotFont", Georgia, serif'
    : SCREENSHOT_FONTS[state.fontId || "system-sans"].family;
  const fontFaceCss = state.importedFont
    ? `@font-face { font-family: "ImportedScreenshotFont"; src: url("${state.importedFont.src}") format("${state.importedFont.format}"); font-display: swap; }`
    : undefined;
  const selectedApp = project?.appsById[project.selection.appId];
  const selectedVersion =
    project === null || selectedApp === undefined
      ? undefined
      : selectedApp.versionsById[project.selection.versionId];
  const publishedReadOnly = selectedVersion?.status === "published";
  const editorContentLocked = readOnly || conflict !== null;
  const editorUiLocked = editorContentLocked || exportRunning || exportPlanning || loading;
  const exportingLabel = exportRunning
    ? exportProgress === null
      ? "starting…"
      : `${exportProgress.completed}/${exportProgress.total}`
    : null;

  React.useEffect(() => {
    if (selectedElement && selectedElement.slideId !== activeSlide?.id) {
      setSelectedElement(null);
    }
  }, [activeSlide?.id, selectedElement]);

  React.useEffect(() => {
    if (!hydrated) return;
    if (!activeSlide && currentSlides.length > 0) {
      setActiveSlideId(currentSlides[0].id);
    }
  }, [hydrated, currentSlides, activeSlide]);

  React.useEffect(() => {
    if (
      !editorContentLocked &&
      !supportsLandscape(state.device) &&
      state.orientation !== "portrait"
    ) {
      setState((p) => ({ ...p, orientation: "portrait" }));
    }
  }, [editorContentLocked, state.device, state.orientation, setState]);

  React.useEffect(() => {
    if (hydrated && state.themeId && !hasTheme(state.themeId)) {
      toast.warning("Using fallback theme", {
        description: `Theme "${state.themeId}" is not defined in src/lib/constants.ts.`,
        duration: 8000,
      });
    }
  }, [hydrated, state.themeId]);

  const assetPaths = React.useMemo(() => {
    const paths = new Set<string>();
    paths.add("/mockup.png");
    if (state.appIcon) paths.add(state.appIcon);
    // Preload every locale variant so bulk export doesn't race image loads.
    const allSlides: Slide[] = Object.values(state.slidesByDevice).flat();
    for (const s of allSlides) {
      for (const raw of [s.screenshot, s.screenshotSecondary]) {
        if (!raw || raw.startsWith("data:")) continue;
        if (raw.includes("{locale}")) {
          for (const loc of state.locales) paths.add(resolveScreenshot(raw, loc));
        } else {
          paths.add(raw);
        }
      }
      for (const imageElement of s.imageElements || []) {
        if (imageElement.src && !imageElement.src.startsWith("data:")) paths.add(imageElement.src);
      }
    }
    return Array.from(paths).sort();
  }, [state.slidesByDevice, state.appIcon, state.locales]);
  const assetSig = assetPaths.join("|");

  React.useEffect(() => {
    if (!hydrated) return;
    preloadImages(assetPaths).finally(() => setReady(true));
    // assetPaths is derived from assetSig; depending on the string keeps the
    // effect from re-firing when slidesByDevice churns without path changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, assetSig]);

  // Surface storage failures (quota exceeded etc.) so the user knows their work isn't safe.
  React.useEffect(() => {
    if (saveError) {
      toast.error("Couldn't load or save project file", {
        description: saveError,
        duration: 8000,
      });
    }
  }, [saveError]);

  // ---------- Mutations ----------

  const patchSlide = React.useCallback(
    (id: string, patch: Partial<Slide>) => {
      setState((prev) => ({
        ...prev,
        slidesByDevice: {
          ...prev.slidesByDevice,
          [prev.device]: (prev.slidesByDevice[prev.device] || []).map((s) =>
            s.id === id ? { ...s, ...patch } : s,
          ),
        },
      }));
    },
    [setState],
  );

  const reorderSlides = React.useCallback(
    (next: Slide[]) => {
      setState((prev) => ({
        ...prev,
        slidesByDevice: { ...prev.slidesByDevice, [prev.device]: next },
      }));
    },
    [setState],
  );

  const deleteSlide = React.useCallback(
    (id: string) => {
      const dev = state.device;
      const slides = state.slidesByDevice[dev] || [];
      const idx = slides.findIndex((s) => s.id === id);
      if (idx === -1) return;
      const snap = slides[idx];
      const fallback = slides[idx + 1] || slides[idx - 1] || null;

      setState((prev) => {
        const cur = prev.slidesByDevice[dev] || [];
        return {
          ...prev,
          slidesByDevice: { ...prev.slidesByDevice, [dev]: cur.filter((s) => s.id !== id) },
        };
      });
      setActiveSlideId((cur) => (cur === id ? fallback?.id || null : cur));

      toast("Screen deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            setState((prev) => {
              const cur = prev.slidesByDevice[dev] || [];
              if (cur.some((s) => s.id === snap.id)) return prev;
              const restored = [...cur.slice(0, idx), snap, ...cur.slice(idx)];
              return {
                ...prev,
                slidesByDevice: { ...prev.slidesByDevice, [dev]: restored },
              };
            });
            setActiveSlideId(snap.id);
          },
        },
        duration: 6000,
      });
    },
    [setState, state.device, state.slidesByDevice],
  );

  const addSlide = React.useCallback(
    (slide: Slide) => {
      setState((prev) => ({
        ...prev,
        slidesByDevice: {
          ...prev.slidesByDevice,
          [prev.device]: [...(prev.slidesByDevice[prev.device] || []), slide],
        },
      }));
      setActiveSlideId(slide.id);
    },
    [setState],
  );

  const patchLocalized = React.useCallback(
    (slide: Slide, key: "label" | "headline", value: string) => {
      patchSlide(slide.id, {
        [key]: writeLocalized(slide[key], state.locale, value),
      } as Partial<Slide>);
    },
    [patchSlide, state.locale],
  );

  const patchElementTransform = React.useCallback(
    (slideId: string, elementId: ElementId, transform: ElementTransform) => {
      setState((prev) => ({
        ...prev,
        slidesByDevice: {
          ...prev.slidesByDevice,
          [prev.device]: (prev.slidesByDevice[prev.device] || []).map((slide) => {
            if (slide.id !== slideId) return slide;
            if (isTextElementId(elementId)) {
              const textId = textElementKey(elementId);
              return {
                ...slide,
                textElements: (slide.textElements || []).map((element) =>
                  element.id === textId ? { ...element, transform } : element,
                ),
              };
            }
            if (isImageElementId(elementId)) {
              const imageId = imageElementKey(elementId);
              return {
                ...slide,
                imageElements: (slide.imageElements || []).map((element) =>
                  element.id === imageId ? { ...element, transform } : element,
                ),
              };
            }
            if (!isBuiltInElementId(elementId)) return slide;
            return {
              ...slide,
              transforms: {
                ...(slide.transforms || {}),
                [elementId]: transform,
              } as Partial<Record<BuiltInElementId, ElementTransform>>,
            };
          }),
        },
      }));
    },
    [setState],
  );

  const patchTextElementText = React.useCallback(
    (slideId: string, textId: string, value: string) => {
      setState((prev) => ({
        ...prev,
        slidesByDevice: {
          ...prev.slidesByDevice,
          [prev.device]: (prev.slidesByDevice[prev.device] || []).map((slide) =>
            slide.id === slideId
              ? {
                  ...slide,
                  textElements: (slide.textElements || []).map((element) =>
                    element.id === textId
                      ? { ...element, text: writeLocalized(element.text, prev.locale, value) }
                      : element,
                  ),
                }
              : slide,
          ),
        },
      }));
    },
    [setState],
  );

  const duplicateSlide = React.useCallback(
    (id: string) => {
      let newId: string | null = null;
      setState((prev) => {
        const slides = prev.slidesByDevice[prev.device] || [];
        const idx = slides.findIndex((s) => s.id === id);
        if (idx === -1) return prev;
        const src = slides[idx];
        newId = nid();
        const copy: Slide = {
          ...src,
          id: newId,
          label: { ...src.label },
          headline: { ...src.headline },
          transforms: src.transforms
            ? Object.fromEntries(
                Object.entries(src.transforms).map(([key, value]) => [key, { ...value }]),
              )
            : undefined,
          textElements: src.textElements?.map((element) => ({
            ...element,
            id: nid(),
            text: { ...element.text },
            transform: { ...element.transform },
          })),
          imageElements: src.imageElements?.map((element): ImageElement => ({
            ...element,
            id: nid(),
            transform: { ...element.transform },
          })),
        };
        const next = [...slides.slice(0, idx + 1), copy, ...slides.slice(idx + 1)];
        return {
          ...prev,
          slidesByDevice: { ...prev.slidesByDevice, [prev.device]: next },
        };
      });
      if (newId) setActiveSlideId(newId);
    },
    [setState],
  );

  // ---------- Keyboard shortcuts ----------

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          (target as HTMLElement).isContentEditable);
      if (exportRunning || exportPlanning) return;

      if (e.key === "Escape") {
        setSelectedElement(null);
        if (target && "blur" in target && typeof target.blur === "function") target.blur();
        return;
      }

      // Let focused inputs and contenteditable text keep their native undo,
      // redo, selection, and deletion behavior.
      if (inEditable || editorContentLocked) return;

      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }
      if (!currentSlides.length) return;
      const idx = activeSlide ? currentSlides.findIndex((s) => s.id === activeSlide.id) : -1;
      if (e.key === "ArrowDown" || (e.key === "j" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        const next = currentSlides[Math.min(currentSlides.length - 1, idx + 1)];
        if (next) setActiveSlideId(next.id);
      } else if (e.key === "ArrowUp" || (e.key === "k" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        const next = currentSlides[Math.max(0, idx - 1)];
        if (next) setActiveSlideId(next.id);
      } else if ((e.key === "d" || e.key === "D") && (e.metaKey || e.ctrlKey)) {
        if (activeSlide) {
          e.preventDefault();
          duplicateSlide(activeSlide.id);
        }
      } else if ((e.key === "Backspace" || e.key === "Delete") && (e.metaKey || e.ctrlKey)) {
        if (activeSlide) {
          e.preventDefault();
          deleteSlide(activeSlide.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeSlide,
    currentSlides,
    duplicateSlide,
    deleteSlide,
    editorContentLocked,
    exportPlanning,
    exportRunning,
    undo,
    redo,
  ]);

  // ---------- Export ----------

  // Wait two animation frames so React's render → browser layout/paint of the
  // off-screen container settles before html-to-image snapshots it. One frame
  // is occasionally not enough on slower machines.
  const waitForPaint = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  function resetExportReview() {
    setExportPlan(null);
    setExportError(null);
  }

  async function prepareProjectExport(scope: ExportScope) {
    if (project === null) return;
    setExportPlanning(true);
    setExportError(null);
    setExportPlan(null);
    try {
      await flushPendingSave();
      let candidate = structuredClone(project);
      const { appId, versionId, deckId } = candidate.selection;
      const selected = candidate.appsById[appId]?.versionsById[versionId];
      const scopeIncludesSelectedDraft =
        selected?.status === "draft" &&
        (scope.kind === "current" ||
          (scope.kind === "all" && scope.includeDrafts === true) ||
          (scope.kind === "selected" &&
            scope.versions.some(
              (entry) => entry.appId === appId && entry.versionId === versionId,
            )));
      if (scopeIncludesSelectedDraft) {
        const selectedDeck = selected.decksById[deckId];
        const axesAlreadySelected =
          selectedDeck.device === state.device &&
          selectedDeck.orientation === state.orientation &&
          selectedDeck.locale.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
            state.locale.trim().normalize("NFKC").toLocaleLowerCase("en-US");
        candidate = applyEditorStateToProjectDocument(candidate, state, {
          now: candidate.updatedAt,
        });
        // The adapter deliberately treats an axis change as selection-only. Apply
        // once more to the cloned candidate so the newly selected draft deck also
        // receives the latest editor fields without touching the live document.
        if (!axesAlreadySelected) {
          candidate = applyEditorStateToProjectDocument(candidate, state, {
            now: candidate.updatedAt,
          });
        }
      }
      setExportPlan(
        await buildExportPlan(candidate, scope, {
          // Preflight verifies every managed asset is reachable before jobs
          // render; a bundle claiming complete:true with blank screenshots was
          // the exact failure mode this checker prevents.
          assetFileExists: async (url) => {
            try {
              const response = await fetch(url, { method: "HEAD" });
              return response.ok;
            } catch {
              return false;
            }
          },
        }),
      );
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExportPlanning(false);
    }
  }

  function throwIfExportCancelled(signal: AbortSignal) {
    if (signal.aborted) throw new ProjectExportCancelledError(signal.reason);
  }

  function exportImageUrls(plan: ExportPlan, job: ExportJob): string[] {
    const urls = new Set<string>(["/mockup.png"]);
    for (const asset of Object.values(plan.snapshot.assetsById)) {
      if (asset.kind !== "font" && asset.url && !asset.url.startsWith("data:")) {
        urls.add(asset.url);
      }
    }
    const deck =
      plan.snapshot.appsById[job.appId].versionsById[job.versionId].decksById[
        job.deckId
      ];
    if (deck.appIcon && !deck.appIcon.startsWith("data:")) urls.add(deck.appIcon);
    for (const url of deck.crossScreenMockups ?? []) {
      if (url && !url.startsWith("data:")) urls.add(url);
    }
    for (const slide of deck.slides) {
      for (const raw of [slide.screenshot, slide.screenshotSecondary]) {
        if (raw && !raw.startsWith("data:")) {
          urls.add(resolveScreenshot(raw, job.locale));
        }
      }
      for (const image of slide.imageElements ?? []) {
        if (image.src && !image.src.startsWith("data:")) urls.add(image.src);
      }
    }
    return [...urls].sort();
  }

  async function renderExportJob(
    plan: ExportPlan,
    job: ExportJob,
    signal: AbortSignal,
  ) {
    throwIfExportCancelled(signal);
    await preloadImages(exportImageUrls(plan, job), { retryFailed: true });
    throwIfExportCancelled(signal);

    const deck =
      plan.snapshot.appsById[job.appId].versionsById[job.versionId].decksById[
        job.deckId
      ];
    setExportFrame({ job, deck });
    await waitForPaint();
    if (typeof document !== "undefined" && document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // A font loading error is reflected in the rendered fallback, not hidden.
      }
    }
    await waitForPaint();
    throwIfExportCancelled(signal);

    const element = exportRef.current;
    if (element === null) throw new Error("Export render target is unavailable");
    const { cW, cH } = getCanvas(job.device, job.orientation);
    const dataUrl = await captureSlide(element, cW, cH, job.width, job.height);
    throwIfExportCancelled(signal);
    const response = await fetch(dataUrl);
    const data = await response.blob();
    throwIfExportCancelled(signal);
    return { jobId: job.id, data };
  }

  async function writeExportArchive(
    entries: readonly ProjectExportEntry[],
    signal: AbortSignal,
  ): Promise<Blob> {
    const zip = new JSZip();
    for (const entry of entries) {
      throwIfExportCancelled(signal);
      zip.file(entry.path, entry.data);
    }
    const archive = await zip.generateAsync(
      { type: "blob" },
      () => throwIfExportCancelled(signal),
    );
    throwIfExportCancelled(signal);
    return archive;
  }

  async function downloadExport(
    archive: Blob,
    fileName: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfExportCancelled(signal);
    const url = URL.createObjectURL(archive);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      throwIfExportCancelled(signal);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function startProjectExport() {
    if (exportPlan === null || exportPlan.preflight.errors.length > 0) return;
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setExportDialogOpen(false);
    setExportRunning(true);
    setExportProgress(null);
    setExportError(null);
    try {
      const completed = await executeProjectExportPlan(exportPlan, {
        signal: controller.signal,
        renderJob: (job, signal) => renderExportJob(exportPlan, job, signal),
        archiveWriter: writeExportArchive,
        downloadSink: ({ archive, fileName }, signal) =>
          downloadExport(archive, fileName, signal),
        onProgress: setExportProgress,
      });
      toast.success(
        `Exported ${completed.plan.jobs.length} PNG${completed.plan.jobs.length === 1 ? "" : "s"}`,
      );
    } catch (caught) {
      if (caught instanceof ProjectExportCancelledError || controller.signal.aborted) {
        toast.info("Export cancelled");
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        setExportError(message);
        toast.error("Project export failed", { description: message });
      }
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null;
      }
      setExportFrame(null);
      setExportProgress(null);
      setExportRunning(false);
    }
  }

  function cancelProjectExport() {
    exportControllerRef.current?.abort("Cancelled by user");
  }

  async function captureSlide(
    el: HTMLElement,
    sourceW: number,
    sourceH: number,
    exportW: number,
    exportH: number,
  ) {
    // html-to-image needs the node at (0,0). Let the library scale the source
    // canvas into the requested output dimensions; CSS transforms leave
    // transparent gutters when export aspect ratios differ by a few pixels.
    const prev = {
      left: el.style.left,
      top: el.style.top,
      position: el.style.position,
      transform: el.style.transform,
      transformOrigin: el.style.transformOrigin,
      zIndex: el.style.zIndex,
    };
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.position = "absolute";
    el.style.transform = "none";
    el.style.transformOrigin = "top left";
    el.style.zIndex = "-1";
    try {
      const dataUrl = await toPng(el, {
        width: sourceW,
        height: sourceH,
        canvasWidth: exportW,
        canvasHeight: exportH,
        pixelRatio: 1,
        cacheBust: false,
        backgroundColor: "#ffffff",
      });
      return dataUrl;
    } finally {
      el.style.left = prev.left || "-99999px";
      el.style.top = prev.top || "0px";
      el.style.position = prev.position || "absolute";
      el.style.transform = prev.transform;
      el.style.transformOrigin = prev.transformOrigin;
      el.style.zIndex = prev.zIndex;
    }
  }

  // ---------- Render ----------

  const exportCanvas =
    exportFrame === null
      ? null
      : getCanvas(exportFrame.job.device, exportFrame.job.orientation);
  const exportTheme =
    exportFrame === null ? null : themeById(exportFrame.deck.themeId);
  const exportFontFamily =
    exportFrame?.deck.fontId === "self-hosted" && exportFrame.deck.importedFont
      ? '"ImportedScreenshotFont", Georgia, serif'
      : exportFrame === null
        ? undefined
        : SCREENSHOT_FONTS[
            (exportFrame.deck.fontId || "system-sans") as keyof typeof SCREENSHOT_FONTS
          ]?.family ?? SCREENSHOT_FONTS["system-sans"].family;
  const exportFontFaceCss = exportFrame?.deck.importedFont
    ? `@font-face { font-family: "ImportedScreenshotFont"; src: url("${exportFrame.deck.importedFont.src}") format("${exportFrame.deck.importedFont.format}"); font-display: swap; }`
    : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Toaster position="top-right" richColors closeButton />
      <WorkspaceBar
        workspace={workspace}
        projects={projects}
        project={project}
        loading={loading || exportPlanning || exportRunning}
        saving={saving}
        readOnly={editorContentLocked}
        workspaceReadOnly={workspaceReadOnly || conflict !== null}
        migrationStatus={migrationStatus}
        error={error}
        conflict={conflict}
        onReloadLatest={reloadLatest}
        onSelectProject={switchProject}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onSelectApp={(appId) => {
          const app = project?.appsById[appId];
          const versionId = app?.versionOrder[0];
          if (versionId !== undefined) return selectAppVersion(appId, versionId);
        }}
        onCreateApp={createApp}
        onRenameApp={renameApp}
        onDeleteApp={deleteApp}
        onSelectVersion={(appId, versionId) => selectAppVersion(appId, versionId)}
        onCreateVersion={createVersion}
        onCloneVersion={cloneVersion}
        onRenameVersion={renameVersion}
        onDeleteVersion={deleteVersion}
        onPublishVersion={publishVersion}
      />

      {!hydrated || (project !== null && !ready) ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-muted-foreground" role="status">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <p className="text-sm">Loading editor…</p>
          </div>
        </div>
      ) : project === null ? (
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-xl border border-dashed bg-card p-8 text-center shadow-sm">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              {workspaceReadOnly ? <Lock className="h-5 w-5" aria-hidden /> : <Plus className="h-5 w-5" aria-hidden />}
            </div>
            <h1 className="text-lg font-semibold">
              {workspaceReadOnly ? "Workspace is read-only" : "Create your first project"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {workspaceReadOnly
                ? "This workspace cannot be edited with the current schema. Use the workspace status above to resolve the issue."
                : "Use “Create your first project” in the workspace controls above. Your apps, versions, decks, and assets will stay isolated inside it."}
            </p>
          </div>
        </main>
      ) : (
        <>
          {publishedReadOnly && selectedApp && selectedVersion && (
            <section
              className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100"
              aria-label="Published version read-only notice"
            >
              <Lock className="h-4 w-4 shrink-0" aria-hidden />
              <p className="min-w-0 flex-1">
                <span className="font-semibold">Published and immutable.</span>{" "}
                {selectedApp.name} · {selectedVersion.name} is read-only. Clone it before editing.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading || saving || exportPlanning || exportRunning || conflict !== null}
                onClick={() => {
                  const existing = new Set(
                    Object.values(selectedApp.versionsById).map((entry) =>
                      entry.name.trim().normalize("NFKC").toLocaleLowerCase("en-US"),
                    ),
                  );
                  const base = `${selectedVersion.name} Draft`;
                  let name = base;
                  let suffix = 2;
                  while (existing.has(name.toLocaleLowerCase("en-US"))) {
                    name = `${base} ${suffix}`;
                    suffix += 1;
                  }
                  void cloneVersion(selectedApp.id, selectedVersion.id, name);
                }}
              >
                Clone to draft
              </Button>
            </section>
          )}
          {editorContentLocked && !publishedReadOnly && (
            <section
              className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100"
              role="status"
            >
              <Lock className="h-4 w-4" aria-hidden />
              Editor content is locked until the workspace error or conflict is resolved.
            </section>
          )}

          <Toolbar
            appName={state.appName}
            setAppName={(value) => setState((previous) => ({ ...previous, appName: value }))}
            connectedCanvas={state.connectedCanvas}
            setConnectedCanvas={(value) =>
              setState((previous) => ({ ...previous, connectedCanvas: value }))
            }
            themeId={state.themeId}
            setThemeId={(value) => setState((previous) => ({ ...previous, themeId: value }))}
            fontId={state.fontId || "system-sans"}
            setFontId={(value) => setState((previous) => ({ ...previous, fontId: value }))}
            importedFont={state.importedFont}
            setImportedFont={(importedFont) =>
              setState((previous) => ({
                ...previous,
                fontId: "self-hosted",
                importedFont,
              }))
            }
            locale={state.locale}
            setLocale={(value) => setState((previous) => ({ ...previous, locale: value }))}
            locales={state.locales}
            device={state.device}
            setDevice={(value) => setState((previous) => ({ ...previous, device: value }))}
            orientation={state.orientation}
            setOrientation={(value) =>
              setState((previous) => ({ ...previous, orientation: value }))
            }
            onExport={() => {
              resetExportReview();
              setExportDialogOpen(true);
            }}
            onCancelExport={cancelProjectExport}
            onResetDeck={() => {
              resetDevice(state.device);
              setActiveSlideId(null);
              toast.success("Reset active deck to defaults");
            }}
            onUndo={undo}
            onRedo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
            exporting={exportingLabel}
            savedAt={savedAt}
            saveError={saveError}
            busy={editorUiLocked}
            onUploadReconciled={reconcileUpload}
          />

          <div className="flex flex-1 overflow-hidden md:flex-row flex-col">
            <aside className="md:w-72 w-full shrink-0 border-r bg-card md:max-h-none max-h-64 overflow-hidden">
              <fieldset
                disabled={editorUiLocked}
                aria-disabled={editorUiLocked}
                className={`h-full min-w-0 border-0 p-0 ${editorUiLocked ? "pointer-events-none select-none opacity-70" : ""}`}
              >
                <Sidebar
                  slides={currentSlides}
                  activeId={activeSlide?.id || null}
                  device={state.device}
                  orientation={state.orientation}
                  theme={theme}
                  locale={state.locale}
                  appName={state.appName}
                  appIcon={state.appIcon}
                  connectedCanvas={state.connectedCanvas}
                  disabled={editorUiLocked}
                  onReorder={reorderSlides}
                  onSelect={setActiveSlideId}
                  onDelete={deleteSlide}
                  onDuplicate={duplicateSlide}
                  onAdd={addSlide}
                />
              </fieldset>
            </aside>

            <main className="flex flex-1 items-stretch overflow-hidden min-h-0">
              <fieldset
                disabled={editorUiLocked}
                aria-disabled={editorUiLocked}
                className={`flex min-w-0 flex-1 border-0 p-0 ${editorUiLocked ? "pointer-events-none select-none" : ""}`}
              >
                {activeSlide && currentSlides.length > 0 ? (
                  <PreviewStage
                    slides={currentSlides}
                    activeSlideId={activeSlide.id}
                    device={state.device}
                    orientation={state.orientation}
                    theme={theme}
                    locale={state.locale}
                    appName={state.appName}
                    appIcon={state.appIcon}
                    fontFamily={fontFamily}
                    fontFaceCss={fontFaceCss}
                    connectedCanvas={state.connectedCanvas}
                    selectedElement={selectedElement}
                    onActiveSlideChange={setActiveSlideId}
                    onLabelChange={(slide, value) => patchLocalized(slide, "label", value)}
                    onHeadlineChange={(slide, value) =>
                      patchLocalized(slide, "headline", value)
                    }
                    onTextElementTextChange={patchTextElementText}
                    onElementChange={patchElementTransform}
                    onSelectElement={setSelectedElement}
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">No screen selected</p>
                    <p>Add a screen on the left to get started.</p>
                  </div>
                )}
              </fieldset>
            </main>

            <aside className="md:w-80 w-full shrink-0 border-l bg-card md:max-h-none max-h-96 overflow-hidden">
              <fieldset
                disabled={editorUiLocked}
                aria-disabled={editorUiLocked}
                className={`h-full min-w-0 border-0 p-0 ${editorUiLocked ? "pointer-events-none select-none opacity-70" : ""}`}
              >
                {activeSlide ? (
                  <Inspector
                    slide={activeSlide}
                    device={state.device}
                    orientation={state.orientation}
                    theme={theme}
                    locale={state.locale}
                    selectedElementId={
                      selectedElement?.slideId === activeSlide.id
                        ? selectedElement.elementId
                        : null
                    }
                    onChange={(patch) => patchSlide(activeSlide.id, patch)}
                    onSelectElement={(elementId) =>
                      setSelectedElement(
                        elementId ? { slideId: activeSlide.id, elementId } : null,
                      )
                    }
                    onUploadReconciled={reconcileUpload}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">Nothing to inspect</p>
                    <p className="text-xs">
                      Screen settings will appear here once you add or select one.
                    </p>
                  </div>
                )}
              </fieldset>
            </aside>
          </div>

          <ProjectExportDialog
            open={exportDialogOpen}
            onOpenChange={setExportDialogOpen}
            project={project}
            plan={exportPlan}
            planning={exportPlanning}
            error={exportError}
            onScopeChange={resetExportReview}
            onPrepare={prepareProjectExport}
            onExport={() => void startProjectExport()}
          />

          {exportFrame !== null && exportCanvas !== null && exportTheme !== null && (
            <div
              aria-hidden="true"
              inert
              style={{
                position: "absolute",
                left: -99999,
                top: 0,
                pointerEvents: "none",
              }}
            >
              <div
                ref={exportRef}
                style={{
                  width: exportCanvas.cW,
                  height: exportCanvas.cH,
                  overflow: "hidden",
                  position: "absolute",
                  left: -99999,
                  top: 0,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: -exportFrame.job.slideIndex * exportCanvas.cW,
                    top: 0,
                    width: exportCanvas.cW * exportFrame.deck.slides.length,
                    height: exportCanvas.cH,
                  }}
                >
                  <DeckCanvas
                    slides={exportFrame.deck.slides}
                    device={exportFrame.job.device}
                    orientation={exportFrame.job.orientation}
                    theme={exportTheme}
                    locale={exportFrame.job.locale}
                    appName={exportFrame.deck.appName}
                    appIcon={exportFrame.deck.appIcon}
                    fontFamily={exportFontFamily}
                    fontFaceCss={exportFontFaceCss}
                    connectedCanvas={exportFrame.deck.connectedCanvas}
                    hideEmpty
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
