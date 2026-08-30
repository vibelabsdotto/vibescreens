# Projects and versions

One VibeScreens runtime can hold several projects. Each project is one app and owns several named screenshot versions.

## Hierarchy

```text
workspace
└── project
    └── version
        └── deck
            └── slide
```

A project is both the app/product boundary and a separate revisioned document. A version is a complete named screenshot release. A deck is one device, orientation, and locale combination.

Schema v3 still stores one `AppRecord` and an `appId` path segment internally. They are backwards-compatibility wrappers, not a second user-facing hierarchy. The editor and CLI expose Project → Version and never ask users or agents to create or select an App.

Versions are not Git branches. Switching versions never changes the checkout or restarts the advertised app. Git can track durable VibeScreens documents and assets, but it does not provide the project/version model.

## Draft and published versions

New versions start as drafts. A draft can change its name, decks, slides, themes, fonts, and assets.

Publishing locks the version. The publish operation records a timestamp and SHA-256 content hash. Published versions reject content edits, renames, uploads, replacements, and deck changes. This rule belongs to the domain and API, not only the UI.

To revise a published release:

1. Clone the published version.
2. Give the clone a unique name within the project.
3. Edit the new draft.
4. Review its decks and assets.
5. Publish it when the screenshot release is final.

A clone gets a new version ID and `sourceVersionId` provenance. Its assets are copied into the new version's asset directory. It never shares mutable files with the source.

## Version operations

- **Create.** Adds an empty or starter draft to a project.
- **Clone.** Copies a draft or published version into a new draft.
- **Rename.** Allowed only for drafts.
- **Publish.** Locks a draft and records its publication metadata.
- **Delete.** Cannot remove the last version in a project. If another version lists the deleted version as its source, the source reference is cleared.
- **Switch.** Selects a valid deck and slide in the target version. No page reload is required.

Version names are unique within their project after normalization.

## Decks and locales

A version owns ordered decks. The tuple of device, orientation, and locale must be unique inside that version. The editor never creates a second deck with the same tuple.

If a requested tuple does not exist, create a deck explicitly. Do not inject starter slides into a different deck without the user's approval. Deleting a locale or changing a toolbar selection must not silently delete a deck.

A version must keep at least one deck. Public selection is Project → Version → Deck → optional Slide; the schema also stores the internal compatibility `appId` in that chain.

## Assets

Uploaded screenshots, image elements, and fonts live under:

```text
public/vibescreens-assets/<projectId>/<internalAppId>/<versionId>/<kind>/<sha256>.<ext>
```

The server validates generated IDs, hashes bytes with SHA-256, derives the final path, and writes through a temporary file before rename. The client stores returned URLs. It never supplies a destination path.

Asset directories make version ownership explicit:

- Renaming a project or version does not break URLs.
- Deleting one project cannot remove another project's files.
- Cloning a version copies its files before the project document changes.
- A failed clone removes staging data and leaves the source unchanged.
- Published versions cannot receive new or replacement assets.

## Autosave and conflicts

Every project document owns one numeric `revision`. A write includes the revision it started from. A successful mutation increments that project revision. If another tab saved first, the stale write returns `409` and must not overwrite the newer document.

On conflict, keep the visible context, offer reload, and let the user preserve the unsaved draft as a copy. Never turn cached content into a published version. `localStorage` is only a cache keyed by project and revision.

## Backup and recovery

Legacy import is non-destructive. Before the first schema-v3 write, the importer stores an exact copy and SHA-256 of the selected legacy source under `.vibescreens/backups/`. Root `vibescreens.json` and `app-store-screenshots.json` files remain untouched.

If an import fails:

1. Stop before adding the project to SQLite.
2. Keep the backup and original source.
3. Remove only incomplete staging files.
4. Report missing assets or unsupported fields.
5. Retry after the source problem is fixed.

If a project is deleted, its complete document moves into the SQLite `project_trash` table before its workspace entry disappears. Do not restore it over a live project with a newer revision.

A project with `schemaVersion > 3` opens read-only. Use a newer VibeScreens version rather than downgrading the file.

## Reproducible handoff

Stop the editor/server before copying the database, then checkpoint SQLite (`PRAGMA wal_checkpoint(TRUNCATE)`) and verify `PRAGMA integrity_check = ok`. Copying only `vibescreens.db` while a process is still writing can omit committed WAL pages.

For a clean-clone handoff, commit:

- `.vibescreens/vibescreens.db`
- every asset under `public/vibescreens-assets/` referenced by those documents
- any custom theme code required by the decks

The repository ignores `.vibescreens/` by default because workspaces are normally local. Share the database only deliberately; do not commit WAL/SHM files, local export bundles, or migration backups.
