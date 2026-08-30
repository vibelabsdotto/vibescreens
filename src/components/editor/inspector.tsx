"use client";
import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Plus,
  RotateCw,
  Trash2,
  Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LAYOUT_HINT, LAYOUT_LABEL } from "@/lib/constants";
import { nid } from "@/lib/defaults";
import {
  isBuiltInElementId,
  imageElementKey,
  isImageElementId,
  isTextElementId,
  toImageElementId,
  textElementKey,
  toTextElementId,
} from "@/lib/elements";
import { pickText, writeLocalized } from "@/lib/locale";
import { img as cachedImage } from "@/lib/image-cache";
import type { VersionId } from "@/lib/ids";
import type { ProjectDocumentV3 } from "@/lib/project-schema";
import {
  cleanTypography,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  slideFontScales,
} from "@/lib/typography";
import type {
  BuiltInElementId,
  Device,
  ElementId,
  ElementTransform,
  ImageElement,
  Orientation,
  Slide,
  SlideLayout,
  SlideTypography,
  TextElement,
  Theme,
} from "@/lib/types";
import type { ProjectId } from "@/lib/workspace";
import { BackgroundControls } from "./background-controls";
import { ScreenshotPicker } from "./screenshot-picker";
import { getCanvas, getElementTransform } from "./slide-canvas";

type Props = {
  slide: Slide;
  device: Device;
  orientation: Orientation;
  theme: Theme;
  locale: string;
  projectId: ProjectId;
  versionId: VersionId;
  onBeforeUpload: () => Promise<void>;
  onUploadStateChange: (uploading: boolean) => void;
  selectedElementId: ElementId | null;
  onChange: (patch: Partial<Slide>) => void;
  onSelectElement: (id: ElementId | null) => void;
  /** Adopts the server project returned by an asset upload (revision bump). */
  onUploadReconciled: (project: ProjectDocumentV3) => void;
};

const ELEMENT_LABEL: Record<BuiltInElementId, string> = {
  caption: "Headline",
  device: "Device",
  deviceSecondary: "Back device",
};

