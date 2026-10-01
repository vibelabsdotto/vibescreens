---
name: vibescreens
description: Use when operating VibeScreens via its editor or CLI. Validated domain commands for projects, versions, decks, slides, assets, and exports.
version: 3.0.0
author: Max Mannstein, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [app-store, screenshots, marketing, nextjs, cli]
---

# VibeScreens

Build and operate the VibeScreens Next.js editor for Apple App Store, Google Play, and Microsoft Store marketing screenshots. Use the editor for visual review and export; use its TypeScript CLI for durable mutations.

## When to Use

Use this skill when the user asks to:

- create or revise app-store screenshots;
- manage VibeScreens projects, releases, device decks, slides, or locales;
- add screenshot copy or source captures;
- migrate an older VibeScreens workspace;
- generate store-ready PNG bundles.

Do not hand-build a replacement `page.tsx`, write `.vibescreens/vibescreens.db`, or serialize internal TypeScript project types.

## Core Principle

**Screenshots are advertisements, not documentation.** Each slide should sell one outcome, feeling, or resolved pain point. UI captures support that message; they are not the message.

## Prerequisites

- Node.js 22.5 or newer
- npm, pnpm, yarn, or bun
- A VibeScreens runtime checkout
- Source screenshots and app icon when the user has them

A new standalone editor can start from the VibeScreens repository. Do not overwrite an existing application checkout to scaffold it. Use a separate folder unless the user explicitly asks for in-place integration.

## CLI Contract

From the VibeScreens runtime root, inspect the live command index first:

```bash
npm run cli -- --help
```

Commands emit JSON on stdout and structured errors on stderr. Exit code `0` means success, `1` means a domain/storage failure, and `2` means invalid arguments. Optional `--project`, `--version`, and `--deck` flags override the saved active selection. Slide and element mutations require an explicit `--slide` target.

The CLI resolves revisions and routes writes through domain services. Never compensate for a missing command by editing SQLite, old JSON files, or `src/lib` data structures. Public navigation is Project → Version → Deck → Slide; schema v3's `AppRecord` wrapper is internal compatibility state.

## Quick Reference

### Workspace and projects

```bash
npm run cli -- workspace show
npm run cli -- workspace import
npm run cli -- project list
npm run cli -- project import --source /path/to/legacy-screenshot-editor
npm run cli -- project show --project prj_...
npm run cli -- project create --name "My App"
npm run cli -- project select --project prj_...
npm run cli -- project rename --project prj_... --name "New Name"
npm run cli -- project delete --project prj_...
```

### Versions

```bash
npm run cli -- version list
npm run cli -- version create --name "2.0" --locale en
npm run cli -- version clone --version ver_... --name "2.1"
npm run cli -- version select --version ver_...
npm run cli -- version rename --version ver_... --name "2.1 Spring"
npm run cli -- version publish --version ver_...
npm run cli -- version delete --version ver_...
```

There are no public `app ...` commands and no `--app` flag. Create one project per advertised app; the CLI resolves the internal schema-v3 wrapper itself.

### Decks and locales

```bash
npm run cli -- deck list
npm run cli -- deck create --device iphone --orientation portrait --locale de
npm run cli -- deck select --deck deck_...
npm run cli -- deck update --deck deck_... --theme clean-light --connected-canvas true
npm run cli -- deck reset --deck deck_...
npm run cli -- deck delete --deck deck_...
```

A deck is one unique device, orientation, and locale tuple. Add a German language target with `deck create --locale de`; do not mutate the locale of an unrelated deck unless the user wants to replace that tuple.

### Slides

```bash
npm run cli -- slide list
npm run cli -- slide add --headline "Plan faster" --label "FOCUS" --layout hero
npm run cli -- slide duplicate --slide slide-...
npm run cli -- slide reorder --slide slide-... --index 0
npm run cli -- slide update --slide slide-... --headline "Ship faster" --inverted true --background '#111827' --headline-scale 1.1
npm run cli -- slide delete --slide slide-...
```

Supported layouts are `hero`, `device-bottom`, `device-top`, `two-devices`, `no-device`, `split-landscape`, and `feature-graphic`. Text flags write to the selected deck's locale.

### Built-in, text, and image elements

