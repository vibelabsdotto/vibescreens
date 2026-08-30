#!/usr/bin/env -S npx tsx

import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { storeAsset } from "../lib/asset-store";
import {
  hasValidFontSignature,
  MAX_FONT_ASSET_BYTES,
  MAX_IMAGE_ASSET_BYTES,
  type SupportedFontExtension,
} from "../lib/asset-content";
import { DEFAULT_PROJECT } from "../lib/defaults";
import { buildExportPlan, type ExportScope } from "../lib/export-plan";
import {
  assertDeckId,
  assertVersionId,
  type DeckId,
  type VersionId,
} from "../lib/ids";
import type { DeckInput } from "../lib/project-operations";
import type {
  AppRecord,
  AssetKind,
  AssetRef,
  DeckRecord,
  ProjectDocumentV3,
  VersionRecord,
} from "../lib/project-schema";
import { parseManagedAssetUrl } from "../lib/project-schema";
import {
  createWorkspaceProjectService,
  type WorkspaceProjectService,
} from "../lib/server-service";
import { sniffImageType } from "../lib/request-guard";
import {
  cleanTypography,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
} from "../lib/typography";
import type {
  BuiltInElementId,
  Device,
  ElementId,
  ElementTransform,
  ImageElement,
  Orientation,
  Slide,
  SlideLayout,
  TextElement,
} from "../lib/types";
import { assertProjectId, type ProjectId } from "../lib/workspace";
import { getCanvas, getElementTransform } from "../components/editor/slide-canvas";
import type { BrowserExportInput, BrowserExportResult } from "./browser-export";

const DEVICES = new Set<Device>([
  "iphone",
  "ipad",
  "tvos",
  "watchos",
  "carplay",
  "android",
  "android-7",
  "android-10",
  "macos",
  "windows",
  "feature-graphic",
]);
const ORIENTATIONS = new Set<Orientation>(["portrait", "landscape"]);
const SLIDE_LAYOUTS = new Set<SlideLayout>([
  "hero",
  "device-bottom",
  "device-top",
  "two-devices",
  "no-device",
  "split-landscape",
  "feature-graphic",
]);
const ASSET_KINDS = new Set<AssetKind>(["screenshot", "image", "font", "app-icon"]);
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SLIDE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const COMMANDS = [
  "workspace show",
  "workspace import",
  "project list",
  "project create",
  "project show",
  "project select",
  "project rename",
  "project delete",
  "version list",
  "version create",
  "version clone",
  "version select",
  "version rename",
  "version publish",
  "version delete",
  "deck list",
  "deck create",
  "deck select",
  "deck update",
  "deck reset",
  "deck delete",
  "slide list",
  "slide add",
  "slide duplicate",
  "slide reorder",
  "slide update",
  "slide delete",
  "element list",
  "element add",
  "element update",
  "element reorder",
  "element delete",
  "asset list",
  "asset import",
  "export plan",
  "export bundle",
] as const;

export interface VibeScreensCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface VibeScreensCliDependencies {
  exportBundle(input: BrowserExportInput): Promise<BrowserExportResult>;
}

interface ParsedArguments {
  rootDir: string;
  positionals: string[];
  flags: Map<string, string>;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function defaultIo(): VibeScreensCliIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

function emit(io: VibeScreensCliIo, channel: "stdout" | "stderr", value: unknown): void {
  io[channel](JSON.stringify(value));
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let rootDir = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name.length === 0 || flags.has(name)) {
      throw new CliUsageError(`Invalid or duplicate flag: ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Flag ${token} requires a value`);
    }
    index += 1;
    if (name === "root") {
      rootDir = value;
    } else {
      flags.set(name, value);
    }
  }
  return { rootDir, positionals, flags };
}

function validateFlags(flags: Map<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const flag of flags.keys()) {
    if (!allowedSet.has(flag)) throw new CliUsageError(`Unknown flag: --${flag}`);
  }
}

function commaSeparatedFlag(flags: Map<string, string>, name: string): string[] | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new CliUsageError(`--${name} must be a unique comma-separated list`);
  }
  return values;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new CliUsageError(`--${name} is required`);
  return value;
}

function optionalProjectId(flags: Map<string, string>): ProjectId | undefined {
  const value = flags.get("project");
  if (value === undefined) return undefined;
  assertProjectId(value);
  return value;
}

function optionalVersionId(flags: Map<string, string>): VersionId | undefined {
  const value = flags.get("version");
  if (value === undefined) return undefined;
  assertVersionId(value);
  return value;
}

function optionalDeckId(flags: Map<string, string>): DeckId | undefined {
  const value = flags.get("deck");
  if (value === undefined) return undefined;
  assertDeckId(value);
  return value;
}

function parseDevice(value: string | undefined, fallback: Device): Device {
  if (value === undefined) return fallback;
  if (!DEVICES.has(value as Device)) throw new CliUsageError(`Unsupported device: ${value}`);
  return value as Device;
}

function parseOrientation(value: string | undefined, fallback: Orientation): Orientation {
  if (value === undefined) return fallback;
  if (!ORIENTATIONS.has(value as Orientation)) {
    throw new CliUsageError(`Unsupported orientation: ${value}`);
  }
  return value as Orientation;
}

function parseLocale(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const locale = value.trim();
  if (!LOCALE_PATTERN.test(locale)) throw new CliUsageError(`Invalid locale: ${value}`);
  return locale;
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliUsageError(`--${name} must be true or false`);
}

function parseSlideLayout(value: string | undefined, fallback: SlideLayout): SlideLayout {
  if (value === undefined) return fallback;
  if (!SLIDE_LAYOUTS.has(value as SlideLayout)) {
    throw new CliUsageError(`Unsupported slide layout: ${value}`);
  }
  return value as SlideLayout;
}

function requiredSlideId(flags: Map<string, string>, name = "slide"): string {
  const id = requiredFlag(flags, name);
  if (!SLIDE_ID_PATTERN.test(id)) {
    throw new CliUsageError(`Invalid slide ID: ${id}`);
  }
  return id;
}

