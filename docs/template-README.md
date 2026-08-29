# VibeScreens editor

A Next.js 16 editor for App Store, Microsoft Store, and Google Play screenshots. This is the editor README — it lives at the repository root of a scaffolded VibeScreens project. See the main [README](../README.md) for install and usage.

## Requirements

- Node.js 20.9+
- bun, pnpm, yarn, or npm

## Quick start

```bash
bun install   # or pnpm / yarn / npm
bun dev       # http://localhost:3000
```

Start the dev server once. Project, app, version, and deck changes happen inside the running editor.

## Workspace model

```text
WorkspaceRegistryV1
└── ProjectDocumentV3
    └── AppRecord
        └── VersionRecord
            └── DeckRecord
                └── Slide
```

- `.vibescreens/workspace.json` lists projects, keeps their order, and stores `activeProjectId`.
- `.vibescreens/projects/<projectId>/vibescreens.json` stores one complete schema-v3 project and owns its numeric revision.
- Each project has one or more apps. Each app has one or more named versions.
- Each version owns device, orientation, and locale decks. Each deck owns its slides and render settings.
- Draft versions are editable. Published versions are read-only; clone one to start the next draft.
- `localStorage` is a cache. The project document remains the durable source of truth.

A VibeScreens version is a screenshot release, not a Git branch. The editor switches versions without changing branches, routes, or processes.

## Durable files

```text
.vibescreens/
├── workspace.json
├── projects/<projectId>/vibescreens.json
├── backups/
└── trash/

public/vibescreens-assets/
└── <projectId>/<appId>/<versionId>/<kind>/<sha256>.<ext>
```

The API derives every path from validated IDs. Uploads never use a user-provided path segment. Project writes use revision checks and atomic replacement, so a stale browser tab gets `409` instead of overwriting a newer revision.

Commit `workspace.json`, active project documents, and the version assets needed to reproduce exports. Keep temporary writes, trash, local exports, and migration backups out of normal commits.

## Legacy import

If no workspace registry exists, import checks root `vibescreens.json` first and `app-store-screenshots.json` only when the preferred file is absent. The importer:

1. Reads the schema from content rather than the filename.
2. Backs up and hashes the source.
3. Converts v0/v1 to normalized v2, then v2 to one schema-v3 project with one app and one draft version.
4. Materializes device and locale combinations as decks.
5. Copies referenced files into the scoped asset tree.
6. Writes `vibescreens.json` before adding the project to `workspace.json`.
7. Leaves the root legacy file untouched for rollback.

A schema newer than v3 opens read-only. The editor never downgrades or overwrites it.

## What's inside

- **Connected canvas editor** (`src/components/editor/`) puts every screen in a deck on one horizontal canvas. Devices and decorative elements can cross screen boundaries and export as split crops.
- **Isolated mode** protects imported decks whose offscreen elements must not appear in adjacent crops.
- **Project, app, and version controls** change the active context without reloading the page.
- **Screen controls** reorder slides, edit copy, replace screenshots, and change per-slide layouts.
- **Image overlays** add, upload, replace, drag, resize, rotate, layer, crop, and fade PNG/JPG elements. See [Image elements](image-elements.md).
- **Edit history** keeps up to 25 changes for the active draft version. See [Edit history](edit-history.md).
- **Themes, fonts, and backgrounds** change deck and slide presentation. See [Themes](themes.md), [Screenshot fonts](screenshot-fonts.md), and [Background controls](background-controls.md).
- **Device frames** (`src/components/editor/device-frames.tsx`) cover iPhone, iPad, Apple TV, Apple Watch, CarPlay, Android phone and tablets, macOS, Windows, and Play Store feature graphics.

## Further reading

- [Apps and versions](apps-and-versions.md) explains draft, publish, clone, asset ownership, and recovery workflows.
- [Project schema v3](project-schema-v3.md) documents the workspace registry, project document, invariants, paths, API ownership, and migration rules.
