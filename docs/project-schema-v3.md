# Project schema v3

VibeScreens separates the workspace registry from project content. The registry answers which app projects exist and which one is active. Publicly each project owns versions, decks, slides, selection, migration metadata, and revision. Schema v3 retains an internal `AppRecord` wrapper for backwards compatibility.

## Durable paths

```text
.vibescreens/
├── vibescreens.db
└── backups/

public/vibescreens-assets/
└── <projectId>/<internalAppId>/<versionId>/<kind>/<sha256>.<ext>
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

The registry contains project metadata and ordering only. It must not duplicate a project document's revision, active version/deck, or screenshot data.

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

## Internal App wrapper, version, and deck records

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

`AppRecord` and `selection.appId` are internal schema-v3 compatibility fields. The editor, CLI, and product hierarchy expose Project → Version → Deck → Slide. New projects use one wrapper whose display identity follows the project; callers do not create, rename, select, or delete Apps. During JSON-to-SQLite bootstrap, older multi-App v3 documents are split non-destructively into one Project per App while the source JSON remains untouched.

A published version requires `publishedAt` and a lowercase SHA-256 `contentHash`. Domain operations freeze published versions and reject further edits. Clone is the supported path back to an editable draft.

## Required invariants

Validation and normalization enforce these rules:

- Every order array contains every key in its matching map exactly once.
- A project contains at least one internal App wrapper; new public projects contain one.
- Every app contains at least one version.
- Every version contains at least one deck.
- Internal App names are unique within a project after normalization.
- Version names are unique within their internal wrapper after normalization.
- A version contains at most one deck for a device, orientation, and normalized locale tuple.
- Deck IDs match their map keys.
- Slide IDs are unique within a deck.
- `selection` references one valid internal app, version, deck, and optional slide chain.
- `sourceVersionId`, when present, points to a version in the same app.
- Unknown schemas above v3 are read-only.

The normalizer repairs order-array and selection drift when it can do so without discarding content. It does not invent missing apps, versions, or decks for an invalid v3 document.

## API ownership

- `GET /api/workspace` reads the registry and project summaries.
- `POST /api/workspace/actions` handles create, switch, rename, delete, and legacy import using workspace revision checks.
- `GET /api/project?projectId=<id>` reads one exact schema-v3 document.
- `PUT /api/project?projectId=<id>` saves a full document with `baseRevision`.
- `POST /api/project/actions?projectId=<id>` applies version and deck lifecycle commands with `baseRevision`; the service resolves the project's internal schema-v3 wrapper.
- Upload routes require validated `projectId`, internal `appId`, and `versionId`, then return scoped SHA-256 URLs and the reconciled project revision.

Write routes retain cross-site write protection and explicit body-size and MIME validation. Routes call repository and domain functions; they do not construct arbitrary filesystem paths.

A stale workspace or project revision returns `409` with current metadata. The server never merges two full JSON documents silently.

## Atomic writes

Project documents and the workspace registry live in SQLite. Create, rename, delete/trash, and legacy import change the project and workspace rows inside one `BEGIN IMMEDIATE` transaction with revision compare-and-swap checks. Any failed statement rolls the whole operation back, so no registered project can point at a missing row and no project row can be committed without its workspace entry.

Managed files use content-addressed SHA-256 paths and temporary-file rename. A canonical file may be shared by concurrent imports of identical bytes. A failed project save therefore never unlinks that canonical path: another successful transaction may already reference it. Version deletion first renames its asset directory out of the live URL before committing; failed physical cleanup is reported as deferred garbage instead of leaving old URLs reachable. Other unreferenced files are safe to reclaim only with a later registry-based mark-and-sweep plus a grace period, not synchronous rollback deletion.

## Export manifest v2

ZIP exports contain `manifest.json` with `schemaVersion: 2`. The public archive model is Project → Version → Deck → Slide: paths start at `versions/`, manifest scopes carry `versionIds`, and neither the manifest nor version metadata exposes internal `AppRecord` identifiers. The render plan may still use the schema-v3 wrapper in memory, but it is not serialized into the public bundle.

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
8. Insert the project and update the workspace row in one SQLite transaction.
9. Leave both root legacy files untouched.

Running the same migration against the same source must produce the same converted content. Unsupported non-empty fields stop automatic commit rather than being dropped.

## Cache and selection ownership

- The SQLite workspace row owns `activeProjectId`.
- The SQLite project row owns selected version, deck, optional slide, and the internal compatibility `appId`.
- Component state owns temporary UI details such as an open dialog, selected inspector element, or export progress.
- `localStorage` is a cache keyed by project and revision. It is never the durable authority.

The editor remains mounted while any durable selection changes. Pending saves flush before switching context. A failed flush keeps the old context visible.
