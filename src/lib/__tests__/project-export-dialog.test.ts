import { describe, expect, it } from "vitest";

import {
  exportVersionOptionId,
  listProjectExportVersionOptions,
  resolveProjectExportScope,
} from "../project-export-client";
import type { AppId, DeckId, VersionId } from "../ids";
import type {
  AppRecord,
  ProjectDocumentV3,
  VersionRecord,
} from "../project-schema";

const appA = "app_a11111111" as AppId;
const appB = "app_b22222222" as AppId;
const versionADraft = "ver_a_draft11" as VersionId;
const versionAPublished = "ver_a_pub111" as VersionId;
const versionBPublished = "ver_b_pub222" as VersionId;
const deckId = "deck_test111" as DeckId;

function version(
  id: VersionId,
  name: string,
  status: VersionRecord["status"],
): VersionRecord {
  return {
    id,
    name,
    status,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    deckOrder: [deckId],
    decksById: {} as VersionRecord["decksById"],
  };
}

function app(
  id: AppId,
  name: string,
  versions: readonly VersionRecord[],
): AppRecord {
  return {
    id,
    name,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    versionOrder: versions.map((entry) => entry.id),
    versionsById: Object.fromEntries(
      versions.map((entry) => [entry.id, entry]),
    ) as AppRecord["versionsById"],
  };
}

function document(): ProjectDocumentV3 {
  const first = app(appA, "Alpha", [
    version(versionAPublished, "Launch", "published"),
    version(versionADraft, "Next", "draft"),
  ]);
  const second = app(appB, "Beta", [
    version(versionBPublished, "Stable", "published"),
  ]);
  return {
    schemaVersion: 3,
    projectId: "prj_export_dialog" as ProjectDocumentV3["projectId"],
    name: "Exports",
    revision: 1,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    appOrder: [appB, appA],
    appsById: {
      [appA]: first,
      [appB]: second,
    } as ProjectDocumentV3["appsById"],
    assetsById: {},
    selection: {
      appId: appA,
      versionId: versionADraft,
      deckId,
    },
  };
}

describe("project export dialog scope selection", () => {
  it("resolves the current scope without changing the selected document version", () => {
    expect(
      resolveProjectExportScope(document(), {
        kind: "current",
        selectedVersionOptionIds: [],
        includeDrafts: true,
      }),
    ).toEqual({ kind: "current" });
  });

  it("resolves selected refs in document order with stable IDs and no duplicates", () => {
    const project = document();
    const options = listProjectExportVersionOptions(project);

    expect(options.map((entry) => [entry.id, entry.appName, entry.versionName, entry.status])).toEqual([
      [exportVersionOptionId(appB, versionBPublished), "Beta", "Stable", "published"],
      [exportVersionOptionId(appA, versionAPublished), "Alpha", "Launch", "published"],
      [exportVersionOptionId(appA, versionADraft), "Alpha", "Next", "draft"],
    ]);

    expect(
      resolveProjectExportScope(project, {
        kind: "selected",
        selectedVersionOptionIds: [
          exportVersionOptionId(appA, versionADraft),
          exportVersionOptionId(appB, versionBPublished),
          exportVersionOptionId(appA, versionADraft),
        ],
        includeDrafts: false,
      }),
    ).toEqual({
      kind: "selected",
      versions: [
        { appId: appB, versionId: versionBPublished },
        { appId: appA, versionId: versionADraft },
      ],
    });
  });

  it("rejects an empty selected scope", () => {
    expect(() =>
      resolveProjectExportScope(document(), {
        kind: "selected",
        selectedVersionOptionIds: [],
        includeDrafts: false,
      }),
    ).toThrow("Select at least one version to export");
  });

  it("keeps all published-only by default and includes drafts only explicitly", () => {
    expect(
      resolveProjectExportScope(document(), {
        kind: "all",
        selectedVersionOptionIds: [],
        includeDrafts: false,
      }),
    ).toEqual({ kind: "all" });
    expect(
      resolveProjectExportScope(document(), {
        kind: "all",
        selectedVersionOptionIds: [],
        includeDrafts: true,
      }),
    ).toEqual({ kind: "all", includeDrafts: true });
  });
});
