import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildExportPlan } from "../../lib/export-plan";
import { createProjectDocument } from "../../lib/project-operations";
import type { DeckRecord } from "../../lib/project-schema";
import type { Slide } from "../../lib/types";
import {
  buildDeviceFrameExportPlan,
  DeviceFrameCanvas,
  getDeviceFrameExports,
} from "./device-frame-export";

function slide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: "marketing-slide",
    layout: "hero",
    label: { en: "Do not export label" },
    headline: { en: "Do not export headline" },
    screenshot: "/screenshots/{locale}/primary.png",
    ...overrides,
  };
}

function deck(overrides: Partial<DeckRecord> = {}): DeckRecord {
  return {
    id: "deck_marketing" as DeckRecord["id"],
    device: "iphone",
    orientation: "portrait",
    locale: "de",
    connectedCanvas: true,
    appName: "Marketing",
    themeId: "clean-light",
    fontId: "system-sans",
    appIcon: "",
    slides: [slide()],
    ...overrides,
  };
}

describe("device frame export", () => {
  it("exports the full device, not its clipped position on the store canvas", () => {
    const source = slide({ transforms: { device: { x: -900, y: 2700, width: 400, height: 800 } } });
    const [frame] = getDeviceFrameExports(deck(), source);
    expect(frame.deviceFrame).toMatchObject({
      element: "device", src: "/screenshots/de/primary.png", width: 400, height: 800, rotation: 0,
    });
    expect(frame.width).toBe(656);
    expect(frame.height).toBe(1056);
    expect(source.transforms?.device?.x).toBe(-900);
  });

  it("keeps rotations and expands bounds so the complete frame fits", () => {
    const [frame] = getDeviceFrameExports(deck(), slide({
      transforms: { device: { x: 0, y: 0, width: 400, height: 800, rotation: 90 } },
    }));
    expect(frame.width).toBe(1056);
    expect(frame.height).toBe(656);
    expect(frame.deviceFrame.rotation).toBe(90);
  });

  it("exports both devices independently, using the same localized fallback as the editor", () => {
    const frames = getDeviceFrameExports(deck(), slide({ layout: "two-devices" }));
    expect(frames.map((frame) => frame.deviceFrame.element)).toEqual(["device", "deviceSecondary"]);
    expect(frames.map((frame) => frame.deviceFrame.src)).toEqual([
      "/screenshots/de/primary.png", "/screenshots/de/primary.png",
    ]);
    const secondary = getDeviceFrameExports(deck(), slide({
      layout: "two-devices", screenshotSecondary: "/screenshots/{locale}/second.png",
    }));
    expect(secondary[1].deviceFrame.src).toBe("/screenshots/de/second.png");
  });

  it("skips empty devices and graphic-only slides but includes explicitly placed devices", () => {
    expect(getDeviceFrameExports(deck(), slide({ screenshot: "" }))).toEqual([]);
    expect(getDeviceFrameExports(deck(), slide({ layout: "no-device" }))).toEqual([]);
    expect(getDeviceFrameExports(deck(), slide({ layout: "feature-graphic" }))).toEqual([]);
    expect(getDeviceFrameExports(deck({ device: "feature-graphic" }), slide())).toEqual([]);
    const custom = slide({
      layout: "no-device", transforms: { device: { x: 0, y: 0, width: 400, height: 800 } },
    });
    expect(getDeviceFrameExports(deck(), custom)).toHaveLength(1);
    const secondaryOnly = slide({ layout: "two-devices", screenshot: "", screenshotSecondary: "/second.png" });
    expect(getDeviceFrameExports(deck(), secondaryOnly).map((frame) => frame.deviceFrame.element))
      .toEqual(["deviceSecondary"]);
  });

  it.each(["iphone", "ipad", "android", "android-7", "android-10", "macos", "windows", "watchos", "tvos", "carplay"] as const)(
    "reuses the existing %s frame renderer without slide backgrounds, copy, icons or overlays", (device) => {
      const target = deck({ device, orientation: "landscape" });
      const [frame] = getDeviceFrameExports(target, slide({ backgroundColor: "#abcdef" }));
      const markup = renderToStaticMarkup(<DeviceFrameCanvas device={device} orientation={target.orientation} {...frame} />);
      expect(markup).toContain("background:transparent");
      expect(markup).toContain("/screenshots/de/primary.png");
      expect(markup).not.toContain("#abcdef");
      expect(markup).not.toContain("Do not export");
      expect(markup).not.toContain("Drop a screenshot");
    },
  );

  it("rejects empty marketing bundles instead of downloading a ZIP without images", async () => {
    const document = createProjectDocument(deck({ slides: [slide({ layout: "no-device" })] }));
    const plan = await buildExportPlan(document, { kind: "current" });
    expect(() => buildDeviceFrameExportPlan(plan)).toThrow("No device screenshots");
  });

  it("keeps the rotated corners inside the padded output", () => {
    for (const rotation of [-135, -45, 30, 45, 135, 270]) {
      const [frame] = getDeviceFrameExports(deck(), slide({
        transforms: { device: { x: 0, y: 0, width: 400, height: 800, rotation } },
      }));
      const angle = rotation * Math.PI / 180;
      for (const x of [-200, 200]) {
        for (const y of [-400, 400]) {
          expect(Math.abs(x * Math.cos(angle) - y * Math.sin(angle))).toBeLessThanOrEqual(frame.width / 2 - 127);
          expect(Math.abs(x * Math.sin(angle) + y * Math.cos(angle))).toBeLessThanOrEqual(frame.height / 2 - 127);
        }
      }
    }
  });

  it("recounts skipped devices and changes empty-device warnings without discarding integrity errors", async () => {
    const document = createProjectDocument(deck({ slides: [slide(), slide({ id: "empty-device", screenshot: "" })] }));
    const plan = await buildExportPlan(document, { kind: "current" });
    const issue = { code: "content_hash_mismatch" as const, severity: "error" as const, message: "Content changed", versionId: plan.versions[0].versionId };
    const frames = buildDeviceFrameExportPlan({ ...plan, preflight: { ...plan.preflight, errors: [issue] } });
    expect(frames.jobs).toHaveLength(1);
    expect(frames.preflight.errors).toEqual([issue]);
    expect(frames.preflight.warnings[0].message).toContain("will be skipped");
    expect(frames.versions[0].jobCount).toBe(1);
    expect(frames.versions[0].ready).toBe(false);
    expect(frames.versions[0].metadata.ready).toBe(false);
    expect(frames.manifest.versions[0].ready).toBe(false);
    expect(frames.manifest.complete).toBe(false);
    expect(Object.isFrozen(frames.jobs[0].deviceFrame)).toBe(true);
  });

  it("plans one PNG per device, not one per store size, with consistent ZIP metadata", async () => {
    const document = createProjectDocument(deck());
    const app = document.appsById[document.selection.appId];
    const version = app.versionsById[document.selection.versionId];
    const target = deck({ slides: [slide({ layout: "two-devices" }), slide({ id: "no-frame", layout: "no-device" })] });
    version.deckOrder = [target.id];
    version.decksById = { [target.id]: target };
    document.selection.deckId = target.id;
    document.selection.slideId = target.slides[0].id;
    const plan = await buildExportPlan(document, { kind: "current" });
    const original = JSON.stringify(plan);
    const frames = buildDeviceFrameExportPlan(plan);
    expect(frames.jobs).toHaveLength(2);
    expect(new Set(frames.jobs.map((job) => job.relativePath)).size).toBe(2);
    expect(frames.jobs.every((job) => job.relativePath.includes("/device-frames/"))).toBe(true);
    expect(frames.manifest.content).toBe("device-frames");
    expect(frames.manifest.bundleName).toContain("-device-frames-");
    expect(frames.manifest.plannedJobCount).toBe(2);
    expect(frames.manifest.jobs.map((job) => job.id)).toEqual(frames.jobs.map((job) => job.id));
    expect(frames.versions[0].jobCount).toBe(2);
    expect(frames.versions[0].metadata.jobCount).toBe(2);
    expect(frames.manifest.versions[0].jobCount).toBe(2);
    expect(frames.snapshot).toBe(plan.snapshot);
    expect(JSON.stringify(plan)).toBe(original);
  });
});
