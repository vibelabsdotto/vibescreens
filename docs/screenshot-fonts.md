# Screenshot Fonts

Use the **Font** menu in the toolbar to change the typeface used on the screenshot canvas and in exported images. It does not change the editor’s controls.

## Included choices

- **Editorial Serif** uses Georgia.
- **Modern Sans** uses the device’s clean system sans-serif font.
- **Classic Serif** uses Georgia.
- **Avenir Next**, **Helvetica Neue**, **American Typewriter**, **Baskerville**, **Optima**, **Palatino**, and **Futura** use their macOS-native versions when available, with sensible fallbacks elsewhere.
- **Import a font** accepts your WOFF2, WOFF, TTF, or OTF file directly.

## Adding your own font

1. Choose **Import a font** in the toolbar, then select **Import font**.
2. Choose a licensed WOFF2, WOFF, TTF, or OTF file. It is validated, stored under the version-scoped `public/vibescreens-assets/` tree, registered in the project, and used immediately in previews and exports.
3. To automate the same operation, use `npm run cli -- asset import --file ./Brand.woff2 --kind font --field font` instead of copying files into `public/` manually.

The selected font is saved in the active SQLite project as `fontId`.

## Relevant code

- `src/lib/constants.ts` defines the available screenshot fonts.
- `src/components/editor/toolbar.tsx` provides the font selector.
- `src/components/editor/slide-canvas.tsx` applies the font to previews and exports.
- `src/app/globals.css` registers the self-hosted font location.