```bash
npm run cli -- element list --slide slide-...
npm run cli -- element update --slide slide-... --element device --x 90 --y 240 --width 680 --height 1360 --rotation -4 --z-index 2
npm run cli -- element add --slide slide-... --type text --id proof --text "No spreadsheet required" --font-size 48 --font-weight 700
npm run cli -- element update --slide slide-... --element proof --text "No setup required" --color '#ffffff'
npm run cli -- element add --slide slide-... --type image --id badge --src /vibescreens-assets/.../badge.png --fit contain --fade-edge right --fade-amount 35
npm run cli -- element reorder --slide slide-... --element badge --position front
npm run cli -- element delete --slide slide-... --element badge
```

Transform widths and heights must be positive. Image fade amounts use the editor's `1..100` scale.

### Assets

Create the slide first, then import and attach its source capture atomically:

```bash
npm run cli -- asset import \
  --file ./captures/home.png \
  --kind screenshot \
  --slide slide-... \
  --field screenshot
```

Other attachment forms:

```bash
npm run cli -- asset import --file ./captures/detail.jpg --kind screenshot --slide slide-... --field screenshot-secondary
npm run cli -- asset import --file ./art/badge.png --kind image --slide slide-... --field image --x 80 --y 120 --width 320 --height 320
npm run cli -- asset import --file ./app-icon.png --kind app-icon --field app-icon
npm run cli -- asset import --file ./Brand.woff2 --kind font --field font
npm run cli -- asset list
```

Image assets accept PNG/JPEG with magic-byte validation. Fonts accept WOFF2, WOFF, TTF, and OTF. The command stores bytes by SHA-256, registers the asset, and attaches it in one revisioned mutation.

Re-import an image with the same `--element-id` to replace that element's source without creating a duplicate. Add `--rotation` and `--z-index` to set its full editor transform during import.

### Export

```bash
npm run cli -- export plan --scope current
npm run cli -- export plan --scope selected --versions ver_a,ver_b
npm run cli -- export bundle --scope current --output ./exports/current.zip
npm run cli -- export bundle --scope all --include-drafts true --output ./exports/all.zip --url http://127.0.0.1:8010
```

`export plan` is read-only and reports manifest, jobs, and preflight errors. `export bundle` drives the existing editor export UI in headless Chrome, captures the same downloaded ZIP, verifies the project revision, scope, `manifest.json`, and PNG count, then publishes it to `--output` without overwriting a competing file. The target project must be active in the editor server. The default URL is `http://127.0.0.1:8010`; the CLI never starts the server. The editor flushes pending saves and freezes the accepted durable project revision. Finish edits before running the CLI; a concurrent save correctly invalidates its previously frozen plan.

### Transparent marketing exports (editor)

Use the left arrow beside **Export bundle** → **Device frames only**. Select current, selected, or all published versions, then **Review export** → **Export device frames**. The main button always retains the full store-screen export; this marketing mode is currently editor-only, not a CLI flag.

Marketing bundles contain one transparent PNG per populated device, not per App Store size. Both devices on a two-device slide export independently; secondary screenshots use the editor's primary-image fallback. Preserve designed dimensions and rotation, include the full frame even when clipped or spanning screens, and leave room for frame shadows. Exclude backgrounds, text, app icons, image overlays, empty devices, and feature graphics. The ZIP preserves version/device/locale directories and a matching manifest; exports do not mutate the project or selection.

When verifying this renderer, inspect a real downloaded ZIP: PNG count must match the manifest, each PNG needs both transparent and opaque pixels, and nontransparent bounds must not touch the image edges. Use only each job's screenshot and required frame assets; an unrelated missing font or overlay must not block a marketing export, while a missing screenshot/frame must prevent download. Wait for dropdown animations to finish before taking visual proof, otherwise a correct opaque menu can appear translucent mid-animation.

Include a published version with both a populated and an empty device in renderer verification. The populated frames must survive; published content-hash failures must still block export. Close a pending review and reopen another export mode: the old result must never enable the new mode's download.

## Procedure