export function Inspector({
  slide,
  device,
  orientation,
  theme,
  locale,
  projectId,
  versionId,
  onBeforeUpload,
  onUploadStateChange,
  selectedElementId,
  onChange,
  onSelectElement,
  onUploadReconciled,
}: Props) {
  const isFeatureGraphic = device === "feature-graphic" || slide.layout === "feature-graphic";
  const isNoDevice = slide.layout === "no-device";
  const layoutValue = device === "feature-graphic" ? "feature-graphic" : slide.layout;
  const layoutOptions = Object.entries(LAYOUT_LABEL).filter(([layout]) =>
    device === "feature-graphic" ? layout === "feature-graphic" : layout !== "feature-graphic",
  );
  const localeLabel = slide.label?.[locale] ?? "";
  const localeHeadline = slide.headline?.[locale] ?? "";
  // When the active locale is empty, surface the fallback (typically en) as
  // the placeholder so the user sees what they're translating from.
  const headlineDefault = isFeatureGraphic ? "Your tagline." : "One idea\nper slide.";
  const labelPlaceholder = localeLabel ? "FEATURE 01" : pickText(slide.label, locale) || "FEATURE 01";
  const headlinePlaceholder = localeHeadline
    ? headlineDefault
    : pickText(slide.headline, locale) || headlineDefault;

  function setLocaleField(key: "label" | "headline", value: string) {
    onChange({ [key]: writeLocalized(slide[key], locale, value) } as Partial<Slide>);
  }

  React.useEffect(() => {
    if (device === "feature-graphic" && slide.layout !== "feature-graphic") {
      onChange({ layout: "feature-graphic", transforms: undefined, screenshotSecondary: undefined });
    }
  }, [device, onChange, slide.layout]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Screen settings</h2>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            editing · {locale.toUpperCase()}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{LAYOUT_HINT[layoutValue]}</p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Layout</Label>
          <Select
            value={layoutValue}
            onValueChange={(layout) => {
              const next = layout as SlideLayout;
              onChange({
                layout: next,
                transforms: undefined,
                screenshotSecondary:
                  next === "two-devices" ? slide.screenshotSecondary || slide.screenshot : undefined,
              });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {layoutOptions.map(([layout, label]) => (
                <SelectItem key={layout} value={layout}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!isFeatureGraphic && <BackgroundControls slide={slide} theme={theme} onChange={onChange} />}

        {!isFeatureGraphic && (
          <div className="space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Input
              value={localeLabel}
              onChange={(e) => setLocaleField("label", e.target.value)}
              placeholder={labelPlaceholder}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-xs">{isFeatureGraphic ? "Tagline" : "Headline"}</Label>
            <span className="text-[10px] text-muted-foreground">newline = break</span>
          </div>
          <Textarea
            value={localeHeadline}
            onChange={(e) => setLocaleField("headline", e.target.value)}
            rows={3}
            placeholder={headlinePlaceholder}
          />
        </div>

        <TypographySection slide={slide} isFeatureGraphic={isFeatureGraphic} onChange={onChange} />

        {!isFeatureGraphic && !isNoDevice && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              {slide.layout === "two-devices" ? "Front device screenshot" : "Screenshot"}
            </Label>
            <ScreenshotPicker
              label="Primary"
              value={slide.screenshot}
              locale={locale}
              projectId={projectId}
              versionId={versionId}
              onBeforeUpload={onBeforeUpload}
              onUploadStateChange={onUploadStateChange}
              onChange={(v) => onChange({ screenshot: v })}
              onUploaded={onUploadReconciled}
            />
          </div>
        )}

        {slide.layout === "two-devices" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Back device screenshot</Label>
            <ScreenshotPicker
              label="Secondary (back layer)"
              value={slide.screenshotSecondary || ""}
              locale={locale}
              projectId={projectId}
              versionId={versionId}
              onBeforeUpload={onBeforeUpload}
              onUploadStateChange={onUploadStateChange}
              onChange={(v) => onChange({ screenshotSecondary: v })}
              onUploaded={onUploadReconciled}
            />
          </div>
        )}

        {!isFeatureGraphic && (
          <ElementTransformControls
            slide={slide}
            device={device}
            orientation={orientation}
            locale={locale}
            projectId={projectId}
            versionId={versionId}
            onBeforeUpload={onBeforeUpload}
            onUploadStateChange={onUploadStateChange}
            selectedElementId={selectedElementId}
            onChange={onChange}
            onSelectElement={onSelectElement}
            onUploadReconciled={onUploadReconciled}
          />
        )}

        {isFeatureGraphic && (
          <p className="rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
            Shows app icon + name + tagline. Drop an icon at <span className="rounded bg-background px-1 py-0.5 font-mono text-[10px] text-foreground">/public/app-icon.png</span> (or leave blank — the app initial will be used). Name is set in the toolbar.
          </p>
        )}
      </div>
    </div>
  );
}

function ElementTransformControls({
  slide,
  device,
  orientation,
  locale,
  projectId,
  versionId,
  onBeforeUpload,
  onUploadStateChange,
  selectedElementId,
  onChange,
  onSelectElement,
  onUploadReconciled,
}: {
  slide: Slide;
  device: Device;
  orientation: Orientation;
  locale: string;
  projectId: ProjectId;
  versionId: VersionId;
  onBeforeUpload: () => Promise<void>;
  onUploadStateChange: (uploading: boolean) => void;
  selectedElementId: ElementId | null;
  onChange: (patch: Partial<Slide>) => void;
  onSelectElement: (id: ElementId | null) => void;
  onUploadReconciled: (project: ProjectDocumentV3) => void;
}) {
  const present: ElementId[] = ["caption"];
  if (slide.layout !== "no-device") present.push("device");
  if (slide.layout === "two-devices") present.push("deviceSecondary");
  for (const element of slide.textElements || []) present.push(toTextElementId(element.id));
  for (const element of slide.imageElements || []) present.push(toImageElementId(element.id));

  const transforms = slide.transforms || {};
  const activeId =
    selectedElementId && present.includes(selectedElementId) ? selectedElementId : null;
  const activeTransform = activeId
    ? getElementTransform(slide, device, orientation, activeId)
    : undefined;
  const activeTextElement =
    activeId && isTextElementId(activeId)
      ? slide.textElements?.find((element) => element.id === textElementKey(activeId))
      : null;
  const activeImageElement =
    activeId && isImageElementId(activeId)
      ? slide.imageElements?.find((element) => element.id === imageElementKey(activeId))
      : null;

  function getTransform(id: ElementId) {
    return getElementTransform(slide, device, orientation, id);
  }

  function patchElement(id: ElementId, patch: Partial<ElementTransform>) {
    const cur = getTransform(id);
    if (!cur) return;
    if (isTextElementId(id)) {
      const textId = textElementKey(id);
      onChange({
        textElements: (slide.textElements || []).map((element) =>
          element.id === textId
            ? { ...element, transform: { ...element.transform, ...patch } }
            : element,
        ),
      });
      return;
    }
    if (isImageElementId(id)) {
      const imageId = imageElementKey(id);
      onChange({
        imageElements: (slide.imageElements || []).map((element) =>
          element.id === imageId
            ? { ...element, transform: { ...element.transform, ...patch } }
            : element,
        ),
      });
      return;
    }
    if (!isBuiltInElementId(id)) return;
    onChange({
      transforms: { ...transforms, [id]: { ...cur, ...patch } },
    });
  }

  function patchTextElement(id: string, patch: Partial<TextElement>) {
    onChange({
      textElements: (slide.textElements || []).map((element) =>
        element.id === id ? { ...element, ...patch } : element,
      ),
    });
  }

  function setTextElementValue(element: TextElement, value: string) {
    patchTextElement(element.id, { text: writeLocalized(element.text, locale, value) });
  }

  function deleteTextElement(element: TextElement) {
    const nextTextElements = (slide.textElements || []).filter((item) => item.id !== element.id);
    onChange({
      textElements: nextTextElements.length > 0 ? nextTextElements : undefined,
    });
    onSelectElement(null);
  }

  function patchImageElement(id: string, patch: Partial<ImageElement>) {
    onChange({
      imageElements: (slide.imageElements || []).map((element) =>
        element.id === id ? { ...element, ...patch } : element,
      ),
    });
  }

  function deleteImageElement(element: ImageElement) {
    const nextImageElements = (slide.imageElements || []).filter((item) => item.id !== element.id);
    onChange({ imageElements: nextImageElements.length > 0 ? nextImageElements : undefined });
    onSelectElement(null);
  }

  function addTextElement() {
    const { cW, cH } = getCanvas(device, orientation);
    const id = nid();
    const zIndex =
      Math.max(
        5,
        ...present.map((elementId) => getTransform(elementId)?.zIndex ?? defaultZ(elementId)),
      ) + 1;
    const element: TextElement = {
      id,
      text: writeLocalized({}, locale, "New text"),
      transform: {
        x: cW * 0.18,
        y: cH * 0.42,
        width: cW * 0.64,
        height: cH * 0.12,
        rotation: 0,
        zIndex,
      },
      fontSize: Math.round(Math.min(cW, cH) * 0.065),
      fontWeight: 800,
      align: "center",
    };
    onChange({ textElements: [...(slide.textElements || []), element] });
    onSelectElement(toTextElementId(id));
  }

  function addImageElement() {
    const { cW, cH } = getCanvas(device, orientation);
    const id = nid();
    const zIndex = Math.max(5, ...present.map((elementId) => getTransform(elementId)?.zIndex ?? defaultZ(elementId))) + 1;
    const element: ImageElement = {
      id,
      src: "",
      transform: {
        x: cW * 0.25,
        y: cH * 0.36,
        width: cW * 0.5,
        height: cW * 0.5,
        rotation: 0,
        zIndex,
      },
      fit: "cover",
    };
    onChange({ imageElements: [...(slide.imageElements || []), element] });
    onSelectElement(toImageElementId(id));
  }

  // Z-order: re-rank zIndex among present elements so they remain contiguous.
  function reorder(id: ElementId, dir: "front" | "back" | "up" | "down") {
    const ranked = [...present].sort((a, b) => {
      const za = getTransform(a)?.zIndex ?? defaultZ(a);
      const zb = getTransform(b)?.zIndex ?? defaultZ(b);
      return za - zb;
    });
    const idx = ranked.indexOf(id);
    if (idx === -1) return;
    let target = idx;
    if (dir === "front") target = ranked.length - 1;
    else if (dir === "back") target = 0;
    else if (dir === "up") target = Math.min(ranked.length - 1, idx + 1);
    else if (dir === "down") target = Math.max(0, idx - 1);
    if (target === idx) return;
    ranked.splice(idx, 1);
    ranked.splice(target, 0, id);
    const nextTransforms = { ...transforms };
    const nextTextElements = (slide.textElements || []).map((element) => ({
      ...element,
      transform: { ...element.transform },
    }));
    const nextImageElements = (slide.imageElements || []).map((element) => ({
      ...element,
      transform: { ...element.transform },
    }));
    ranked.forEach((eid, i) => {
      const cur = getTransform(eid);
      if (!cur) return;
      if (isTextElementId(eid)) {
        const textId = textElementKey(eid);
        const textElement = nextTextElements.find((element) => element.id === textId);
        if (textElement) textElement.transform = { ...textElement.transform, zIndex: i + 1 };
      } else if (isImageElementId(eid)) {
        const imageId = imageElementKey(eid);
        const imageElement = nextImageElements.find((element) => element.id === imageId);
        if (imageElement) imageElement.transform = { ...imageElement.transform, zIndex: i + 1 };
      } else if (isBuiltInElementId(eid)) {
        nextTransforms[eid] = { ...cur, zIndex: i + 1 };
      }
    });
    onChange({ transforms: nextTransforms, textElements: nextTextElements, imageElements: nextImageElements });
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Label className="text-xs font-semibold">Elements</Label>
          <p className="text-[11px] text-muted-foreground">
            {activeId
              ? "Fine-tune the selected element's rotation and stacking."
              : "Click an element on the canvas to fine-tune its rotation and stacking."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={addTextElement}
        >
          <Plus className="h-3.5 w-3.5" />
          Text
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={addImageElement}
        >
          <ImagePlus className="h-3.5 w-3.5" />
          Image
        </Button>
      </div>

      {slide.imageElements && slide.imageElements.length > 0 && (
        <ImageOverlayList
          elements={slide.imageElements}
          selectedId={
            activeId && isImageElementId(activeId) ? imageElementKey(activeId) : null
          }
          onSelect={(imageId) => onSelectElement(toImageElementId(imageId))}
          onReorder={(imageId, dir) => reorder(toImageElementId(imageId), dir)}
          onDelete={deleteImageElement}
        />
      )}

      {activeId ? (
        <ActiveElementPanel
          activeId={activeId}
          transform={activeTransform}
          textElement={activeTextElement || undefined}
          imageElement={activeImageElement || undefined}
          locale={locale}
          projectId={projectId}
          versionId={versionId}
          onBeforeUpload={onBeforeUpload}
          onUploadStateChange={onUploadStateChange}
          onRotate={(rotation) => patchElement(activeId, { rotation })}
          onReorder={(dir) => reorder(activeId, dir)}
          onTextChange={(value) => {
            if (activeTextElement) setTextElementValue(activeTextElement, value);
          }}
          onTextPatch={(patch) => {
            if (activeTextElement) patchTextElement(activeTextElement.id, patch);
          }}
          onDeleteText={() => {
            if (activeTextElement) deleteTextElement(activeTextElement);
          }}
          onImagePatch={(patch) => {
            if (activeImageElement) patchImageElement(activeImageElement.id, patch);
          }}
          onDeleteImage={() => {
            if (activeImageElement) deleteImageElement(activeImageElement);
          }}
          onUploaded={onUploadReconciled}
        />
      ) : (
        <div className="rounded border border-dashed bg-background/40 p-4 text-center text-[11px] text-muted-foreground">
          No element selected
        </div>
      )}
    </div>
  );
}

function ActiveElementPanel({
  activeId,
  transform,
  textElement,
  imageElement,
  locale,
  projectId,
  versionId,
  onBeforeUpload,
  onUploadStateChange,
  onRotate,
  onReorder,
  onTextChange,
  onTextPatch,
  onDeleteText,
  onImagePatch,
  onDeleteImage,
  onUploaded,
}: {
  activeId: ElementId;
  transform: ElementTransform | undefined;
  textElement?: TextElement;
  imageElement?: ImageElement;
  locale: string;
  projectId: ProjectId;
  versionId: VersionId;
  onBeforeUpload: () => Promise<void>;
  onUploadStateChange: (uploading: boolean) => void;
  onRotate: (rotation: number) => void;
  onReorder: (dir: "front" | "back" | "up" | "down") => void;
  onTextChange: (value: string) => void;
  onTextPatch: (patch: Partial<TextElement>) => void;
  onDeleteText: () => void;
  onImagePatch: (patch: Partial<ImageElement>) => void;
  onDeleteImage: () => void;
  onUploaded: (project: ProjectDocumentV3) => void;
}) {
  const engaged = !!transform;
  const rotation = transform?.rotation ?? 0;
  const label = elementLabel(activeId);
  return (
    <div className="space-y-2 rounded border bg-background/60 p-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs font-medium">
          {textElement && <Type className="h-3.5 w-3.5" />}
          {imageElement && <ImagePlus className="h-3.5 w-3.5" />}
          {label}
        </span>
        {textElement || imageElement ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:text-destructive"
            onClick={textElement ? onDeleteText : onDeleteImage}
            title={textElement ? "Delete text element" : "Delete image element"}
            aria-label={textElement ? "Delete text element" : "Delete image element"}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : !engaged ? (
          <span className="text-[10px] text-muted-foreground">drag to enable</span>
        ) : null}
      </div>

      {textElement && (
        <TextElementPanel
          element={textElement}
          locale={locale}
          onTextChange={onTextChange}
          onTextPatch={onTextPatch}
        />
      )}

      {imageElement && (
        <ImageElementPanel
          element={imageElement}
          projectId={projectId}
          versionId={versionId}
          onBeforeUpload={onBeforeUpload}
          onUploadStateChange={onUploadStateChange}
          onPatch={onImagePatch}
          onUploaded={onUploaded}
        />
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <RotateCw className="h-3 w-3" /> Rotation
          </Label>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {rotation}°
          </span>
        </div>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={rotation}
          disabled={!engaged}
          onChange={(e) => onRotate(Number(e.target.value))}
          className="w-full disabled:opacity-50"
          aria-label={`${label} rotation`}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Layer</Label>
        <div className="grid grid-cols-4 gap-1">
          <LayerButton disabled={!engaged} onClick={() => onReorder("back")} label="Send to back">
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </LayerButton>
          <LayerButton disabled={!engaged} onClick={() => onReorder("down")} label="Send backward">
            <ChevronDown className="h-3.5 w-3.5" />
          </LayerButton>
          <LayerButton disabled={!engaged} onClick={() => onReorder("up")} label="Bring forward">
            <ChevronUp className="h-3.5 w-3.5" />
          </LayerButton>
          <LayerButton disabled={!engaged} onClick={() => onReorder("front")} label="Bring to front">
            <ArrowUpToLine className="h-3.5 w-3.5" />
          </LayerButton>
        </div>
      </div>
    </div>
  );
}

function ImageElementPanel({
  element,
  projectId,
  versionId,
  onBeforeUpload,
  onUploadStateChange,
  onPatch,
  onUploaded,
}: {
  element: ImageElement;
  projectId: ProjectId;
  versionId: VersionId;
  onBeforeUpload: () => Promise<void>;
  onUploadStateChange: (uploading: boolean) => void;
  onPatch: (patch: Partial<ImageElement>) => void;
  onUploaded: (project: ProjectDocumentV3) => void;
}) {
  return (
    <div className="space-y-2 rounded border bg-muted/30 p-2">
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Image</Label>
        <ScreenshotPicker
          label="Overlay image"
          value={element.src}
          assetKind="image"
          projectId={projectId}
          versionId={versionId}
          onBeforeUpload={onBeforeUpload}
          onUploadStateChange={onUploadStateChange}
          onChange={(src) => onPatch({ src })}
          onUploaded={onUploaded}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Fit</Label>
        <Select value={element.fit || "cover"} onValueChange={(fit) => onPatch({ fit: fit as ImageElement["fit"] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cover">Fill frame</SelectItem>
            <SelectItem value="contain">Keep whole image</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Edge fade</Label>
        <Select
          value={element.fade?.edge || "none"}
          onValueChange={(edge) =>
            onPatch({
              fade:
                edge === "none"
                  ? undefined
                  : { edge: edge as NonNullable<ImageElement["fade"]>["edge"], amount: element.fade?.amount || 35 },
            })
          }
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No fade</SelectItem>
            <SelectItem value="top">Fade from top</SelectItem>
            <SelectItem value="bottom">Fade from bottom</SelectItem>
            <SelectItem value="left">Fade from left</SelectItem>
            <SelectItem value="right">Fade from right</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {element.fade && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[11px] text-muted-foreground">Fade strength</Label>
            <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(element.fade.amount)}%</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={element.fade.amount}
            onChange={(event) => onPatch({ fade: { ...element.fade!, amount: Number(event.target.value) } })}
            className="w-full"
            aria-label="Image edge fade reach"
          />
        </div>
      )}
    </div>
  );
}

function overlayLabel(src: string): string {
  if (!src) return "Empty overlay";
  if (src.startsWith("data:")) return "Inline image";
  const filename = src.split("/").filter(Boolean).pop() ?? src;
  const digest = /^[a-f0-9]{64}\./i.exec(filename);
  if (!digest) return filename;
  // Managed asset names are opaque SHA-256 digests; show the scoped path tail instead.
  const segments = src.split("/");
  const versionIndex = segments.indexOf("vibescreens-assets");
  if (versionIndex >= 0 && segments.length - versionIndex >= 5) {
    const [, , , kind] = segments.slice(versionIndex, versionIndex + 4);
    return `${kind ?? "image"} · ${filename.slice(0, 10)}…`;
  }
  return filename.slice(0, 24);
}

/**
 * Lists every image overlay on the active slide so multiple overlays stay
 * manageable: select by click, restack, delete — mirroring the canvas.
 */
function ImageOverlayList({
  elements,
  selectedId,
  onSelect,
  onReorder,
  onDelete,
}: {
  elements: ImageElement[];
  selectedId: string | null;
  onSelect: (imageId: string) => void;
  onReorder: (imageId: string, dir: "front" | "back" | "up" | "down") => void;
  onDelete: (element: ImageElement) => void;
}) {
  // Render topmost-last so the list reads like a layer stack.
  const ranked = [...elements].sort(
    (a, b) => (a.transform.zIndex ?? 0) - (b.transform.zIndex ?? 0),
  );

  return (
    <div className="space-y-1 rounded border bg-background/60 p-2">
      <div className="flex items-center justify-between">
        <Label className="text-[11px] font-medium text-muted-foreground">
          Image overlays ({elements.length})
        </Label>
        <span className="text-[10px] text-muted-foreground">click to select</span>
      </div>
      <ul className="space-y-1">
        {ranked.map((element, index) => {
          const selected = element.id === selectedId;
          return (
            <li key={element.id}>
              <div
                className={`flex items-center gap-1 rounded border px-1.5 py-1 text-xs transition-colors ${
                  selected
                    ? "border-primary bg-accent"
                    : "border-transparent hover:bg-accent/50"
                }`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onSelect(element.id)}
                  title={`Select ${overlayLabel(element.src)}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {element.src ? (
                    <img
                      src={cachedImage(element.src)}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded border bg-muted object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border bg-muted">
                      <ImagePlus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    Image {index + 1} · {overlayLabel(element.src)}
                  </span>
                </button>
                <LayerButton
                  disabled={false}
                  onClick={() => onReorder(element.id, "up")}
                  label="Bring forward"
                >
                  <ChevronUp className="h-3 w-3" />
                </LayerButton>
                <LayerButton
                  disabled={false}
                  onClick={() => onReorder(element.id, "down")}
                  label="Send backward"
                >
                  <ChevronDown className="h-3 w-3" />
                </LayerButton>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 hover:text-destructive"
                  onClick={() => onDelete(element)}
                  title="Delete image overlay"
                  aria-label={`Delete image overlay ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TextElementPanel({
  element,
  locale,
  onTextChange,
  onTextPatch,
}: {
  element: TextElement;
  locale: string;
  onTextChange: (value: string) => void;
  onTextPatch: (patch: Partial<TextElement>) => void;
}) {
  const text = element.text?.[locale] ?? pickText(element.text, locale);
  return (
    <div className="space-y-2 rounded border bg-muted/30 p-2">
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Text</Label>
        <Textarea
          value={text}
          rows={2}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="Overlay text"
        />
      </div>
      <div className="grid grid-cols-[1fr_76px] gap-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[11px] text-muted-foreground">Size</Label>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {Math.round(element.fontSize || 72)}px
            </span>
          </div>
          <input
            type="range"
            min={12}
            max={400}
            step={1}
            value={Math.round(element.fontSize || 72)}
            onChange={(event) => onTextPatch({ fontSize: Number(event.target.value) || 72 })}
            className="w-full"
            aria-label="Text size"
          />
          <Input
            type="number"
            min={12}
            max={400}
            value={Math.round(element.fontSize || 72)}
            onChange={(event) => onTextPatch({ fontSize: Number(event.target.value) || 72 })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Color</Label>
          <Input
            type="color"
            value={element.color || "#171717"}
            className="h-9 p-1"
            onChange={(event) => onTextPatch({ color: event.target.value })}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <LayerButton
          disabled={false}
          onClick={() => onTextPatch({ align: "left" })}
          label="Align left"
        >
          <AlignLeft className="h-3.5 w-3.5" />
        </LayerButton>
        <LayerButton
          disabled={false}
          onClick={() => onTextPatch({ align: "center" })}
          label="Align center"
        >
          <AlignCenter className="h-3.5 w-3.5" />
        </LayerButton>
        <LayerButton
          disabled={false}
          onClick={() => onTextPatch({ align: "right" })}
          label="Align right"
        >
          <AlignRight className="h-3.5 w-3.5" />
        </LayerButton>
      </div>
    </div>
  );
}

function LayerButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 px-0"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

function TypographySection({
  slide,
  isFeatureGraphic,
  onChange,
}: {
  slide: Slide;
  isFeatureGraphic: boolean;
  onChange: (patch: Partial<Slide>) => void;
}) {
  const scales = slideFontScales(slide);

  function patchTypography(patch: Partial<SlideTypography>) {
    onChange({
      typography: cleanTypography({ ...slide.typography, ...patch }),
    });
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div>
        <Label className="text-xs font-semibold">Typography</Label>
        <p className="text-[11px] text-muted-foreground">
          Relative to the layout default (100%). Applies to this screen only.
        </p>
      </div>
      {!isFeatureGraphic && (
        <FontScaleSlider
          label="Label"
          value={scales.labelScale}
          onChange={(value) => patchTypography({ labelScale: value })}
        />
      )}
      <FontScaleSlider
        label={isFeatureGraphic ? "Tagline" : "Headline"}
        value={scales.headlineScale}
        onChange={(value) => patchTypography({ headlineScale: value })}
      />
      {isFeatureGraphic && (
        <FontScaleSlider
          label="App name"
          value={scales.appNameScale}
          onChange={(value) => patchTypography({ appNameScale: value })}
        />
      )}
    </div>
  );
}

function FontScaleSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const pct = Math.round(value * 100);
  const minPct = Math.round(FONT_SCALE_MIN * 100);
  const maxPct = Math.round(FONT_SCALE_MAX * 100);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">{pct}%</span>
          {pct !== 100 ? (
            <button
              type="button"
              className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => onChange(1)}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>
      <input
        type="range"
        min={minPct}
        max={maxPct}
        step={5}
        value={pct}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="w-full"
        aria-label={`${label} font size`}
      />
    </div>
  );
}

function elementLabel(id: ElementId): string {
  if (isBuiltInElementId(id)) return ELEMENT_LABEL[id];
  if (isImageElementId(id)) return "Image";
  return "Text";
}

function defaultZ(id: ElementId): number {
  if (isTextElementId(id)) return 5;
  if (isImageElementId(id)) return 5;
  if (id === "deviceSecondary") return 2;
  if (id === "device") return 3;
  return 4; // caption on top
}
