# VibeScreens

VibeScreens is a skill for AI coding agents that scaffolds a Next.js editor for App Store, Microsoft Store, and Google Play marketing screenshots. One local editor can manage several projects, apps, named versions, device decks, and locales without restarting the dev server.

![Current connected-canvas editor showing a Bloom screenshot deck](example.png)

Example screenshots generated with this skill were accepted for [Bloom Coffee Shelf Recipe on the App Store](https://apps.apple.com/us/app/bloom-coffee-shelf-recipe/id6759914524).

## What it does

- Builds a full screenshot editor instead of a static one-off page
- Turns raw app captures into ad-style slides with big, readable copy
- Lets phones, captions, and decorative elements span adjacent screenshots on one connected canvas
- Keeps projects, apps, versions, decks, and slides in one local workspace
- Makes published versions read-only; further edits start from a draft clone
- Saves schema-v3 project documents under `.vibescreens/projects/<projectId>/vibescreens.json`
- Stores uploaded assets by SHA-256 under `public/vibescreens-assets/<projectId>/<appId>/<versionId>/`
- Exports PNG bundles at common App Store, Microsoft Store, and Google Play sizes
- Supports locales, RTL-aware copy and layout guidance, reusable themes, and non-destructive legacy migration

## Editor workflow

- **Project switcher.** Create, rename, delete, and switch projects without reloading the page.
- **App and version switchers.** Keep several apps and named releases in one project. Drafts are editable; published versions are locked.
- **Connected canvas.** View the whole screenshot strip, drag elements across screen boundaries, then export each screen as a precise crop.
- **Isolated mode.** Preserve legacy decks where offscreen elements must not appear in neighboring exports.
- **Screen sidebar.** Add, select, and reorder screens with live thumbnails.
- **Inspector.** Edit copy, layouts, screenshots, stacking, and transforms.
- **Deck controls.** Select one device, orientation, and locale deck inside the active version.
- **Autosave.** Save the active project with revision checks. `localStorage` is a cache, not the durable source of truth.
- **Export bundle.** Download a zip organized by app, version, status, platform, device, orientation, locale, and resolution.

Tip: when capturing source iPhone screenshots, the 6.1-inch simulator is usually the easiest starting point because it reduces manual image adjustment inside the frames.

## Supported devices

- **iPhone** (portrait) - Apple App Store
- **iPad** (portrait) - Apple App Store
- **Apple TV** (landscape) - Apple App Store
- **Apple Watch** (portrait) - Apple App Store
- **CarPlay** (landscape) - exports into an **iPhone** slot
- **Android Phone** (portrait) - Google Play
- **Android Tablet 7"** (portrait and landscape) - Google Play
- **Android Tablet 10"** (portrait and landscape) - Google Play
- **Feature Graphic** (1024 x 500 banner) - Google Play store listing header
- **macOS** (16:10 desktop window) - Mac App Store and product listings
- **Windows** (16:9 desktop window) - Microsoft Store and product listings

## Install

### Using npx skills

```bash
npx skills add vibelabsdotto/vibescreens
```

Install globally:

```bash
npx skills add vibelabsdotto/vibescreens -g
```

Install for a specific agent:

```bash
npx skills add vibelabsdotto/vibescreens -a claude-code
```

This works with Claude Code, Cursor, Windsurf, OpenCode, Codex, and other agents supported by [`skills`](https://github.com/vercel-labs/skills).

### Manual install

```bash
git clone https://github.com/vibelabsdotto/vibescreens.git
mkdir -p ~/.claude/skills
cp -R vibescreens/skill ~/.claude/skills/vibescreens
```

## Usage

Once installed, ask your coding agent for store screenshots:

```text
Build App Store and Google Play screenshots for my app.
```

The skill guides the agent through workspace discovery, app context, source screenshots, platforms, locales, visual direction, and slide count. In an existing VibeScreens workspace, name the project, app, and version you want to change. If you omit them, the agent uses the saved active selection.

## Example prompts

```text
Create a VibeScreens project for my habit tracker.
The app helps people stay consistent with simple daily routines.
I want 6 iPhone slides, warm neutrals, and a calm premium feel.
```

```text
Add Android launch screenshots for version 2.4 of my finance app.
Use the current iOS version as the starting point, but adapt the copy and frames for Google Play.
```

```text
Clone the published 2.4 Launch version as a draft named 2.5 Spring.
Keep the existing assets, then update the first two headlines.
```

```text
Build English, German, and Arabic decks for my language learning app.
Make the Arabic deck feel RTL-native, not just translated.
```

## Better prompt tips

- Name the target project, app, and version when the workspace contains more than one
- Say what the app does in one sentence
- List the top features in priority order
- Mention the devices and orientations you need
- Describe the visual style and slide count
- Mention required locales or RTL languages
- Provide source screenshot paths, an app icon, and style references when available
- Say whether the result should remain a draft or be published after review

## What gets scaffolded

A new VibeScreens folder has one runtime and a workspace that grows as projects are added:

```text
project/
├── .vibescreens/
│   ├── workspace.json
│   ├── projects/
│   │   └── <projectId>/
│   │       └── vibescreens.json
│   ├── backups/
│   └── trash/
├── public/
│   ├── mockup.png
│   └── vibescreens-assets/
│       └── <projectId>/<appId>/<versionId>/<kind>/<sha256>.<ext>
├── src/app/
│   ├── layout.tsx
│   └── page.tsx
├── src/components/editor/
└── src/lib/
```

`workspace.json` stores project metadata, order, and `activeProjectId`. Each `vibescreens.json` stores one complete schema-v3 document. It contains ordered apps; each app contains ordered versions; each version contains ordered device, orientation, and locale decks; each deck contains slides.

The template README at [`docs/template-README.md`](docs/template-README.md) links to the full apps, versions, migration, and schema documentation.

## Working with versions

1. Edit a draft version.
2. Review every deck and export a proof bundle.
3. Publish the draft to lock its content and record its content hash.
4. Clone a published version when a later release needs changes. The clone gets a new version ID and starts as a draft.

A VibeScreens version is a screenshot release, not a Git branch. Git tracks the editor project and its durable assets. App/version switching happens inside the running editor.

## Legacy migration and recovery

When `.vibescreens/workspace.json` is absent, the importer checks root `vibescreens.json` first and `app-store-screenshots.json` second. It determines the schema from the file contents, creates one project with one app and one draft version, copies referenced assets into the scoped asset tree, and only then updates the workspace registry.

The importer keeps the root legacy file unchanged and records a hashed backup under `.vibescreens/backups/`. A schema newer than v3 opens read-only instead of being downgraded. See [apps and versions](docs/apps-and-versions.md) and [project schema v3](docs/project-schema-v3.md) for recovery details.

## Export sizes

### Apple App Store

| Display | Resolution |
|---------|------------|
| 6.9" | 1320 x 2868 |
| 6.5" | 1284 x 2778 |
| 6.3" | 1206 x 2622 |
| 6.1" | 1125 x 2436 |

### Google Play Store

| Device | Resolution |
|--------|------------|
| Phone portrait | 1080 x 1920 |
| 7" tablet portrait | 1200 x 1920 |
| 7" tablet landscape | 1920 x 1200 |
| 10" tablet portrait | 1600 x 2560 |
| 10" tablet landscape | 2560 x 1600 |
| Feature graphic | 1024 x 500 |

Screenshots are designed at the largest size for each platform and scaled down for smaller exports. Android frames are CSS-rendered, while iPhone uses the included `mockup.png` bezel.

## Persistence model

- `.vibescreens/workspace.json` is the workspace registry. It does not duplicate app, version, deck, or slide state.
- `.vibescreens/projects/<projectId>/vibescreens.json` is the durable source of truth for that project's schema-v3 document and numeric revision.
- `public/vibescreens-assets/<projectId>/<appId>/<versionId>/` owns files for a specific version. Paths use generated IDs and SHA-256 filenames.
- Every successful project mutation increments only that project's revision. A stale write receives `409` instead of overwriting newer work.
- `localStorage` may speed up initial paint or preserve a conflict draft, but it never outranks the project document.
- Legacy root state files stay untouched after import so rollback remains possible.

## Design standards

- Screenshots are ads, not documentation
- Each slide sells one clear user outcome
- Headlines pass the one-second thumbnail test
- Adjacent slides vary layout and device placement
- Cross-screen elements never split required text or critical UI
- Exported crops still work as standalone screenshots

## Tech stack

| Dependency | Purpose |
|------------|---------|
| Next.js 16 | Dev server and app shell |
| React 19 | Editor UI |
| TypeScript | Workspace and project state safety |
| Tailwind CSS | Styling |
| shadcn/ui + Radix | Controls, dialogs, selects, and tooltips |
| html-to-image | PNG rendering |
| JSZip | Bundle downloads |
| dnd-kit | Screen reordering |
| react-rnd | Draggable and resizable canvas elements |

## Requirements

- Node.js 20.9+
- One of bun, pnpm, yarn, or npm

## Contributing

Contributions are welcome, especially around export reliability, screenshot design guidance, migrations, and cross-agent compatibility. Start with `CONTRIBUTING.md`.

## Attribution

VibeScreens was forked from [ParthJadhav/app-store-screenshots](https://github.com/ParthJadhav/app-store-screenshots), created by [Parth Jadhav](https://github.com/ParthJadhav). The original MIT copyright notice remains in `LICENSE`.

## License

MIT