1. **Probe the current folder.** Confirm `package.json`, the VibeScreens scripts, Git status, and whether `.vibescreens/`, root `vibescreens.json`, or `app-store-screenshots.json` exists. Do not print entire databases or user content.
2. **Install and verify.** Install dependencies with the repo's package manager, then run `npm run cli -- --help`. Stop if Node is older than 22.5.
3. **Migrate safely.** `workspace show` imports the previous `.vibescreens/workspace.json` plus registered schema-v3 project JSON files when the SQLite database is empty. Use `workspace import` for a root legacy `vibescreens.json` or `app-store-screenshots.json` in an empty workspace. Use `project import --source /path/to/legacy-editor` to add a legacy v0-v2 folder to an existing workspace. It copies referenced assets into the destination and leaves the source untouched; duplicate documents and unresolved assets fail instead of overwriting projects. If replacing an older project, verify the imported project first, then delete only the explicitly authorized old project by ID. Original JSON and migration backups remain untouched.
4. **Inspect before mutating.** Run `workspace show`, then list the target versions, decks, slides, elements, and assets. Use returned IDs exactly.
5. **Collect the creative brief.** Confirm app outcome, audience, priority features, stores, devices, locales, slide count, visual direction, and source assets. If these were already provided, do not ask again.
6. **Build the hierarchy through CLI commands.** Create or select the project, draft version, and one deck per requested device/orientation/locale tuple.
7. **Write ad-oriented slides.** Use short copy, one outcome per slide, varied layouts, and clear thumbnail hierarchy. Add and update slides through the CLI.
8. **Attach assets through the CLI.** Never copy an uploaded file into an arbitrary managed path and never insert asset registry rows manually.
9. **Review in the editor.** Reuse the existing dev server. If none is running, obtain permission before starting `npm run dev` from the runtime root. Open `http://127.0.0.1:8010` and verify `/api/workspace` responds. Check every deck, connected-canvas boundary, text fit, RTL behavior, and source-image crop. Keep machine-specific paths and profile setup in the operator's local skill, not this repository guide.
10. **Verify.** Run tests, typecheck, and build. Run `export plan`, then create and inspect a proof ZIP through `export bundle` before publishing a version.

## Legacy and Recovery Rules

- `.vibescreens/vibescreens.db` is authoritative after migration.
- Previous `.vibescreens/workspace.json` and project JSON files are one-time import sources and remain rollback material.
- Root legacy files remain unchanged after import; exact backups live under `.vibescreens/backups/`.
- A schema newer than the runtime supports is read-only. Never downgrade it.
- Preserve `public/vibescreens-assets/` and all old screenshot sources.
- Published versions are immutable. Clone one into a draft before changing it.

## Design Guardrails

- One clear promise per slide
- Headlines readable at thumbnail size
- Layout rhythm across adjacent slides
- Critical text and UI stay inside export-safe crop bounds
- Connected-canvas elements still produce useful individual exports
- RTL locales receive intentional alignment and composition
- Platform frames and export sizes match the target store

## Pitfalls

- **Direct persistence edits:** bypass revision checks and can corrupt workspace/project relationships.
- **Inventing an App layer:** a project is the app. Do not look for an App picker or pass internal `appId` values to the CLI.
- **Missing locale choice:** create/select a locale deck; the toolbar always exposes English and German plus existing locales.
- **Unattached assets:** asset import validates the target, transform, magic bytes, and attachment before storing bytes. Canonical content-addressed files are never synchronously deleted after a save conflict because a concurrent successful import may reference them.
- **External legacy assets:** keep local source files inside the source folder's `public` tree without symlink components. External imports read and validate all sources before copying any assets; unresolved or unsafe sources reject the import. Do not bypass this with raw workspace writes.
- **Published-version writes:** clone first; do not work around the lock.
- **`localStorage` confusion:** it is a UI cache, never durable authority.
- **Starting duplicate servers:** `export bundle` requires the existing editor server; check port `8010` rather than launching another process.

## Verification

Before reporting completion:

```bash
npm test
npm run typecheck
npm run build
npm run cli -- --help
npm run cli -- workspace show
npm run cli -- slide list
npm run cli -- export plan --scope current
```

Then verify the editor loads with Project and Version selectors only, locale selection creates or selects the intended deck, uploaded assets render, custom slide backgrounds render, and `export bundle` produces a ZIP whose manifest and PNG count match the plan.
