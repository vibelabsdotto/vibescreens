---
name: app-store-screenshots
description: Use when building App Store, Microsoft Store, or Google Play screenshot pages, generating exportable marketing screenshots for iOS, Android, macOS, and/or Windows apps, or scaffolding a screenshot editor with Next.js. Triggers on app store, play store, microsoft store, screenshots, marketing assets, html-to-image, device mockup, desktop screenshots, feature graphic.
---

# App Store & Google Play Screenshots Generator

## Overview

Scaffold a pre-built Next.js + ShadCN editor that lets the user design and export App Store **and** Google Play screenshots as **advertisements** (not UI showcases). The editor handles all the heavy lifting:

- Connected live preview at the canvas's true resolution (scaled to fit)
- Drag-to-reorder screens, inline text editing, layout switcher per screen
- Cross-screen mockups: phone/device frames, captions, and layered elements can be moved across adjacent screens, then exported as clipped crops
- Drop-target screenshot picker (file → saved to `public/screenshots/uploaded/<hash>.png`)
- Auto-save to **`app-store-screenshots.json`** at the project root (git-trackable) + `localStorage` mirror
- Easy iOS ↔ Android ↔ Desktop platform switch — separate slide decks live side by side
- One-click bulk PNG export at every Apple/Google-required resolution via `html-to-image`
- Light/dark variant toggle per slide, theme presets, locale select
- Per-slide custom background colors, live theme and font selection, and importing licensed WOFF2/WOFF/TTF/OTF fonts
- Image overlay elements with drag/resize/rotation/layering controls and directional edge fades
- Toolbar Undo/Redo with 25-step in-session history
- Guided in-place migration for older projects created by this skill; passive and explicit migrations keep legacy decks isolated until the user intentionally opts into connected canvas

Supported devices out of the box:
- **iPhone** (portrait) — Apple App Store
- **iPad** (portrait) — Apple App Store
- **Apple TV** (landscape) — Apple App Store
- **Apple Watch** (portrait) — Apple App Store
- **CarPlay** (landscape) — exports into an **iPhone** slot, see below
- **Android Phone** (portrait) — Google Play
- **Android Tablet 7"** (portrait + landscape) — Google Play
- **Android Tablet 10"** (portrait + landscape) — Google Play
- **Feature Graphic** (1024×500 banner) — Google Play store listing header
- **macOS** (16:10 desktop window) — Mac App Store and product listings
- **Windows** (16:9 desktop window) — Microsoft Store and product listings

## Core Principle

**Screenshots are advertisements, not documentation.** Every screenshot sells one idea. If you're showing UI, you're doing it wrong — you're selling a *feeling*, an *outcome*, or killing a *pain point*. Use this skill's interactive editor to iterate on copy and layout fast; do not hand-craft the page from scratch.

## What This Skill Does

1. **Copies a pre-built template** from `template/` (co-located with this `SKILL.md`) into the user's working directory.
2. Installs dependencies with the user's package manager.
3. Drops the user's screenshots into `public/screenshots/...` and their app icon into `public/`.
4. (Optionally) prefills `app-store-screenshots.json` with the user's app name, starting copy, screenshots, and connected-canvas preference so the first preview is meaningful.
5. Starts the dev server and tells the user to open the editor in the browser.

You should NOT write `page.tsx`, device frames, or export logic by hand. They live in the template.

## Step 0: Probe for Existing Screenshot Projects

Before asking the new-project questions in Step 1, always inspect the current working directory for an existing app-store-screenshots implementation.

Run lightweight probes:

```bash
test -f package.json && sed -n '1,220p' package.json
test -f app-store-screenshots.json && sed -n '1,120p' app-store-screenshots.json
rg -n "app-store-screenshots|html-to-image|toPng|ScreenshotEditor|DeckCanvas|connectedCanvas|EXPORT_SIZES|mockup.png|PHONE_SCREEN" package.json src app public 2>/dev/null
find public -maxdepth 4 \( -path "*/screenshots*" -o -name "mockup.png" -o -name "app-icon.png" \) -print 2>/dev/null
```

Treat the project as an older implementation when any of these are true:

- `app-store-screenshots.json` exists but has no `schemaVersion`, has `schemaVersion < 2`, or lacks `connectedCanvas`.
- `src/components/editor/screenshot-editor.tsx` exists but the editor does not reference `DeckCanvas` or `connectedCanvas`.
- `src/app/page.tsx` contains a previous all-in-one generator (`html-to-image`, `toPng`, `EXPORT_SIZES`, `PHONE_SCREEN`, hardcoded slide arrays/themes).
- The repo contains the old screenshot asset layout (`public/mockup.png`, `public/screenshots...`) plus a screenshot generator package setup.

If an older implementation is detected, ask exactly one question before doing anything else:

> I found an older App Store screenshots project here. Do you want me to migrate this existing project to the new connected-canvas editor?
>
> 1. Yes — migrate the existing project to the new editor
> 2. No — set up or modify a project another way

If the user chooses **Yes**, do **not** ask the Step 1 questionnaire. Run the migration path below using the files already in the repo. If the user chooses **No**, continue to Step 1.

