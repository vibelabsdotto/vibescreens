import { describe, expect, it } from "vitest";

import type { AppId, DeckId, VersionId } from "../ids";
import type { ProjectDocumentV3 } from "../project-schema";
import type { ProjectId } from "../workspace";
import {
  applyUploadReconciliation,
  type UploadReconciliationState,
} from "../upload-reconcile";

const projectId = "prj_upload" as ProjectId;
const appId = "app_upload" as AppId;
const versionId = "ver_upload" as VersionId;
const deckId = "deck_upload" as DeckId;
const now = "2026-08-28T10:00:00.000Z";

function makeDocument(overrides: Partial<ProjectDocumentV3> = {}): ProjectDocumentV3 {
  return {
    schemaVersion: 3,
    projectId,
    name: "Upload Project",
    revision: 7,
    createdAt: now,
    updatedAt: now,
    appOrder: [appId],
    appsById: {
      [appId]: {
        id: appId,
        name: "Upload App",
        createdAt: now,
        updatedAt: now,
        versionOrder: [versionId],
        versionsById: {
          [versionId]: {
            id: versionId,
            name: "Draft 1",
            status: "draft",
            createdAt: now,
            updatedAt: now,
            deckOrder: [deckId],
            decksById: {
              [deckId]: {
                id: deckId,
                device: "iphone",
                orientation: "portrait",
                locale: "en",
                connectedCanvas: false,
                appName: "Upload App",
                themeId: "clean-light",
                fontId: "system-sans",
                appIcon: "",
                slides: [],
              },
            },
          },
        },
      },
    },
    assetsById: {},
    selection: { appId, versionId, deckId },
    ...overrides,
  };
}

function editedState(): UploadReconciliationState {
  return {
    document: makeDocument(),
    dirty: true,
    changeVersion: 3,
  };
}

describe("upload reconciliation", () => {
  it("adopts the uploaded revision while preserving local unsaved edits", () => {
    const uploaded = makeDocument({ revision: 8 });
    const state = editedState();

    const result = applyUploadReconciliation(state, uploaded);

    expect(result.project).toBe(uploaded);
    expect(result.project.revision).toBe(8);
    expect(result.dirty).toBe(true);
    expect(result.changeVersion).toBe(3);
    expect(result.applied).toBe(true);
    expect(result.conflict).toBeNull();
  });

  it("ignores uploads for a switched-away project instead of clobbering state", () => {
    const uploaded = makeDocument({ revision: 8 });
    const state = {
      ...editedState(),
      document: makeDocument({ projectId: "prj_other" as ProjectId }),
    };

    const result = applyUploadReconciliation(state, uploaded);

    expect(result.applied).toBe(false);
    expect(result.project).toBe(state.document);
    expect(result.dirty).toBe(true);
  });

  it("ignores uploads whose revision is not ahead of the known base", () => {
    const state = editedState();
    const stale = makeDocument({ revision: 7 });
    const result = applyUploadReconciliation(state, stale);

    expect(result.applied).toBe(false);
    expect(result.project).toBe(state.document);
  });

  it("reports a conflict only when the server has moved past a locally edited base", () => {
    // Server revision 9 while the editor's base is 7 and dirty: a plain adopt
    // would silently drop whoever wrote revision 8. The reconciliation must
    // surface the divergence instead of silently choosing a side.
    const remote = makeDocument({ revision: 9 });
    const result = applyUploadReconciliation(editedState(), remote);

    expect(result.applied).toBe(true);
    expect(result.conflict).not.toBeNull();
    expect(result.conflict?.code).toBe("project_revision_divergence");
    expect(result.dirty).toBe(true);
  });

  it("adopts a clean (non-dirty) upload without flagging unsaved edits", () => {
    const uploaded = makeDocument({ revision: 8 });
    const state: UploadReconciliationState = {
      document: makeDocument(),
      dirty: false,
      changeVersion: 0,
    };

    const result = applyUploadReconciliation(state, uploaded);

    expect(result.applied).toBe(true);
    expect(result.dirty).toBe(false);
    expect(result.conflict).toBeNull();
  });
});