function optionalFiniteNumber(
  flags: Map<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new CliUsageError(`--${name} must not be blank`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CliUsageError(`--${name} must be finite`);
  return value;
}

function finiteNumberFlag(flags: Map<string, string>, name: string): number | undefined {
  if (!flags.has(name)) return undefined;
  return optionalFiniteNumber(flags, name, 0);
}

function boundedNumberFlag(
  flags: Map<string, string>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = finiteNumberFlag(flags, name);
  if (value !== undefined && (value < minimum || value > maximum)) {
    throw new CliUsageError(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseAssetKind(value: string | undefined): AssetKind {
  if (value === undefined || !ASSET_KINDS.has(value as AssetKind)) {
    throw new CliUsageError(`Unsupported asset kind: ${String(value)}`);
  }
  return value as AssetKind;
}

function projectSummary(project: ProjectDocumentV3) {
  const app = resolveApp(project);
  return {
    id: project.projectId,
    name: project.name,
    revision: project.revision,
    updatedAt: project.updatedAt,
    versions: app.versionOrder.length,
    selection: {
      versionId: project.selection.versionId,
      deckId: project.selection.deckId,
      slideId: project.selection.slideId,
    },
  };
}

function versionSummary(version: VersionRecord) {
  return {
    id: version.id,
    name: version.name,
    status: version.status,
    decks: version.deckOrder.length,
    updatedAt: version.updatedAt,
  };
}

function deckSummary(deck: DeckRecord) {
  return {
    id: deck.id,
    device: deck.device,
    orientation: deck.orientation,
    locale: deck.locale,
    slides: deck.slides.length,
    themeId: deck.themeId,
    fontId: deck.fontId,
  };
}

function assetSummary(asset: AssetRef) {
  return {
    id: asset.id,
    versionId: asset.scope.versionId,
    kind: asset.kind,
    originalName: asset.originalName,
    mime: asset.mime,
    bytes: asset.bytes,
    sha256: asset.sha256,
    extension: asset.extension,
    url: asset.url,
  };
}

function localizedValue(value: Slide["headline"], locale: string): string {
  return value[locale] ?? value.en ?? Object.values(value).find(Boolean) ?? "";
}

function slideSummary(slide: Slide, locale: string) {
  return {
    id: slide.id,
    layout: slide.layout,
    label: localizedValue(slide.label, locale),
    headline: localizedValue(slide.headline, locale),
    screenshot: slide.screenshot,
    screenshotSecondary: slide.screenshotSecondary,
    inverted: slide.inverted ?? false,
    backgroundColor: slide.backgroundColor,
  };
}

function selectedRecords(project: ProjectDocumentV3): {
  app: AppRecord;
  version: VersionRecord;
  deck: DeckRecord;
} {
  const { appId, versionId, deckId } = project.selection;
  const app = project.appsById[appId];
  const version = app?.versionsById[versionId];
  const deck = version?.decksById[deckId];
  if (app === undefined || version === undefined || deck === undefined) {
    throw new Error("Project selection is invalid");
  }
  return { app, version, deck };
}

async function resolveProject(
  service: WorkspaceProjectService,
  projectId?: ProjectId,
): Promise<ProjectDocumentV3> {
  if (projectId !== undefined) return service.getProject(projectId);
  const snapshot = await service.getWorkspace();
  if (snapshot.workspace.activeProjectId === null) {
    throw new CliUsageError("No active project. Create or select a project first");
  }
  return service.getProject(snapshot.workspace.activeProjectId);
}

function resolveApp(project: ProjectDocumentV3): AppRecord {
  if (project.appOrder.length !== 1) {
    throw new CliUsageError(
      `Project ${project.projectId} has ${project.appOrder.length} legacy app records; migrate it to Project = App before using the CLI`,
    );
  }
  const id = project.appOrder[0];
  const app = project.appsById[id];
  if (app === undefined) {
    throw new Error(`Project ${project.projectId} is missing its app compatibility record`);
  }
  return app;
}

function resolveVersion(
  project: ProjectDocumentV3,
  app: AppRecord,
  versionId?: VersionId,
): VersionRecord {
  const id = versionId ?? (app.id === project.selection.appId ? project.selection.versionId : app.versionOrder[0]);
  const version = app.versionsById[id];
  if (version === undefined) throw new CliUsageError(`Version ${id} does not exist`);
  return version;
}

function resolveDeck(
  project: ProjectDocumentV3,
  app: AppRecord,
  version: VersionRecord,
  deckId?: DeckId,
): DeckRecord {
  const id =
    deckId ??
    (app.id === project.selection.appId && version.id === project.selection.versionId
      ? project.selection.deckId
      : version.deckOrder[0]);
  const deck = version.decksById[id];
  if (deck === undefined) throw new CliUsageError(`Deck ${id} does not exist`);
  return deck;
}

function initialDeck(
  project: ProjectDocumentV3,
  flags: Map<string, string>,
  source: DeckRecord = selectedRecords(project).deck,
): DeckInput {
  const device = parseDevice(flags.get("device"), source.device);
  const sameDevice = source.device === device;
  const defaultOrientation: Orientation = ["tvos", "macos", "windows", "feature-graphic"].includes(device)
    ? "landscape"
    : "portrait";
  return {
    device,
    orientation: parseOrientation(
      flags.get("orientation"),
      sameDevice ? source.orientation : defaultOrientation,
    ),
    locale: parseLocale(flags.get("locale"), source.locale),
    connectedCanvas: source.connectedCanvas,
    appName: flags.get("app-name")?.trim() || source.appName,
    themeId: flags.get("theme")?.trim() || source.themeId,
    fontId: flags.get("font")?.trim() || source.fontId,
    importedFont: source.importedFont,
    appIcon: source.appIcon,
    crossScreenMockups: sameDevice ? source.crossScreenMockups : undefined,
    slides: structuredClone(
      sameDevice ? source.slides : (DEFAULT_PROJECT.slidesByDevice[device] ?? []),
    ),
  };
}

const BUILT_IN_ELEMENTS = new Set<BuiltInElementId>([
  "caption",
  "device",
  "deviceSecondary",
]);

type ResolvedElement =
  | { type: "built-in"; id: BuiltInElementId; elementId: BuiltInElementId }
  | { type: "text"; id: string; elementId: `text:${string}`; element: TextElement }
  | { type: "image"; id: string; elementId: `image:${string}`; element: ImageElement };

function presentElementIds(slide: Slide): ElementId[] {
  const ids: ElementId[] = ["caption"];
  if (slide.layout !== "no-device" && slide.layout !== "feature-graphic") ids.push("device");
  if (slide.layout === "two-devices") ids.push("deviceSecondary");
  for (const element of slide.textElements ?? []) ids.push(`text:${element.id}`);
  for (const element of slide.imageElements ?? []) ids.push(`image:${element.id}`);
  return ids;
}

function resolveElement(slide: Slide, rawId: string): ResolvedElement {
  if (BUILT_IN_ELEMENTS.has(rawId as BuiltInElementId)) {
    const id = rawId as BuiltInElementId;
    if (!presentElementIds(slide).includes(id)) {
      throw new CliUsageError(`Element ${rawId} is not present in layout ${slide.layout}`);
    }
    return { type: "built-in", id, elementId: id };
  }
  const text = slide.textElements?.find((element) => element.id === rawId);
  if (text !== undefined) return { type: "text", id: rawId, elementId: `text:${rawId}`, element: text };
  const image = slide.imageElements?.find((element) => element.id === rawId);
  if (image !== undefined) return { type: "image", id: rawId, elementId: `image:${rawId}`, element: image };
  throw new CliUsageError(`Element ${rawId} does not exist`);
}

function exportScope(flags: Map<string, string>, project: ProjectDocumentV3): ExportScope {
  const kind = flags.get("scope") ?? "current";
  if (kind !== "current" && kind !== "selected" && kind !== "all") {
    throw new CliUsageError("--scope must be current, selected, or all");
  }
  const deckIds = commaSeparatedFlag(flags, "decks")?.map((value) => {
    assertDeckId(value);
    return value;
  });
  const includeDrafts = parseBoolean(flags.get("include-drafts"), "include-drafts");
  const versionIds = commaSeparatedFlag(flags, "versions");
  if (kind === "current") {
    if (includeDrafts !== undefined || versionIds !== undefined) {
      throw new CliUsageError("--include-drafts and --versions do not apply to --scope current");
    }
    return { kind, ...(deckIds === undefined ? {} : { deckIds }) };
  }
  if (kind === "selected") {
    if (includeDrafts !== undefined) {
      throw new CliUsageError("--include-drafts only applies to --scope all");
    }
    if (versionIds === undefined) throw new CliUsageError("--versions is required for --scope selected");
    const app = resolveApp(project);
    const versions = versionIds.map((versionId) => {
      assertVersionId(versionId);
      if (app.versionsById[versionId] === undefined) {
        throw new CliUsageError(`Version ${versionId} does not exist`);
      }
      return { appId: app.id, versionId };
    });
    return { kind, versions, ...(deckIds === undefined ? {} : { deckIds }) };
  }
  if (versionIds !== undefined) throw new CliUsageError("--versions only applies to --scope selected");
  return {
    kind,
    includeDrafts: includeDrafts ?? false,
    ...(deckIds === undefined ? {} : { deckIds }),
  };
}

async function managedAssetExists(rootDir: string, url: string): Promise<boolean> {
  const parsed = parseManagedAssetUrl(url);
  if (parsed === undefined) return false;
  try {
    const bytes = await readFile(join(rootDir, "public", url.slice(1)));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return sha256 === parsed.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function elementSummary(
  slide: Slide,
  deck: DeckRecord,
  resolved: ResolvedElement,
): Record<string, unknown> {
  const transform = getElementTransform(
    slide,
    deck.device,
    deck.orientation,
    resolved.elementId,
  );
  if (resolved.type === "built-in") {
    return { id: resolved.id, type: "built-in", transform };
  }
  if (resolved.type === "text") {
    return {
      id: resolved.id,
      type: "text",
      text: localizedValue(resolved.element.text, deck.locale),
      transform,
      fontSize: resolved.element.fontSize,
      fontWeight: resolved.element.fontWeight,
      color: resolved.element.color,
      align: resolved.element.align,
    };
  }
  return {
    id: resolved.id,
    type: "image",
    src: resolved.element.src,
    transform,
    fit: resolved.element.fit ?? "cover",
    fade: resolved.element.fade,
  };
}

function transformPatch(flags: Map<string, string>): Partial<ElementTransform> {
  const patch: Partial<ElementTransform> = {};
  for (const name of ["x", "y", "width", "height", "rotation", "z-index"] as const) {
    const value = finiteNumberFlag(flags, name);
    if (value !== undefined) {
      if ((name === "width" || name === "height") && value <= 0) {
        throw new CliUsageError(`--${name} must be greater than zero`);
      }
      if (name === "rotation" && (value < -180 || value > 180)) {
        throw new CliUsageError("--rotation must be between -180 and 180");
      }
      if (name === "z-index" && (!Number.isInteger(value) || value < 0)) {
        throw new CliUsageError("--z-index must be a non-negative integer");
      }
      patch[name === "z-index" ? "zIndex" : name] = value;
    }
  }
  return patch;
}

async function execute(
  parsed: ParsedArguments,
  service: WorkspaceProjectService,
  dependencies: VibeScreensCliDependencies,
): Promise<Record<string, unknown>> {
  const [resource, action, ...extra] = parsed.positionals;
  if (resource === undefined || action === undefined || extra.length > 0) {
    throw new CliUsageError("Expected: <resource> <action> [--flags]");
  }
  const command = `${resource} ${action}`;

  if (command === "workspace show") {
    validateFlags(parsed.flags, []);
    const snapshot = await service.getWorkspace();
    return { ok: true, command, workspace: snapshot.workspace, projects: snapshot.projects };
  }

  if (command === "workspace import") {
    validateFlags(parsed.flags, []);
    const snapshot = await service.getWorkspace();
    const result = await service.executeWorkspaceCommand({
      action: "importLegacy",
      baseRevision: snapshot.workspace.revision,
    });
    return {
      ok: true,
      command,
      workspace: result.workspace,
      importResult: result.importResult.status === "imported"
        ? {
            status: result.importResult.status,
            project: projectSummary(result.importResult.project),
            sourceFile: result.importResult.sourceFile,
            backupPath: result.importResult.backupPath,
            warnings: result.importResult.warnings,
          }
        : result.importResult,
    };
  }

  if (command === "project list") {
    validateFlags(parsed.flags, []);
    const snapshot = await service.getWorkspace();
    return { ok: true, command, activeProjectId: snapshot.workspace.activeProjectId, projects: snapshot.projects };
  }

  if (command === "project create") {
    validateFlags(parsed.flags, ["name"]);
    const snapshot = await service.getWorkspace();
    const result = await service.executeWorkspaceCommand({
      action: "create",
      baseRevision: snapshot.workspace.revision,
      name: requiredFlag(parsed.flags, "name"),
    });
    return { ok: true, command, project: projectSummary(result.project) };
  }

  if (command === "project show") {
    validateFlags(parsed.flags, ["project"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    return {
      ok: true,
      command,
      project: projectSummary(project),
      versions: app.versionOrder.map((id) => versionSummary(app.versionsById[id])),
    };
  }

  if (command === "project select") {
    validateFlags(parsed.flags, ["project"]);
    const projectId = optionalProjectId(parsed.flags);
    if (projectId === undefined) throw new CliUsageError("--project is required");
    const snapshot = await service.getWorkspace();
    const result = await service.executeWorkspaceCommand({
      action: "switch",
      baseRevision: snapshot.workspace.revision,
      projectId,
    });
    return { ok: true, command, activeProjectId: result.workspace.activeProjectId };
  }

  if (command === "project rename") {
    validateFlags(parsed.flags, ["project", "name"]);
    const snapshot = await service.getWorkspace();
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const result = await service.executeWorkspaceCommand({
      action: "rename",
      baseWorkspaceRevision: snapshot.workspace.revision,
      baseProjectRevision: project.revision,
      projectId: project.projectId,
      name: requiredFlag(parsed.flags, "name"),
    });
    return { ok: true, command, project: projectSummary(result.project) };
  }

  if (command === "project delete") {
    validateFlags(parsed.flags, ["project"]);
    const snapshot = await service.getWorkspace();
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const result = await service.executeWorkspaceCommand({
      action: "delete",
      baseRevision: snapshot.workspace.revision,
      projectId: project.projectId,
    });
    return { ok: true, command, deletedProjectId: project.projectId, trash: result.trash };
  }

  if (command === "version list") {
    validateFlags(parsed.flags, ["project"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    return {
      ok: true,
      command,
      project: projectSummary(project),
      versions: app.versionOrder.map((id) => versionSummary(app.versionsById[id])),
    };
  }

  if (command === "version create") {
    validateFlags(parsed.flags, [
      "project", "name", "device", "orientation", "locale", "app-name", "theme", "font",
    ]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const sourceVersion = resolveVersion(project, app);
    const sourceDeck = resolveDeck(project, app, sourceVersion);
    const result = await service.executeProjectCommand(project.projectId, {
      action: "createVersion",
      baseRevision: project.revision,
      name: requiredFlag(parsed.flags, "name"),
      initialDeck: initialDeck(project, parsed.flags, sourceDeck),
    });
    const selected = selectedRecords(result.project);
    return {
      ok: true,
      command,
      project: projectSummary(result.project),
      version: versionSummary(selected.version),
      deck: deckSummary(selected.deck),
    };
  }

  if (command === "version clone") {
    validateFlags(parsed.flags, ["project", "version", "name"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const result = await service.executeProjectCommand(project.projectId, {
      action: "cloneVersion",
      baseRevision: project.revision,
      sourceVersionId: version.id,
      name: requiredFlag(parsed.flags, "name"),
    });
    return {
      ok: true,
      command,
      project: projectSummary(result.project),
      version: versionSummary(selectedRecords(result.project).version),
    };
  }

  if (command === "version select") {
    validateFlags(parsed.flags, ["project", "version", "deck"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const versionId = optionalVersionId(parsed.flags);
    if (versionId === undefined) throw new CliUsageError("--version is required");
    const version = resolveVersion(project, app, versionId);
    const result = await service.executeProjectCommand(project.projectId, {
      action: "selectVersion",
      baseRevision: project.revision,
      versionId: version.id,
      deckId: optionalDeckId(parsed.flags),
    });
    const selected = selectedRecords(result.project);
    return {
      ok: true,
      command,
      project: projectSummary(result.project),
      version: versionSummary(selected.version),
      deck: deckSummary(selected.deck),
    };
  }

  if (command === "version rename" || command === "version publish" || command === "version delete") {
    validateFlags(parsed.flags, command === "version rename"
      ? ["project", "version", "name"]
      : ["project", "version"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const result = await service.executeProjectCommand(project.projectId,
      command === "version rename"
        ? { action: "renameVersion", baseRevision: project.revision, versionId: version.id, name: requiredFlag(parsed.flags, "name") }
        : command === "version publish"
          ? { action: "publishVersion", baseRevision: project.revision, versionId: version.id }
          : { action: "deleteVersion", baseRevision: project.revision, versionId: version.id });
    return {
      ok: true,
      command,
      project: projectSummary(result.project),
      ...(command === "version delete"
        ? {
            deletedVersionId: version.id,
            ...(result.assetCleanupPending ? { assetCleanupPending: true } : {}),
          }
        : { version: versionSummary(resolveApp(result.project).versionsById[version.id]) }),
    };
  }

  if (command === "deck list") {
    validateFlags(parsed.flags, ["project", "version"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    return {
      ok: true,
      command,
      project: projectSummary(project),
      version: versionSummary(version),
      decks: version.deckOrder.map((id) => deckSummary(version.decksById[id])),
    };
  }

  if (command === "deck create") {
    validateFlags(parsed.flags, [
      "project",
      "version",
      "device",
      "orientation",
      "locale",
      "app-name",
      "theme",
      "font",
    ]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const sourceDeck = resolveDeck(project, app, version);
    const result = await service.executeProjectCommand(project.projectId, {
      action: "createDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deck: initialDeck(project, parsed.flags, sourceDeck),
    });
    const selected = selectedRecords(result.project);
    return { ok: true, command, project: projectSummary(result.project), deck: deckSummary(selected.deck) };
  }

  if (command === "deck select") {
    validateFlags(parsed.flags, ["project", "version", "deck"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deckId = optionalDeckId(parsed.flags);
    if (deckId === undefined) throw new CliUsageError("--deck is required");
    const result = await service.executeProjectCommand(project.projectId, {
      action: "selectDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deckId,
    });
    return { ok: true, command, project: projectSummary(result.project), deck: deckSummary(selectedRecords(result.project).deck) };
  }

  if (command === "deck update") {
    validateFlags(parsed.flags, [
      "project", "version", "deck", "device", "orientation", "locale",
      "app-name", "theme", "font", "connected-canvas",
    ]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    const changes: Partial<Omit<DeckRecord, "id">> = {};
    if (parsed.flags.has("device")) changes.device = parseDevice(parsed.flags.get("device"), deck.device);
    if (parsed.flags.has("orientation")) changes.orientation = parseOrientation(parsed.flags.get("orientation"), deck.orientation);
    if (parsed.flags.has("locale")) changes.locale = parseLocale(parsed.flags.get("locale"), deck.locale);
    if (parsed.flags.has("app-name")) changes.appName = requiredFlag(parsed.flags, "app-name");
    if (parsed.flags.has("theme")) changes.themeId = requiredFlag(parsed.flags, "theme");
    if (parsed.flags.has("font")) changes.fontId = requiredFlag(parsed.flags, "font") as DeckRecord["fontId"];
    if (parsed.flags.has("connected-canvas")) {
      changes.connectedCanvas = parseBoolean(parsed.flags.get("connected-canvas"), "connected-canvas");
    }
    if (Object.keys(changes).length === 0) throw new CliUsageError("No deck changes supplied");
    const result = await service.executeProjectCommand(project.projectId, {
      action: "updateDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deckId: deck.id,
      changes,
    });
    const updatedApp = resolveApp(result.project);
    const updatedDeck = resolveDeck(
      result.project,
      updatedApp,
      updatedApp.versionsById[version.id],
      deck.id,
    );
    return { ok: true, command, project: projectSummary(result.project), deck: deckSummary(updatedDeck) };
  }

  if (command === "deck reset") {
    validateFlags(parsed.flags, ["project", "version", "deck"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    const result = await service.executeProjectCommand(project.projectId, {
      action: "updateDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deckId: deck.id,
      changes: { slides: structuredClone(DEFAULT_PROJECT.slidesByDevice[deck.device]) },
    });
    const updatedApp = resolveApp(result.project);
    const updatedDeck = resolveDeck(
      result.project,
      updatedApp,
      updatedApp.versionsById[version.id],
      deck.id,
    );
    return { ok: true, command, project: projectSummary(result.project), deck: deckSummary(updatedDeck) };
  }

  if (command === "deck delete") {
    validateFlags(parsed.flags, ["project", "version", "deck"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    const result = await service.executeProjectCommand(project.projectId, {
      action: "deleteDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deckId: deck.id,
    });
    return { ok: true, command, deletedDeckId: deck.id, project: projectSummary(result.project) };
  }

  if (command === "slide list") {
    validateFlags(parsed.flags, ["project", "version", "deck"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    return {
      ok: true,
      command,
      project: projectSummary(project),
      deck: deckSummary(deck),
      slides: deck.slides.map((slide) => slideSummary(slide, deck.locale)),
    };
  }

  if (["slide add", "slide duplicate", "slide reorder", "slide update", "slide delete"].includes(command)) {
    const baseFlags = ["project", "version", "deck", "slide"];
    const contentFlags = [
      ...baseFlags,
      "id",
      "label",
      "headline",
      "screenshot",
      "screenshot-secondary",
      "layout",
      "inverted",
      "background",
      "label-scale",
      "headline-scale",
      "app-name-scale",
    ];
    validateFlags(
      parsed.flags,
      command === "slide add" || command === "slide update"
        ? contentFlags
        : command === "slide duplicate"
          ? [...baseFlags, "id"]
          : command === "slide reorder"
            ? [...baseFlags, "index"]
            : baseFlags,
    );
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    const slides = structuredClone(deck.slides);
    let changedSlide: Slide | undefined;

    if (command === "slide add") {
      const requestedId = parsed.flags.get("id")?.trim();
      const id = requestedId || `slide-${globalThis.crypto.randomUUID()}`;
      if (!SLIDE_ID_PATTERN.test(id)) throw new CliUsageError(`Invalid slide ID: ${id}`);
      if (slides.some((slide) => slide.id === id)) throw new CliUsageError(`Slide ${id} already exists`);
      changedSlide = {
        id,
        layout: parseSlideLayout(parsed.flags.get("layout"), "hero"),
        label: { [deck.locale]: parsed.flags.get("label") ?? "" },
        headline: { [deck.locale]: requiredFlag(parsed.flags, "headline") },
        screenshot: parsed.flags.get("screenshot") ?? "",
      };
      const secondary = parsed.flags.get("screenshot-secondary")?.trim();
      if (secondary) changedSlide.screenshotSecondary = secondary;
      const inverted = parseBoolean(parsed.flags.get("inverted"), "inverted");
      if (inverted !== undefined) changedSlide.inverted = inverted;
      const background = parsed.flags.get("background")?.trim();
      if (background && background !== "none") changedSlide.backgroundColor = background;
      const typography = cleanTypography({
        labelScale: boundedNumberFlag(parsed.flags, "label-scale", FONT_SCALE_MIN, FONT_SCALE_MAX),
        headlineScale: boundedNumberFlag(parsed.flags, "headline-scale", FONT_SCALE_MIN, FONT_SCALE_MAX),
        appNameScale: boundedNumberFlag(parsed.flags, "app-name-scale", FONT_SCALE_MIN, FONT_SCALE_MAX),
      });
      if (typography !== undefined) changedSlide.typography = typography;
      slides.push(changedSlide);
    } else {
      const slideId = requiredSlideId(parsed.flags);
      const index = slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) throw new CliUsageError(`Slide ${slideId} does not exist`);

      if (command === "slide delete") {
        [changedSlide] = slides.splice(index, 1);
      } else if (command === "slide duplicate") {
        const requestedId = parsed.flags.get("id")?.trim();
        const id = requestedId || `slide-${globalThis.crypto.randomUUID()}`;
        if (!SLIDE_ID_PATTERN.test(id)) throw new CliUsageError(`Invalid slide ID: ${id}`);
        if (slides.some((slide) => slide.id === id)) throw new CliUsageError(`Slide ${id} already exists`);
        changedSlide = structuredClone(slides[index]);
        changedSlide.id = id;
        changedSlide.textElements = changedSlide.textElements?.map((element) => ({
          ...element,
          id: globalThis.crypto.randomUUID(),
        }));
        changedSlide.imageElements = changedSlide.imageElements?.map((element) => ({
          ...element,
          id: globalThis.crypto.randomUUID(),
        }));
        slides.splice(index + 1, 0, changedSlide);
      } else if (command === "slide reorder") {
        const targetIndex = finiteNumberFlag(parsed.flags, "index");
        if (targetIndex === undefined || !Number.isInteger(targetIndex)) {
          throw new CliUsageError("--index must be an integer");
        }
        if (targetIndex < 0 || targetIndex >= slides.length) {
          throw new CliUsageError(`--index must be between 0 and ${slides.length - 1}`);
        }
        [changedSlide] = slides.splice(index, 1);
        slides.splice(targetIndex, 0, changedSlide);
      } else {
        changedSlide = slides[index];
        if (parsed.flags.has("label")) changedSlide.label[deck.locale] = parsed.flags.get("label") ?? "";
        if (parsed.flags.has("headline")) changedSlide.headline[deck.locale] = parsed.flags.get("headline") ?? "";
        if (parsed.flags.has("screenshot")) changedSlide.screenshot = parsed.flags.get("screenshot") ?? "";
        if (parsed.flags.has("screenshot-secondary")) {
          const secondary = parsed.flags.get("screenshot-secondary")?.trim();
          if (secondary && secondary !== "none") changedSlide.screenshotSecondary = secondary;
          else delete changedSlide.screenshotSecondary;
        }
        if (parsed.flags.has("layout")) {
          const layout = parseSlideLayout(parsed.flags.get("layout"), changedSlide.layout);
          if (layout !== changedSlide.layout) {
            delete changedSlide.transforms;
            if (layout === "two-devices" && !changedSlide.screenshotSecondary) {
              changedSlide.screenshotSecondary = changedSlide.screenshot;
            } else if (layout !== "two-devices") {
              delete changedSlide.screenshotSecondary;
            }
          }
          changedSlide.layout = layout;
        }
        const inverted = parseBoolean(parsed.flags.get("inverted"), "inverted");
        if (inverted !== undefined) changedSlide.inverted = inverted;
        if (parsed.flags.has("background")) {
          const background = parsed.flags.get("background")?.trim();
          if (background && background !== "none") changedSlide.backgroundColor = background;
          else delete changedSlide.backgroundColor;
        }
        const typography = cleanTypography({
          ...changedSlide.typography,
          ...(parsed.flags.has("label-scale")
            ? { labelScale: boundedNumberFlag(parsed.flags, "label-scale", FONT_SCALE_MIN, FONT_SCALE_MAX) }
            : {}),
          ...(parsed.flags.has("headline-scale")
            ? { headlineScale: boundedNumberFlag(parsed.flags, "headline-scale", FONT_SCALE_MIN, FONT_SCALE_MAX) }
            : {}),
          ...(parsed.flags.has("app-name-scale")
            ? { appNameScale: boundedNumberFlag(parsed.flags, "app-name-scale", FONT_SCALE_MIN, FONT_SCALE_MAX) }
            : {}),
        });
        if (typography === undefined) delete changedSlide.typography;
        else changedSlide.typography = typography;
      }
    }

    const result = await service.executeProjectCommand(project.projectId, {
      action: "updateDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deckId: deck.id,
      changes: { slides },
    });
    return {
      ok: true,
      command,
      project: projectSummary(result.project),
      ...(command === "slide delete"
        ? { deletedSlideId: changedSlide?.id }
        : command === "slide reorder"
          ? { slide: slideSummary(changedSlide!, deck.locale), index: slides.indexOf(changedSlide!) }
          : { slide: slideSummary(changedSlide!, deck.locale) }),
    };
  }

  if (["element list", "element add", "element update", "element reorder", "element delete"].includes(command)) {
    const scopeFlags = ["project", "version", "deck", "slide"];
    const transformFlags = ["x", "y", "width", "height", "rotation", "z-index"];
    const styleFlags = [
      "text", "src", "font-size", "font-weight", "color", "align", "fit", "fade-edge", "fade-amount",
    ];
    validateFlags(
      parsed.flags,
      command === "element list"
        ? scopeFlags
        : command === "element add"
          ? [...scopeFlags, "type", "id", ...transformFlags, ...styleFlags]
          : command === "element update"
            ? [...scopeFlags, "element", ...transformFlags, ...styleFlags]
            : command === "element reorder"
              ? [...scopeFlags, "element", "position"]
              : [...scopeFlags, "element"],
    );
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    const slideId = requiredSlideId(parsed.flags);
    const originalSlide = deck.slides.find((slide) => slide.id === slideId);
    if (originalSlide === undefined) throw new CliUsageError(`Slide ${slideId} does not exist`);

    if (command === "element list") {
      return {
        ok: true,
        command,
        project: projectSummary(project),
        slide: slideSummary(originalSlide, deck.locale),
        elements: presentElementIds(originalSlide).map((elementId) =>
          elementSummary(
            originalSlide,
            deck,
            resolveElement(
              originalSlide,
              elementId.startsWith("text:") || elementId.startsWith("image:")
                ? elementId.slice(elementId.indexOf(":") + 1)
                : elementId,
            ),
          ),
        ),
      };
    }

    const slides = structuredClone(deck.slides);
    const slide = slides.find((item) => item.id === slideId)!;
    let changedElementId: string;

    const setTransform = (resolved: ResolvedElement, transform: ElementTransform): void => {
      if (resolved.type === "built-in") {
        slide.transforms ??= {};
        slide.transforms[resolved.id] = transform;
      } else {
        resolved.element.transform = transform;
      }
    };

    if (command === "element add") {
      const type = requiredFlag(parsed.flags, "type");
      if (type !== "text" && type !== "image") {
        throw new CliUsageError("--type must be text or image");
      }
      const id = parsed.flags.get("id")?.trim() || globalThis.crypto.randomUUID();
      if (!SLIDE_ID_PATTERN.test(id) || BUILT_IN_ELEMENTS.has(id as BuiltInElementId)) {
        throw new CliUsageError(`Invalid element ID: ${id}`);
      }
      if (
        slide.textElements?.some((element) => element.id === id) ||
        slide.imageElements?.some((element) => element.id === id)
      ) {
        throw new CliUsageError(`Element ${id} already exists`);
      }
      const { cW, cH } = getCanvas(deck.device, deck.orientation);
      const highestZ = Math.max(
        5,
        ...presentElementIds(slide).map(
          (elementId) =>
            getElementTransform(slide, deck.device, deck.orientation, elementId)?.zIndex ?? 5,
        ),
      );
      const defaults: ElementTransform = type === "text"
        ? {
            x: cW * 0.18,
            y: cH * 0.42,
            width: cW * 0.64,
            height: cH * 0.12,
            rotation: 0,
            zIndex: highestZ + 1,
          }
        : {
            x: cW * 0.25,
            y: cH * 0.25,
            width: cW * 0.5,
            height: cH * 0.5,
            rotation: 0,
            zIndex: highestZ + 1,
          };
      const transform = { ...defaults, ...transformPatch(parsed.flags) };
      if (type === "text") {
        const fontSize = finiteNumberFlag(parsed.flags, "font-size") ?? Math.round(Math.min(cW, cH) * 0.065);
        const fontWeight = finiteNumberFlag(parsed.flags, "font-weight") ?? 800;
        if (fontSize <= 0) throw new CliUsageError("--font-size must be greater than zero");
        if (!Number.isInteger(fontWeight) || fontWeight < 1 || fontWeight > 1000) {
          throw new CliUsageError("--font-weight must be an integer between 1 and 1000");
        }
        const align = parsed.flags.get("align") ?? "center";
        if (!(["left", "center", "right"] as const).includes(align as "left" | "center" | "right")) {
          throw new CliUsageError("--align must be left, center, or right");
        }
        slide.textElements ??= [];
        slide.textElements.push({
          id,
          text: { [deck.locale]: parsed.flags.get("text") ?? "New text" },
          transform,
          fontSize,
          fontWeight,
          ...(parsed.flags.has("color") ? { color: requiredFlag(parsed.flags, "color") } : {}),
          align: align as "left" | "center" | "right",
        });
      } else {
        const fit = parsed.flags.get("fit") ?? "cover";
        if (fit !== "cover" && fit !== "contain") {
          throw new CliUsageError("--fit must be cover or contain");
        }
        const fadeEdge = parsed.flags.get("fade-edge");
        const fadeAmount = boundedNumberFlag(parsed.flags, "fade-amount", 1, 100);
        if (fadeEdge !== undefined && !["top", "bottom", "left", "right"].includes(fadeEdge)) {
          throw new CliUsageError("--fade-edge must be top, bottom, left, or right");
        }
        if (fadeAmount !== undefined && fadeEdge === undefined) {
          throw new CliUsageError("--fade-edge is required with --fade-amount");
        }
        slide.imageElements ??= [];
        slide.imageElements.push({
          id,
          src: parsed.flags.get("src") ?? "",
          transform,
          fit,
          ...(fadeEdge === undefined
            ? {}
            : {
                fade: {
                  edge: fadeEdge as "top" | "bottom" | "left" | "right",
                  amount: fadeAmount ?? 35,
                },
              }),
        });
      }
      changedElementId = id;
    } else {
      const rawId = requiredFlag(parsed.flags, "element");
      const resolved = resolveElement(slide, rawId);
      changedElementId = rawId;

      if (command === "element delete") {
        if (resolved.type === "built-in") {
          throw new CliUsageError("Built-in elements cannot be deleted");
        }
        if (resolved.type === "text") {
          slide.textElements = slide.textElements?.filter((element) => element.id !== resolved.id);
          if (slide.textElements?.length === 0) delete slide.textElements;
        } else {
          slide.imageElements = slide.imageElements?.filter((element) => element.id !== resolved.id);
          if (slide.imageElements?.length === 0) delete slide.imageElements;
        }
      } else if (command === "element reorder") {
        const position = requiredFlag(parsed.flags, "position");
        if (!(["front", "back", "up", "down"] as const).includes(position as "front" | "back" | "up" | "down")) {
          throw new CliUsageError("--position must be front, back, up, or down");
        }
        const ranked = presentElementIds(slide)
          .map((elementId) =>
            resolveElement(
              slide,
              elementId.startsWith("text:") || elementId.startsWith("image:")
                ? elementId.slice(elementId.indexOf(":") + 1)
                : elementId,
            ),
          )
          .sort((left, right) => {
            const leftZ = getElementTransform(slide, deck.device, deck.orientation, left.elementId)?.zIndex ?? 0;
            const rightZ = getElementTransform(slide, deck.device, deck.orientation, right.elementId)?.zIndex ?? 0;
            return leftZ - rightZ;
          });
        const currentIndex = ranked.findIndex((element) => element.elementId === resolved.elementId);
        let targetIndex = currentIndex;
        if (position === "front") targetIndex = ranked.length - 1;
        if (position === "back") targetIndex = 0;
        if (position === "up") targetIndex = Math.min(ranked.length - 1, currentIndex + 1);
        if (position === "down") targetIndex = Math.max(0, currentIndex - 1);
        const [moved] = ranked.splice(currentIndex, 1);
        ranked.splice(targetIndex, 0, moved);
        ranked.forEach((element, index) => {
          const current = getElementTransform(slide, deck.device, deck.orientation, element.elementId);
          if (current !== undefined) setTransform(element, { ...current, zIndex: index + 1 });
        });
      } else {
        const patch = transformPatch(parsed.flags);
        if (Object.keys(patch).length > 0) {
          const current = getElementTransform(slide, deck.device, deck.orientation, resolved.elementId);
          if (current === undefined) throw new CliUsageError(`Element ${rawId} has no transform`);
          setTransform(resolved, { ...current, ...patch });
        }
        if (resolved.type === "built-in" && styleFlags.some((flag) => parsed.flags.has(flag))) {
          throw new CliUsageError("Built-in elements only support transform flags");
        }
        if (resolved.type === "text") {
          if (parsed.flags.has("text")) {
            resolved.element.text[deck.locale] = parsed.flags.get("text") ?? "";
          }
          const fontSize = finiteNumberFlag(parsed.flags, "font-size");
          if (fontSize !== undefined) {
            if (fontSize <= 0) throw new CliUsageError("--font-size must be greater than zero");
            resolved.element.fontSize = fontSize;
          }
          const fontWeight = finiteNumberFlag(parsed.flags, "font-weight");
          if (fontWeight !== undefined) {
            if (!Number.isInteger(fontWeight) || fontWeight < 1 || fontWeight > 1000) {
              throw new CliUsageError("--font-weight must be an integer between 1 and 1000");
            }
            resolved.element.fontWeight = fontWeight;
          }
          if (parsed.flags.has("color")) {
            const color = parsed.flags.get("color")?.trim();
            if (color && color !== "none") resolved.element.color = color;
            else delete resolved.element.color;
          }
          if (parsed.flags.has("align")) {
            const align = requiredFlag(parsed.flags, "align");
            if (align !== "left" && align !== "center" && align !== "right") {
              throw new CliUsageError("--align must be left, center, or right");
            }
            resolved.element.align = align;
          }
          for (const unsupported of ["src", "fit", "fade-edge", "fade-amount"]) {
            if (parsed.flags.has(unsupported)) {
              throw new CliUsageError(`Text elements do not support --${unsupported}`);
            }
          }
        }
        if (resolved.type === "image") {
          if (parsed.flags.has("src")) resolved.element.src = parsed.flags.get("src") ?? "";
          if (parsed.flags.has("fit")) {
            const fit = requiredFlag(parsed.flags, "fit");
            if (fit !== "cover" && fit !== "contain") {
              throw new CliUsageError("--fit must be cover or contain");
            }
            resolved.element.fit = fit;
          }
          if (parsed.flags.has("fade-edge")) {
            const edge = requiredFlag(parsed.flags, "fade-edge");
            if (edge === "none") delete resolved.element.fade;
            else if (["top", "bottom", "left", "right"].includes(edge)) {
              resolved.element.fade = {
                edge: edge as "top" | "bottom" | "left" | "right",
                amount: boundedNumberFlag(parsed.flags, "fade-amount", 1, 100) ?? resolved.element.fade?.amount ?? 35,
              };
            } else {
              throw new CliUsageError("--fade-edge must be top, bottom, left, right, or none");
            }
          } else if (parsed.flags.has("fade-amount")) {
            if (resolved.element.fade === undefined) {
              throw new CliUsageError("--fade-edge is required before --fade-amount");
            }
            resolved.element.fade.amount = boundedNumberFlag(parsed.flags, "fade-amount", 1, 100)!;
          }
          for (const unsupported of ["text", "font-size", "font-weight", "color", "align"]) {
            if (parsed.flags.has(unsupported)) {
              throw new CliUsageError(`Image elements do not support --${unsupported}`);
            }
          }
        }
      }
    }

    const result = await service.executeProjectCommand(project.projectId, {
      action: "updateDeck",
      baseRevision: project.revision,
      versionId: version.id,
      deckId: deck.id,
      changes: { slides },
    });
    const updatedApp = resolveApp(result.project);
    const updatedDeck = resolveDeck(
      result.project,
      updatedApp,
      updatedApp.versionsById[version.id],
      deck.id,
    );
    const updatedSlide = updatedDeck.slides.find((item) => item.id === slideId)!;
    return {
      ok: true,
      command,
      project: projectSummary(result.project),
      ...(command === "element delete"
        ? { deletedElementId: changedElementId }
        : { element: elementSummary(updatedSlide, updatedDeck, resolveElement(updatedSlide, changedElementId)) }),
    };
  }

  if (command === "asset list") {
    validateFlags(parsed.flags, ["project", "version"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const assets = Object.values(project.assetsById).filter(
      (asset) => asset.scope.appId === app.id && asset.scope.versionId === version.id,
    );
    return {
      ok: true,
      command,
      project: projectSummary(project),
      assets: assets.map(assetSummary),
    };
  }

  if (command === "asset import") {
    validateFlags(parsed.flags, [
      "project", "version", "deck", "file", "kind", "slide", "field",
      "element-id", "x", "y", "width", "height", "rotation", "z-index",
    ]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const app = resolveApp(project);
    const version = resolveVersion(project, app, optionalVersionId(parsed.flags));
    const deck = resolveDeck(project, app, version, optionalDeckId(parsed.flags));
    const filePath = requiredFlag(parsed.flags, "file");
    const kind = parseAssetKind(parsed.flags.get("kind"));
    const bytes = await readFile(filePath);
    const maximumBytes = kind === "font" ? MAX_FONT_ASSET_BYTES : MAX_IMAGE_ASSET_BYTES;
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
      throw new CliUsageError(`Asset must contain 1 byte to ${maximumBytes / 1024 / 1024} MiB`);
    }

    let extension: string;
    let mime: string;
    if (kind === "font") {
      extension = extname(filePath).slice(1).toLocaleLowerCase("en-US");
      const fontMimes: Record<string, string> = {
        woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
      };
      mime = fontMimes[extension];
      if (mime === undefined) throw new CliUsageError("Fonts must be WOFF2, WOFF, TTF, or OTF");
      if (!hasValidFontSignature(bytes, extension as SupportedFontExtension)) {
        throw new CliUsageError("Font content does not match its file extension");
      }
    } else {
      const detected = sniffImageType(bytes);
      if (detected === null) throw new CliUsageError("Images must be PNG or JPEG");
      mime = detected;
      extension = detected === "image/png" ? "png" : "jpg";
    }

    const field = parsed.flags.get("field") ??
      (kind === "app-icon" ? "app-icon" : kind === "font" ? "font" : kind);
    const slideId = parsed.flags.get("slide");
    if ((kind === "screenshot" || kind === "image") && slideId === undefined) {
      throw new CliUsageError(`--slide is required for ${kind} assets`);
    }
    if (slideId !== undefined && !SLIDE_ID_PATTERN.test(slideId)) {
      throw new CliUsageError(`Invalid slide ID: ${slideId}`);
    }
    const targetSlide = slideId === undefined
      ? undefined
      : deck.slides.find((slide) => slide.id === slideId);
    if (slideId !== undefined && targetSlide === undefined) {
      throw new CliUsageError(`Slide ${slideId} does not exist`);
    }
    const validAttachment =
      (kind === "app-icon" && field === "app-icon") ||
      (kind === "font" && field === "font") ||
      (kind === "screenshot" && (field === "screenshot" || field === "screenshot-secondary")) ||
      (kind === "image" && field === "image");
    if (!validAttachment) {
      throw new CliUsageError(`Asset kind ${kind} cannot attach to field ${field}`);
    }
    if ((kind === "font" || kind === "app-icon") && slideId !== undefined) {
      throw new CliUsageError(`--slide does not apply to ${kind} assets`);
    }
    const transformFlagNames = ["x", "y", "width", "height", "rotation", "z-index"];
    if (
      kind !== "image"
      && (parsed.flags.has("element-id") || transformFlagNames.some((flag) => parsed.flags.has(flag)))
    ) {
      throw new CliUsageError("Element identity and transform flags only apply to image assets");
    }
    const transformChanges = transformPatch(parsed.flags);
    const imageElementId = kind === "image"
      ? parsed.flags.get("element-id")?.trim() || globalThis.crypto.randomUUID()
      : undefined;
    if (
      imageElementId !== undefined
      && (
        !SLIDE_ID_PATTERN.test(imageElementId)
        || BUILT_IN_ELEMENTS.has(imageElementId as BuiltInElementId)
        || targetSlide?.textElements?.some((element) => element.id === imageElementId)
      )
    ) {
      throw new CliUsageError(`Invalid element ID: ${imageElementId}`);
    }
    const imageTransform = kind === "image"
      ? {
          x: 0,
          y: 0,
          width: 300,
          height: 300,
          ...transformChanges,
        }
      : undefined;

    const asset = await storeAsset({
      rootDir: parsed.rootDir,
      projectId: project.projectId,
      appId: app.id,
      versionId: version.id,
      kind,
      extension,
      mime,
      originalName: basename(filePath),
      bytes,
    });
    const candidate = structuredClone(project);
    const candidateDeck = candidate.appsById[app.id].versionsById[version.id].decksById[deck.id];
    candidate.assetsById[asset.id] = asset;

    if (field === "app-icon" && kind === "app-icon") {
      candidateDeck.appIcon = asset.url;
    } else if (field === "font" && kind === "font") {
      const format = (extension === "ttf"
        ? "truetype"
        : extension === "otf"
          ? "opentype"
          : extension) as NonNullable<DeckRecord["importedFont"]>["format"];
      candidateDeck.importedFont = { src: asset.url, format };
      candidateDeck.fontId = "self-hosted";
    } else {
      const slide = candidateDeck.slides.find((item) => item.id === slideId);
      if (slide === undefined) throw new Error(`Validated slide ${String(slideId)} disappeared`);
      if (field === "screenshot" && kind === "screenshot") slide.screenshot = asset.url;
      else if (field === "screenshot-secondary" && kind === "screenshot") slide.screenshotSecondary = asset.url;
      else if (field === "image" && kind === "image") {
        slide.imageElements ??= [];
        const id = imageElementId!;
        const existing = slide.imageElements.find((element) => element.id === id);
        if (existing !== undefined) {
          existing.src = asset.url;
          if (["x", "y", "width", "height", "rotation", "z-index"].some((flag) => parsed.flags.has(flag))) {
            existing.transform = { ...existing.transform, ...transformChanges };
          }
        } else {
          slide.imageElements.push({
            id,
            src: asset.url,
            transform: imageTransform!,
          });
        }
      }
    }

    const saved = await service.saveProject({
      projectId: project.projectId,
      baseRevision: project.revision,
      document: candidate,
    });
    return {
      ok: true,
      command,
      project: projectSummary(saved),
      asset: assetSummary(saved.assetsById[asset.id]),
    };
  }

  if (command === "export plan" || command === "export bundle") {
    validateFlags(parsed.flags, command === "export plan"
      ? ["project", "scope", "versions", "decks", "include-drafts"]
      : ["project", "scope", "versions", "decks", "include-drafts", "url", "output"]);
    const project = await resolveProject(service, optionalProjectId(parsed.flags));
    const scope = exportScope(parsed.flags, project);
    if (command === "export bundle" && scope.deckIds !== undefined) {
      throw new CliUsageError("--decks is available for export plan only; the editor bundle dialog exports complete versions");
    }
    const plan = await buildExportPlan(project, scope, {
      assetFileExists: (url) => managedAssetExists(parsed.rootDir, url),
    });
    if (command === "export plan") {
      return {
        ok: true,
        command,
        project: projectSummary(project),
        scope: plan.manifest.scope,
        manifest: plan.manifest,
        jobs: plan.manifest.jobs,
        preflight: plan.preflight,
      };
    }
    if (plan.preflight.errors.length > 0) {
      throw new Error(
        `Export preflight failed: ${plan.preflight.errors.map((issue) => issue.message).join("; ")}`,
      );
    }
    const snapshot = await service.getWorkspace();
    if (snapshot.workspace.activeProjectId !== project.projectId) {
      throw new CliUsageError(
        `Browser export requires the active project. Run project select --project ${project.projectId} first.`,
      );
    }
    const requestedOutput = requiredFlag(parsed.flags, "output");
    const outputPath = isAbsolute(requestedOutput)
      ? requestedOutput
      : resolve(parsed.rootDir, requestedOutput);
    const result = await dependencies.exportBundle({
      url: parsed.flags.get("url") ?? "http://127.0.0.1:8010",
      outputPath,
      project,
      scope,
      expectedManifest: plan.manifest,
    });
    return {
      ok: true,
      command,
      project: projectSummary(project),
      outputPath: result.outputPath,
      bytes: result.bytes,
      files: result.files,
      pngs: result.pngs,
      manifest: result.manifest,
    };
  }

  throw new CliUsageError(`Unsupported command: ${command}`);
}

export async function runVibeScreensCli(
  argv: readonly string[],
  io: VibeScreensCliIo = defaultIo(),
  dependencies: VibeScreensCliDependencies = {
    exportBundle: async (input) => {
      const { exportProjectBundleWithBrowser } = await import("./browser-export");
      return exportProjectBundleWithBrowser(input);
    },
  },
): Promise<number> {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      emit(io, "stdout", {
        ok: true,
        usage: "npm run cli -- <resource> <action> [--flags]",
        model: "Project -> Version -> Deck -> Slide",
        defaults: {
          exportUrl: "http://127.0.0.1:8010",
        },
        commands: COMMANDS,
      });
      return 0;
    }
    const parsed = parseArguments(argv);
    const service = createWorkspaceProjectService({ rootDir: parsed.rootDir });
    emit(io, "stdout", await execute(parsed, service, dependencies));
    return 0;
  } catch (error) {
    const usageError = error instanceof CliUsageError || error instanceof TypeError;
    emit(io, "stderr", {
      ok: false,
      code: usageError ? "invalid_arguments" : "command_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return usageError ? 2 : 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void runVibeScreensCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
