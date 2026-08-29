import type { ProjectDocumentV3 } from "./project-schema";

/**
 * Editor-side state an asset upload needs to reconcile against. Mirrors the
 * refs `useProject` keeps, extracted as a plain value so the reconciliation
 * rules stay testable without a DOM.
 */
export interface UploadReconciliationState {
  /** The project document the editor currently bases its edits on. */
  document: ProjectDocumentV3;
  /** True when the editor holds unsaved changes. */
  dirty: boolean;
  /** Editor change counter; must stay stable when an upload is reconciled. */
  changeVersion: number;
}

export interface UploadConflictState {
  code: "project_revision_divergence";
  message: string;
  /** The diverging server document (same field shape as ProjectConflictState.current). */
  current: unknown;
}

export interface UploadReconciliationResult {
  /**
   * The project document the editor should adopt: the uploaded document when
   * applied, otherwise the unchanged previous document.
   */
  project: ProjectDocumentV3;
  dirty: boolean;
  changeVersion: number;
  /** True when `project` is the uploaded document. */
  applied: boolean;
  /** Non-null when the server has diverged from a locally edited base. */
  conflict: UploadConflictState | null;
}

/**
 * Decide how an asset-upload's returned project document merges into the
 * editor. Uploads register an asset and bump the durable revision server-side;
 * without this reconciliation the next editor autosave reuses the pre-upload
 * revision and gets a 409 conflict.
 *
 * Rules:
 * - Uploads for a different project than the editor's active one are ignored.
 * - Uploads at or behind the editor's known revision are ignored (stale echo).
 * - A clean editor adopts the uploaded document outright.
 * - A dirty editor keeps its unsaved changes on top of the uploaded revision
 *   (the caller re-projects its editor state and saves with the new revision).
 *   When the server revision jumps by more than one past a dirty base, someone
 *   else wrote in between; that divergence is surfaced instead of hidden.
 */
export function applyUploadReconciliation(
  state: UploadReconciliationState,
  uploaded: ProjectDocumentV3,
): UploadReconciliationResult {
  const noChange: UploadReconciliationResult = {
    project: state.document,
    dirty: state.dirty,
    changeVersion: state.changeVersion,
    applied: false,
    conflict: null,
  };

  if (uploaded.projectId !== state.document.projectId) {
    return noChange;
  }
  if (uploaded.revision <= state.document.revision) {
    return noChange;
  }

  const diverged = state.dirty && uploaded.revision > state.document.revision + 1;

  return {
    project: uploaded,
    dirty: state.dirty,
    changeVersion: state.changeVersion,
    applied: true,
    conflict: diverged
      ? {
          code: "project_revision_divergence",
          message:
            "The project changed on the server between your local edits and this upload. Reload to review the latest state before saving.",
          current: uploaded,
        }
      : null,
  };
}