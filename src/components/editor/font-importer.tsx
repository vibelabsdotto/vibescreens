"use client";
import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VersionId } from "@/lib/ids";
import type { ProjectDocumentV3 } from "@/lib/project-schema";
import type { ImportedFont } from "@/lib/types";
import type { ProjectId } from "@/lib/workspace";

type Props = {
  disabled: boolean;
  importedFont?: ImportedFont;
  projectId: ProjectId;
  versionId: VersionId;
  onBeforeUpload?: () => Promise<void>;
  onUploadStateChange?: (uploading: boolean) => void;
  onImported: (font: ImportedFont) => void;
  /** Receives the server project returned by a managed upload (revision bump). */
  onUploaded?: (project: ProjectDocumentV3) => void;
};

export function FontImporter({
  disabled,
  importedFont,
  projectId,
  versionId,
  onBeforeUpload,
  onUploadStateChange,
  onImported,
  onUploaded,
}: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const targetRef = React.useRef(`${projectId}\u0000${versionId}`);
  targetRef.current = `${projectId}\u0000${versionId}`;

  async function importFont(file: File) {
    const requestTarget = `${projectId}\u0000${versionId}`;
    setUploading(true);
    setError(null);
    try {
      await onBeforeUpload?.();
      const form = new FormData();
      form.append("font", file);
      form.append("projectId", projectId);
      form.append("versionId", versionId);
      onUploadStateChange?.(true);
      const response = await fetch("/api/upload-font", { method: "POST", body: form });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        font?: ImportedFont;
        project?: unknown;
      };
      if (!data.ok || !data.font) throw new Error(data.error || "Could not import that font.");
      const returnedProject =
        data.project !== null && typeof data.project === "object"
          ? (data.project as ProjectDocumentV3)
          : null;
      if (
        returnedProject !== null
        && (
          returnedProject.projectId !== projectId
          || returnedProject.selection.versionId !== versionId
        )
      ) {
        throw new Error("Font upload returned a different project target.");
      }
      if (targetRef.current !== requestTarget) return;
      // Adopt the server's revision bump before the imported font triggers the
      // next autosave; otherwise that save reuses the pre-upload revision (409).
      if (returnedProject !== null) onUploaded?.(returnedProject);
      onImported(data.font);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import that font.");
    } finally {
      onUploadStateChange?.(false);
      setUploading(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFont(file);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1 px-2 text-xs"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
        title="Import a WOFF2, WOFF, TTF, or OTF font"
      >
        <Upload className="h-3.5 w-3.5" />
        {uploading ? "Importing" : importedFont ? "Replace font" : "Import font"}
      </Button>
      {error && <span className="max-w-32 truncate text-[10px] text-destructive" title={error}>{error}</span>}
    </span>
  );
}