### Migration Path (When User Says Yes)

The goal is an in-place UI/template upgrade, not a redesign. Preserve the user's existing app name, copy, screenshot paths, app icon, uploaded assets, locales, and device decks wherever they already exist. Replace the old UI implementation with the current template. Keep legacy decks in isolated export mode unless the project already explicitly opted into connected canvas.

Migration rules:

1. **Do not ask further product/design questions.** The user already has a project. Infer from existing files and report any non-blocking gaps at the end.
2. **Never delete user assets.** Preserve `public/screenshots/`, `public/app-icon.png`, uploaded screenshots, and any existing `app-store-screenshots.json`.
3. **Preserve recoverability.** If the worktree is not clean, do not revert unrelated changes. Before overwriting template files, copy replaced project-state/assets/code snapshots to a temporary backup outside the repo (for example `/tmp/app-store-screenshots-migration-<timestamp>/`) and mention the path in the final response.
4. **Prefer structured migration.** Read and write `app-store-screenshots.json` with JSON tooling. Do not regex-edit JSON.
5. **Set `schemaVersion: 2` and keep legacy `connectedCanvas` safe.** If the existing project already has an explicit boolean `connectedCanvas`, preserve it. If the project is pre-v2 or lacks the flag, write `"connectedCanvas": false` so offscreen/clipped legacy mockups do not leak into neighboring exports. New projects still default to connected canvas.
6. **Keep screenshots pointed at existing files.** Do not rename screenshot files unless the old project already depended on numeric names and the migration needs them. Existing static paths are fine.
7. **Handle custom themes without asking.** If the old project references a custom `themeId`, merge the matching theme object into the new `src/lib/constants.ts` when it can be found. If it cannot be recovered, leave the `themeId` in project JSON; the editor will fall back to `clean-light` and warn, and you should note that a custom theme needs manual restoration.
8. **Merge package metadata when possible.** The template's dependencies and scripts must win for the screenshot editor, but preserve unrelated existing `dependencies`, `devDependencies`, and useful scripts unless they directly conflict.
9. **Do not import template sample decks into real migrations.** If the old project already has decks or screenshots, use the template for UI/code only. Keep template sample screenshots/decks out of the migrated project so the user's app does not inherit unrelated example content.
10. **Use a disposable copy for dogfooding.** If the user asks to test or review the migration instead of actually migrating their project, copy the app to a temp directory or worktree and run the migration there. Only touch the real checkout when the user explicitly asks for the real migration and answers **Yes**.

Recommended migration sequence:

```bash
# 1. Snapshot useful old files outside the repo.
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/app-store-screenshots-migration-$STAMP"
mkdir -p "$BACKUP_DIR"
cp -R app-store-screenshots.json public src package.json tailwind.config.ts next.config.mjs "$BACKUP_DIR/" 2>/dev/null || true

# 2. Preserve project state and assets that must survive template copy.
PRESERVE_DIR="$BACKUP_DIR/preserve"
mkdir -p "$PRESERVE_DIR"
cp app-store-screenshots.json "$PRESERVE_DIR/" 2>/dev/null || true
cp -R public/screenshots "$PRESERVE_DIR/screenshots" 2>/dev/null || true
cp public/app-icon.png "$PRESERVE_DIR/app-icon.png" 2>/dev/null || true

# 3. Copy the current template over the old UI implementation.
cp -R "<SKILL_DIR>/template/." "$PWD/"
cp app-store-screenshots.json "$BACKUP_DIR/template-app-store-screenshots.json" 2>/dev/null || true

# 4. Restore preserved user state/assets over template samples.
cp "$PRESERVE_DIR/app-store-screenshots.json" app-store-screenshots.json 2>/dev/null || true
mkdir -p public
if [ -d "$PRESERVE_DIR/screenshots" ]; then
  mkdir -p "$BACKUP_DIR/template-samples/public"
  mv public/screenshots "$BACKUP_DIR/template-samples/public/screenshots" 2>/dev/null || true
  cp -R "$PRESERVE_DIR/screenshots" public/screenshots
else
  mkdir -p public/screenshots
fi
cp "$PRESERVE_DIR/app-icon.png" public/app-icon.png 2>/dev/null || true
```

After copying, upgrade or create `app-store-screenshots.json`. If an existing project file exists, coerce it in place. If no project file exists but old slide data is embedded in `src/lib/defaults.ts` or `src/app/page.tsx`, extract it best-effort into the template's project JSON before falling back to starter slides. Prefer old arrays or objects named `slides`, `screens`, `features`, `defaultSlides`, `appName`, `tagline`, `theme`, and screenshot paths. If the old implementation only has image files, sort `public/screenshots/**` by path and seed slides from those files.

Use a small JSON script like this for the final project-state coercion:

```bash
BACKUP_DIR="$BACKUP_DIR" node <<'NODE'
const fs = require("fs");
const path = require("path");

const PROJECT_FILE = "app-store-screenshots.json";
const DEFAULT_LOCALE = "en";
const DEVICE_KEYS = ["iphone", "ipad", "tvos", "watchos", "carplay", "android", "android-7", "android-10", "macos", "windows", "feature-graphic"];
