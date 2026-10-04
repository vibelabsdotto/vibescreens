"use client";

import * as React from "react";
import { createVersionExportJobs, ExportPlanError, type DeviceFrameExport, type ExportContent, type ExportJob, type ExportPlan } from "@/lib/export-plan";
import { resolveScreenshot } from "@/lib/locale";
import type { DeckRecord } from "@/lib/project-schema";
import type { Device, Orientation, Slide } from "@/lib/types";
import { getCanvas, getElementTransform, getFrameForDevice } from "./slide-canvas";

// Includes the existing frame shadows, including rotated tablets/windows.
const SHADOW_PADDING = 128;
type FrameOutput = { width: number; height: number; deviceFrame: DeviceFrameExport };

export function getDeviceFrameExports(deck: DeckRecord, slide: Slide): FrameOutput[] {
  if (deck.device === "feature-graphic" || slide.layout === "feature-graphic") return [];
  const primary = resolveScreenshot(slide.screenshot, deck.locale);
  const secondary = resolveScreenshot(slide.screenshotSecondary, deck.locale) || primary;
  const frames: FrameOutput[] = [];
  for (const element of ["device", "deviceSecondary"] as const) {
    const rect = getElementTransform(slide, deck.device, deck.orientation, element);
    const src = element === "device" ? primary : secondary;
    if (!rect || !src) continue;
    const rotation = rect.rotation ?? 0;
    if (![rect.width, rect.height, rotation].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Invalid device dimensions on slide ${slide.id}`);
    }
    const angle = rotation * Math.PI / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    frames.push({
      // Ignore the placement on the store canvas: export the complete device,
      // even when the layout deliberately crops it or spans adjacent screens.
      width: Math.ceil(rect.width * cos + rect.height * sin - 1e-6) + SHADOW_PADDING * 2,
      height: Math.ceil(rect.width * sin + rect.height * cos - 1e-6) + SHADOW_PADDING * 2,
      deviceFrame: Object.freeze({ element, src, width: rect.width, height: rect.height, rotation }),
    });
  }
  return frames;
}

export function getDeviceAssetImageUrls(deck: DeckRecord): string[] {
  const urls = new Set<string>();
  for (const slide of deck.slides) {
    const frames = getDeviceFrameExports(deck, slide);
    for (const frame of frames) urls.add(frame.deviceFrame.src);
    if (frames.length > 0 && deck.device === "iphone") urls.add("/mockup.png");
    for (const image of slide.imageElements ?? []) {
      if (image.src) urls.add(image.src);
    }
    if ((deck.device === "feature-graphic" || slide.layout === "feature-graphic") && deck.appIcon) {
      urls.add(deck.appIcon);
    }
  }
  return [...urls].sort();
}

/** Adapt the frozen store plan without changing its snapshot or scope rules. */
export function buildDeviceFrameExportPlan(
  plan: ExportPlan,
  content: Exclude<ExportContent, "screens"> = "device-frames",
): ExportPlan {
  const withAssets = content === "device-frames-with-assets";
  const seenSlides = new Set<string>();
  const paths = new Set<string>();
  const jobs: ExportJob[] = [];
  // Store preflight can suppress a published version's jobs because one device
  // is empty. Resolve the same frozen decks before applying frame-only rules.
  const sourceJobs = plan.versions.flatMap((entry) => {
    const app = plan.snapshot.appsById[entry.appId];
    const version = app.versionsById[entry.versionId];
    return createVersionExportJobs({
      app, version, decks: entry.deckIds.map((deckId) => version.decksById[deckId]),
    }, entry.directory);
  });
  for (const job of sourceJobs) {
    const key = JSON.stringify([job.appId, job.versionId, job.deckId, job.slideId]);
    if (seenSlides.has(key)) continue; // Store-size variants are redundant here.
    seenSlides.add(key);
    const deck = plan.snapshot.appsById[job.appId].versionsById[job.versionId].decksById[job.deckId];
    const slide = deck.slides[job.slideIndex];
    const parts = job.relativePath.split("/");
    const filename = parts.pop()!;
    parts.pop(); // Replace the store-size directory with a marketing directory.
    const frames = getDeviceFrameExports(deck, slide);
    const hasAssets = frames.length > 0 || slide.imageElements?.some((image) => image.src) ||
      ((deck.device === "feature-graphic" || slide.layout === "feature-graphic") && deck.appIcon);
    const { cW, cH } = getCanvas(deck.device, deck.orientation);
    const outputs = withAssets
      ? (hasAssets || (deck.connectedCanvas && getDeviceAssetImageUrls(deck).length > 0)
        ? [{ width: cW, height: cH, deviceFrame: undefined }]
        : [])
      : frames;
    for (const frame of outputs) {
      const outputFilename = frame.deviceFrame
        ? filename.replace(/\.png$/, `-${frame.deviceFrame.element}.png`)
        : filename;
      const relativePath = [...parts, content, outputFilename].join("/");
      if (paths.has(relativePath)) throw new ExportPlanError("path_collision", `Duplicate device export path ${relativePath}`);
      paths.add(relativePath);
      jobs.push(Object.freeze({ ...job, ...frame, id: relativePath, relativePath, sizeLabel: withAssets ? "Device frames with assets" : "Device frame" }));
    }
  }
  if (jobs.length === 0) {
    throw new ExportPlanError("empty_scope", withAssets
      ? "No device screenshots or image assets in the selected versions."
      : "No device screenshots in the selected versions. Empty devices and graphic-only slides are skipped.");
  }

  // Empty devices are intentionally omitted, never rendered as placeholders.
  // Published-content integrity and asset errors still block the export.
  const missingScreenshots = [...plan.preflight.errors, ...plan.preflight.warnings]
    .filter((issue) => issue.code === "missing_screenshot");
  const preflight = Object.freeze({
    errors: Object.freeze(plan.preflight.errors.filter((issue) => issue.code !== "missing_screenshot")),
    warnings: Object.freeze([
      ...plan.preflight.warnings.filter((issue) => issue.code !== "missing_screenshot"),
      ...missingScreenshots.map((issue) => Object.freeze({
        ...issue, severity: "warning" as const, message: "Device without a screenshot will be skipped",
      })),
    ]),
  });
  const versions = Object.freeze(plan.versions.map((version) => {
    const jobCount = jobs.filter((job) => job.appId === version.appId && job.versionId === version.versionId).length;
    const ready = !preflight.errors.some((issue) => issue.versionId === version.versionId);
    return Object.freeze({ ...version, jobCount, ready, metadata: Object.freeze({ ...version.metadata, jobCount, ready }) });
  }));
  return Object.freeze({
    ...plan,
    jobs: Object.freeze(jobs),
    versions,
    preflight,
    manifest: Object.freeze({
      ...plan.manifest,
      content,
      bundleName: plan.manifest.bundleName.replace(/^vibescreens-/, `vibescreens-${content}-`),
      plannedJobCount: jobs.length,
      complete: preflight.errors.length === 0,
      preflight,
      versions: Object.freeze(plan.manifest.versions.map((version, index) => Object.freeze({
        ...version, jobCount: versions[index].jobCount, ready: versions[index].ready,
      }))),
      jobs: Object.freeze(jobs.map(({ id, versionId, deckId, slideId, relativePath }) => Object.freeze({
        id, versionId, deckId, slideId, relativePath,
      }))),
    }),
  });
}

export function DeviceFrameCanvas({
  device, orientation, width, height, deviceFrame,
}: FrameOutput & { device: Device; orientation: Orientation }) {
  const { Comp: Frame } = getFrameForDevice(device, orientation);
  return (
    <div
      data-device-frame-export={deviceFrame.element}
      style={{ position: "relative", width, height, overflow: "hidden", background: "transparent" }}
    >
      <div style={{
        position: "absolute",
        left: (width - deviceFrame.width) / 2,
        top: (height - deviceFrame.height) / 2,
        width: deviceFrame.width,
        height: deviceFrame.height,
        transform: `rotate(${deviceFrame.rotation}deg)`,
        transformOrigin: "center center",
      }}>
        <Frame src={deviceFrame.src} hideEmpty style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}
