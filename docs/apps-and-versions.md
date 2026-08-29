# Apps and versions

One VibeScreens runtime can hold several projects. Each project can hold several apps, and each app can hold several named screenshot versions.

## Hierarchy

```text
workspace
└── project
    └── app
        └── version
            └── deck
                └── slide
```

A project is an organizational boundary and a separate revisioned document. An app groups screenshot releases for one product. A version is a complete named screenshot release. A deck is one device, orientation, and locale combination.

Versions are not Git branches. Switching versions never changes the checkout or restarts the advertised app. Git can track durable VibeScreens documents and assets, but it does not provide the app/version model.

## Draft and published versions

New versions start as drafts. A draft can change its name, decks, slides, themes, fonts, and assets.

Publishing locks the version. The publish operation records a timestamp and SHA-256 content hash. Published versions reject content edits, renames, uploads, replacements, and deck changes. This rule belongs to the domain and API, not only the UI.

To revise a published release:

1. Clone the published version.
2. Give the clone a unique name within the app.
3. Edit the new draft.
4. Review its decks and assets.
5. Publish it when the screenshot release is final.

A clone gets a new version ID and `sourceVersionId` provenance. Its assets are copied into the new version's asset directory. It never shares mutable files with the source.

## App operations

- **Create.** A new app starts with one draft version and at least one deck.
- **Rename.** Changes the display name, not the app ID or asset paths.
- **Delete.** Requires an explicit action and cannot remove the last app in a project.
- **Switch.** Updates the project selection after any pending save succeeds.

App names are unique within a project after trimming, Unicode normalization, and case folding.

## Version operations

- **Create.** Adds an empty or starter draft to an app.
- **Clone.** Copies a draft or published version into a new draft.
- **Rename.** Allowed only for drafts.
- **Publish.** Locks a draft and records its publication metadata.
- **Delete.** Cannot remove the last version in an app. If another version lists the deleted version as its source, the source reference is cleared.
- **Switch.** Selects a valid deck and slide in the target version. No page reload is required.

Version names are unique within their app after normalization.

## Decks and locales

A version owns ordered decks. The tuple of device, orientation, and locale must be unique inside that version. The editor never creates a second deck with the same tuple.

If a requested tuple does not exist, create a deck explicitly. Do not inject starter slides into a different deck without the user's approval. Deleting a locale or changing a toolbar selection must not silently delete a deck.

A version must keep at least one deck. Selection always points to an app, version, deck, and optional slide in the same chain.

## Assets

Uploaded screenshots, image elements, and fonts live under:

```text
public/vibescreens-assets/<projectId>/<appId>/<versionId>/<kind>/<sha256>.<ext>
```

The server validates generated IDs, hashes bytes with SHA-256, derives the final path, and writes through a temporary file before rename. The client stores returned URLs. It never supplies a destination path.

Asset directories make version ownership explicit:

- Renaming a project, app, or version does not break URLs.
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

1. Stop before adding the project to `workspace.json`.
2. Keep the backup and original source.
3. Remove only incomplete staging files.
4. Report missing assets or unsupported fields.
5. Retry after the source problem is fixed.

If a project is deleted, it moves to workspace trash before its registry entry disappears. Restore the directory and metadata before editing it again. Do not copy a trashed `vibescreens.json` over a live project with a newer revision.

A project with `schemaVersion > 3` opens read-only. Use a newer VibeScreens version rather than downgrading the file.

## Reproducible handoff

For a clean-clone handoff, commit:

- `.vibescreens/workspace.json`
- `.vibescreens/projects/<projectId>/vibescreens.json` for each shared project
- every asset under `public/vibescreens-assets/` referenced by those documents
- any custom theme code required by the decks

Do not commit temporary writes, trash, local export bundles, or migration backups unless a recovery task specifically needs them.
