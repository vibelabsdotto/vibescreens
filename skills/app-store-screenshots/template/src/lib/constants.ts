import type { Device, Orientation, SlideLayout, Theme, ThemeId } from "./types";

// ---------- Canvas dimensions (design at largest required resolution) ----------
export const CANVAS: Record<Device, { w: number; h: number; wL?: number; hL?: number }> = {
  iphone:        { w: 1320, h: 2868 },
  ipad:          { w: 2064, h: 2752 },
  // Apple TV is 16:9 landscape-only. Design at 4K; 1920x1080 is a clean 2x downscale.
  tvos:          { w: 3840, h: 2160 },
  // Apple Watch: design at the largest slot Apple accepts (Ultra 422x514) so every
  // smaller size is a downscale rather than an upscale.
  watchos:       { w: 422, h: 514 },
  // CarPlay has NO App Store screenshot slot of its own - see EXPORT_SIZES below.
  // The canvas is therefore the iPhone canvas, because that is where a CarPlay
  // shot is actually submitted.
  carplay:       { w: 1320, h: 2868 },
  android:       { w: 1080, h: 1920 },
  "android-7":   { w: 1200, h: 1920, wL: 1920, hL: 1200 },
  "android-10":  { w: 1600, h: 2560, wL: 2560, hL: 1600 },
  macos:         { w: 2880, h: 1800 },
  windows:       { w: 2560, h: 1440 },
  "feature-graphic": { w: 1024, h: 500 },
};

// ---------- Export sizes per device ----------
export type ExportSize = { label: string; w: number; h: number };

export const EXPORT_SIZES: Record<Device, ExportSize[]> = {
  iphone: [
    { label: '6.9"', w: 1320, h: 2868 },
    { label: '6.5"', w: 1284, h: 2778 },
    { label: '6.3"', w: 1206, h: 2622 },
    { label: '6.1"', w: 1125, h: 2436 },
  ],
  ipad: [
    { label: '13" iPad',       w: 2064, h: 2752 },
    { label: '12.9" iPad Pro', w: 2048, h: 2732 },
  ],
  // App Store Connect display type APP_APPLE_TV. Verified 18 Aug 2026 via
  // `asc screenshots sizes --all`; these are the only accepted dimensions.
  tvos: [
    { label: "4K (3840 x 2160)", w: 3840, h: 2160 },
    { label: "HD (1920 x 1080)", w: 1920, h: 1080 },
  ],
  // Apple Watch display types, all verified the same way:
  //   APP_WATCH_ULTRA 410x502 + 422x514 | SERIES_10 416x496
  //   SERIES_7 396x484 | SERIES_4 368x448 | SERIES_3 312x390
  watchos: [
    { label: "Ultra (422 x 514)",    w: 422, h: 514 },
    { label: "Ultra (410 x 502)",    w: 410, h: 502 },
    { label: "Series 10 (416x496)",  w: 416, h: 496 },
    { label: "Series 7 (396 x 484)", w: 396, h: 484 },
    { label: "Series 4 (368 x 448)", w: 368, h: 448 },
    { label: "Series 3 (312 x 390)", w: 312, h: 390 },
  ],
  // 🚨 CarPlay has NO display type in App Store Connect - confirmed against its own
  // metadata, not documentation: `asc screenshots sizes --all` lists APPLE_TV,
  // VISION_PRO, DESKTOP, IPAD*, IPHONE*, WATCH* and nothing for CarPlay. A CarPlay
  // app ships inside its iPhone app, so a CarPlay shot is submitted in an iPhone
  // slot. These are therefore the iPhone sizes on purpose.
  carplay: [
    { label: '6.9"', w: 1320, h: 2868 },
    { label: '6.5"', w: 1284, h: 2778 },
    { label: '6.3"', w: 1206, h: 2622 },
    { label: '6.1"', w: 1125, h: 2436 },
  ],
  android:       [{ label: "Phone",          w: 1080, h: 1920 }],
  "android-7":   [{ label: '7" Portrait',    w: 1200, h: 1920 }],
  "android-10":  [{ label: '10" Portrait',   w: 1600, h: 2560 }],
  macos: [
    { label: "2880 × 1800", w: 2880, h: 1800 },
    { label: "2560 × 1600", w: 2560, h: 1600 },
    { label: "1440 × 900",  w: 1440, h: 900 },
  ],
  windows: [
    { label: "2560 × 1440", w: 2560, h: 1440 },
    { label: "1920 × 1080", w: 1920, h: 1080 },
    { label: "1366 × 768",  w: 1366, h: 768 },
  ],
  "feature-graphic": [{ label: "Feature Graphic", w: 1024, h: 500 }],
};

