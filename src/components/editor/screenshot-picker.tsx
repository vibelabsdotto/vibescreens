"use client";
import * as React from "react";
import { Image as ImageIcon, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { didFail, img, setImage } from "@/lib/image-cache";
import type { VersionId } from "@/lib/ids";
import { resolveScreenshot } from "@/lib/locale";
import type { ProjectDocumentV3 } from "@/lib/project-schema";
import type { ProjectId } from "@/lib/workspace";

type Props = {
  label: string;
  value: string;
  locale?: string;
  assetKind?: "screenshot" | "image" | "app-icon";
  projectId: ProjectId;
  versionId: VersionId;
  onBeforeUpload?: () => Promise<void>;
  onUploadStateChange?: (uploading: boolean) => void;
  onChange: (v: string) => void;
  /** Receives the server project returned by a managed upload (revision bump). */
  onUploaded?: (project: ProjectDocumentV3) => void;
};

const ACCEPTED = ["image/png", "image/jpeg"];

type UploadResult =
  | { path: string; project: ProjectDocumentV3 | null; error: null }
  | { path: null; project: null; error: string };

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadDataUrl(
  dataUrl: string,
  fileName: string,
  kind: NonNullable<Props["assetKind"]>,
  projectId: ProjectId,
  versionId: VersionId,
): Promise<UploadResult> {
  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl, fileName, kind, projectId, versionId }),
    });
    let body: { ok?: boolean; path?: unknown; error?: unknown; project?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return {
        path: null,
        project: null,
        error: response.ok
          ? "Upload returned an invalid response; using the inline image instead."
          : `Upload failed (${response.status}); using the inline image instead.`,
      };
    }
    if (!response.ok || body.ok !== true || typeof body.path !== "string") {
      return {
        path: null,
        project: null,
        error:
          typeof body.error === "string"
            ? body.error
            : `Upload failed (${response.status}); using the inline image instead.`,
      };
    }
    const project =
      body.project !== null && typeof body.project === "object"
        ? (body.project as ProjectDocumentV3)
        : null;
    if (
      project !== null
      && (project.projectId !== projectId || project.selection.versionId !== versionId)
    ) {
      return { path: null, project: null, error: "Upload returned a different project target." };
    }
    return { path: body.path, project, error: null };
  } catch {
    return {
      path: null,
      project: null,
      error: "Could not reach the upload endpoint; using the inline image instead.",
    };
  }
}

export function ScreenshotPicker({
  label,
  value,
  locale,
  assetKind = "screenshot",
  projectId,
  versionId,
  onBeforeUpload,
  onUploadStateChange,
  onChange,
  onUploaded,
}: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const targetRef = React.useRef(`${projectId}\u0000${versionId}`);
  targetRef.current = `${projectId}\u0000${versionId}`;

  React.useEffect(() => {
    setError(null);
  }, [locale, assetKind]);

  async function handleFile(file: File) {
    const requestTarget = `${projectId}\u0000${versionId}`;
    setError(null);
    if (!ACCEPTED.includes(file.type)) {
      setError("Use PNG or JPG (App Store rejects other formats)");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Image too large (>8MB)");
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await fileToDataUrl(file);
    } catch {
      setError("Failed to read file");
      return;
    }
    // Persist managed assets when the endpoint is available. Static exports
    // and rejected uploads keep the existing inline-data fallback.
    try {
      await onBeforeUpload?.();
    } catch {
      setError("Save pending edits before uploading again.");
      return;
    }
    onUploadStateChange?.(true);
    setUploading(true);
    const upload = await uploadDataUrl(dataUrl, file.name, assetKind, projectId, versionId);
    setUploading(false);
    onUploadStateChange?.(false);
    if (targetRef.current !== requestTarget) return;
    if (upload.path !== null) {
      // Adopt the server's revision bump BEFORE the changed value triggers the
      // next autosave, otherwise that save reuses the pre-upload revision and
      // gets a 409 conflict.
      if (upload.project !== null) onUploaded?.(upload.project);
      setImage(upload.path, dataUrl);
      onChange(upload.path);
    } else {
      setImage(dataUrl, dataUrl);
      onChange(dataUrl);
      setError(upload.error);
    }
  }

  const hasValue = !!value;
  const isData = hasValue && value.startsWith("data:");
  const resolvedValue = hasValue && !isData && locale ? resolveScreenshot(value, locale) : value;
  const previewSrc = isData ? value : hasValue ? img(resolvedValue) : "";
  // Only flag "image not found" when the path is a real URL that we tried and failed.
  const knownMissing = hasValue && !isData && didFail(resolvedValue);
  const valueLabel = uploading
    ? "saving…"
    : !hasValue
      ? "drop image, or click Pick"
      : isData
        ? "uploaded image (not on disk)"
        : value.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");

  return (
    <div className="space-y-1">
      <div
        className={`flex items-center gap-3 rounded-md border p-2 transition-colors ${
          dragging ? "border-primary bg-accent ring-2 ring-primary/30" : "border-input"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) await handleFile(file);
        }}
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {previewSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewSrc}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
              onError={() => setError("Image failed to load")}
            />
          ) : (
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium">{label}</span>
          <span className="truncate text-[10px] text-muted-foreground">
            {dragging ? "Drop to upload" : valueLabel}
          </span>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (file) await handleFile(file);
            input.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
          Pick
        </Button>
        {hasValue && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              onChange("");
              setError(null);
            }}
            aria-label="Clear screenshot"
            title="Clear"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : knownMissing ? (
        <p className="text-[11px] text-destructive">Image not found at {resolvedValue}</p>
      ) : null}
    </div>
  );
}
