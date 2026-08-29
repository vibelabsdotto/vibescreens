# Project schema v3

VibeScreens separates the workspace registry from project content. The registry answers which projects exist and which one is active. Each project document owns its apps, versions, decks, slides, selection, migration metadata, and revision.

## Durable paths

```text
.vibescreens/
├── workspace.json
├── projects/
│   └── <projectId>/
│       └── vibescreens.json
├── backups/
└── trash/

public/vibescreens-assets/
└── <projectId>/<appId>/<versionId>/<kind>/<sha256>.<ext>
```

All IDs come from the server or domain factories. API callers do not provide path segments. The path layer rejects invalid IDs, absolute paths, separators, and `..` traversal.

## Workspace registry v1

```ts
type WorkspaceRegistryV1 = {
  schemaVersion: 1;
  revision: number;
  activeProjectId: ProjectId | null;
  projectOrder: ProjectId[];
  projectsById: Record<ProjectId, {
    id: ProjectId;
    name: string;
    slug: string;
    createdAt: string;
    updatedAt: string;
  }>;
};
```

The registry contains project metadata and ordering only. It must not duplicate a project document's revision, active app/version/deck, or screenshot data.

Workspace actions create, switch, rename, import, or delete projects. Workspace revision checks protect concurrent registry changes.

## Project document v3

```ts
type ProjectDocumentV3 = {
  schemaVersion: 3;
  projectId: ProjectId;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  appOrder: AppId[];
  appsById: Record<AppId, AppRecord>;
  assetsById: Record<AssetId, AssetRef>;
  selection: {
    appId: AppId;
    versionId: VersionId;
    deckId: DeckId;
    slideId?: string;
  };
  migration?: {
    from: 0 | 1 | 2;
    migratedAt: string;
    backupPath: string;
    warnings: string[];
    sourceFile: "vibescreens.json" | "app-store-screenshots.json";
    sourceSha256: string;
  };
};
```

The project document is the only owner of its numeric revision. Each successful project mutation increments that revision once. Workspace metadata changes do not stand in for a project revision.

## App, version, and deck records

```ts
type AppRecord = {
  id: AppId;
  name: string;
  createdAt: string;
  updatedAt: string;
  versionOrder: VersionId[];
  versionsById: Record<VersionId, VersionRecord>;
};

type VersionRecord = {
  id: VersionId;
  name: string;
  status: "draft" | "published";
  sourceVersionId?: VersionId;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  contentHash?: string;
  deckOrder: DeckId[];
  decksById: Record<DeckId, DeckRecord>;
};

type DeckRecord = {
  id: DeckId;
  device: Device;
  orientation: "portrait" | "landscape";
  locale: string;
  connectedCanvas: boolean;
  appName: string;
  themeId: string;
  fontId: string;
  importedFont?: ImportedFont;
  appIcon: string;
  crossScreenMockups?: string[];
  slides: Slide[];
};
```

A published version requires `publishedAt` and a lowercase SHA-256 `contentHash`. Domain operations freeze published versions and reject further edits. Clone is the supported path back to an editable draft.

## Required invariants

Validation and normalization enforce these rules:

- Every order array contains every key in its matching map exactly once.
- A project contains at least one app.
- Every app contains at least one version.
- Every version contains at least one deck.
- App names are unique within a project after normalization.
- Version names are unique within an app after normalization.
- A version contains at most one deck for a device, orientation, and normalized locale tuple.
- Deck IDs match their map keys.
- Slide IDs are unique within a deck.
- `selection` references one valid app, version, deck, and optional slide chain.
- `sourceVersionId`, when present, points to a version in the same app.
- Unknown schemas above v3 are read-only.

The normalizer repairs order-array and selection drift when it can do so without discarding content. It does not invent missing apps, versions, or decks for an invalid v3 document.

## API ownership

- `GET /api/workspace` reads the registry and project summaries.
- `POST /api/workspace/actions` handles create, switch, rename, delete, and legacy import using workspace revision checks.
- `GET /api/project?projectId=<id>` reads one exact schema-v3 document.
- `PUT /api/project?projectId=<id>` saves a full document with `baseRevision`.
- `POST /api/project/actions?projectId=<id>` applies app, version, and deck lifecycle commands with `baseRevision`.
- Upload routes require validated `projectId`, `appId`, and `versionId`, then return scoped SHA-256 URLs.

Write routes retain cross-site write protection and explicit body-size and MIME validation. Routes call repository and domain functions; they do not construct arbitrary filesystem paths.

A stale workspace or project revision returns `409` with current metadata. The server never merges two full JSON documents silently.

## Atomic writes

JSON and asset writes follow the same basic rule:

1. Validate IDs, schema, revision, and operation.
2. Serialize mutations for the target path.
3. Write a temporary file in the destination filesystem.
4. Flush the file.
5. Rename it over the destination.
6. Clean temporary files on failure.

For legacy import, write and validate the project document before registering it in `workspace.json`. That ordering prevents a registry entry from pointing at a partial project.

## Legacy migration

Import chooses root `vibescreens.json` when present. It checks `app-store-screenshots.json` only when the preferred file is absent. The filename does not decide the schema.

The migration chain is `v0/v1 -> normalized v2 -> v3`:

1. Back up and hash the selected source.
2. Preserve a legacy `connectedCanvas` value; default missing values to `false`.
3. Create one project, one app, and one draft version.
4. Materialize device, orientation, and locale combinations as decks.
5. Preserve slide order, copy, render settings, and recoverable custom theme IDs.
6. Copy and hash referenced screenshots, image elements, app icons, and fonts into the scoped asset tree.
7. Record warnings for missing files. Missing or external assets may remain in a draft but block publication.
8. Atomically write `vibescreens.json`, then update `workspace.json`.
9. Leave both root legacy files untouched.

Running the same migration against the same source must produce the same converted content. Unsupported non-empty fields stop automatic commit rather than being dropped.

## Cache and selection ownership

- `workspace.json` owns `activeProjectId`.
- `vibescreens.json` owns selected app, version, deck, and optional slide.
- Component state owns temporary UI details such as an open dialog, selected inspector element, or export progress.
- `localStorage` is a cache keyed by project and revision. It is never the durable authority.

The editor remains mounted while any durable selection changes. Pending saves flush before switching context. A failed flush keeps the old context visible.