// Landscape sizes (tablets only)
export const EXPORT_SIZES_LANDSCAPE: Partial<Record<Device, ExportSize[]>> = {
  "android-7":  [{ label: '7" Landscape',  w: 1920, h: 1200 }],
  "android-10": [{ label: '10" Landscape', w: 2560, h: 1600 }],
};

export function supportsLandscape(device: Device): boolean {
  return device in EXPORT_SIZES_LANDSCAPE;
}

export function getExportSizes(device: Device, orientation: Orientation): ExportSize[] {
  if (orientation === "landscape") {
    return EXPORT_SIZES_LANDSCAPE[device] || EXPORT_SIZES[device];
  }
  return EXPORT_SIZES[device];
}

// ---------- Frame aspect ratios ----------
export const MK_RATIO    = 1022 / 2082; // iPhone PNG mockup
export const TAB_P_RATIO = 0.667;        // tablet portrait
export const TAB_L_RATIO = 1.5;          // tablet landscape
export const IPAD_RATIO  = 0.770;        // iPad
export const TV_RATIO    = 16 / 9;       // Apple TV - landscape only
export const WATCH_RATIO = 422 / 514;    // Apple Watch Ultra, the largest accepted slot
// CarPlay head units vary by vehicle and Apple ships five presets in CarPlay
// Simulator.app/Contents/Resources/VehicleConfigs: Minimum 748x456, Standard 800x480,
// Widescreen 1920x720, Portrait 900x1200, Standard Video Playback 1920x1080.
// "Standard" is the default here; change this constant to target another.
export const CARPLAY_RATIO = 800 / 480;

// iPhone mockup screen overlay (pre-measured)
export const PHONE_SCREEN = {
  L: (52 / 1022) * 100,
  T: (46 / 2082) * 100,
  W: (918 / 1022) * 100,
  H: (1990 / 2082) * 100,
  RX: (126 / 918) * 100,
  RY: (126 / 1990) * 100,
};

// ---------- Width formula helpers ----------
export function phoneW(cW: number, cH: number, clamp = 0.84) {
  return Math.min(clamp, 0.72 * (cH / cW) * MK_RATIO);
}
export function phoneWSmall(cW: number, cH: number) {
  return phoneW(cW, cH, 0.66);
}
export function tabletPW(cW: number, cH: number, clamp = 0.80) {
  return Math.min(clamp, 0.72 * (cH / cW) * TAB_P_RATIO);
}
export function tabletLW(cW: number, cH: number, clamp = 0.62) {
  return Math.min(clamp, 0.75 * (cH / cW) * TAB_L_RATIO);
}
export function ipadW(cW: number, cH: number, clamp = 0.75) {
  return Math.min(clamp, 0.72 * (cH / cW) * IPAD_RATIO);
}
export function desktopW(cW: number, cH: number, aspect: number, clamp = 0.72) {
  return Math.min(clamp, 0.68 * (cH / cW) * aspect);
}
// Clamped low so a 16:9 device clears the 0.28-height caption block on a 16:9 canvas.
export function tvW(cW: number, cH: number, clamp = 0.58) {
  return Math.min(clamp, 0.72 * (cH / cW) * TV_RATIO);
}
export function watchW(cW: number, cH: number, clamp = 0.52) {
  return Math.min(clamp, 0.72 * (cH / cW) * WATCH_RATIO);
}
export function carPlayW(cW: number, cH: number, clamp = 0.86) {
  return Math.min(clamp, 0.72 * (cH / cW) * CARPLAY_RATIO);
}
