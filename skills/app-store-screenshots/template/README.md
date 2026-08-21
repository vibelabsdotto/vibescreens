# Store Screenshots — Editor Template

A pre-built Next.js + ShadCN editor for generating App Store, Microsoft Store, and Google Play screenshots. Scaffolded by the `app-store-screenshots` skill.

## Quick start

```bash
bun install   # or pnpm / yarn / npm
bun dev       # http://localhost:3000
```

## What's inside

- **Connected canvas editor** (`src/components/editor/`) — every screen sits on one horizontal canvas, so phones, captions, and other elements can be dragged across screen boundaries and exported as split crops when Connected mode is enabled.
- **Screen controls** — drag-to-reorder screens, click-to-edit text, screenshot drop targets, per-screen layout switcher, dark/light toggle.
- **Image overlays** — add PNG/JPG elements, then upload or replace them, drag, resize, rotate, layer, crop, and apply a one-sided edge fade. See [Image Elements](docs/image-elements.md).
- **Edit history** — undo or redo up to 25 recent changes from the toolbar or keyboard. See [Edit History](docs/edit-history.md).
- **Live themes, fonts, and backgrounds** — change the deck theme or font live; set each slide to its theme background, alternate, or custom color. Fonts can be imported from WOFF2, WOFF, TTF, or OTF files. See [Themes](docs/themes.md), [Screenshot Fonts](docs/screenshot-fonts.md), and [Background Controls](docs/background-controls.md).
- **Device frames** (`src/components/editor/device-frames.tsx`) — iPhone (PNG mockup), iPad, Android phone, Android tablet (portrait + landscape), macOS and Windows desktop windows, Apple TV, Apple Watch, CarPlay, feature graphic.
