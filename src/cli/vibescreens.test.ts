import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_PROJECT } from "../lib/defaults";
import { createWorkspaceProjectService } from "../lib/server-service";
import { runVibeScreensCli } from "./vibescreens";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibescreens-cli-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function invoke(rootDir: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runVibeScreensCli(["--root", rootDir, ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return {
    exitCode,
    stdout: stdout.map((line) => JSON.parse(line) as Record<string, unknown>),
    stderr: stderr.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("VibeScreens CLI", () => {
  it("runs through the package tsx entrypoint", async () => {
    const rootDir = await temporaryRoot();
    const { stdout, stderr } = await execFileAsync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [join(process.cwd(), "src", "cli", "vibescreens.ts"), "--root", rootDir, "--help"],
    );

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      commands: expect.arrayContaining(["workspace show", "asset import"]),
    });
  });

  it("prints a machine-readable command index", async () => {
    const rootDir = await temporaryRoot();
    const result = await invoke(rootDir, ["--help"]);

    expect(result).toMatchObject({ exitCode: 0, stderr: [] });
    expect(result.stdout[0]).toMatchObject({
      ok: true,
      commands: expect.arrayContaining(["project create", "slide add", "asset import"]),
      model: "Project -> Version -> Deck -> Slide",
      defaults: { exportUrl: "http://127.0.0.1:8010" },
    });
  });

  it("imports a root legacy project without direct JSON mutation", async () => {
    const rootDir = await temporaryRoot();
    await writeFile(
      join(rootDir, "vibescreens.json"),
      JSON.stringify({
        schemaVersion: 2,
        appName: "Legacy App",
        themeId: "clean-light",
        fontId: "system-sans",
        connectedCanvas: false,
        locales: ["en"],
        locale: "en",
        device: "iphone",
        orientation: "portrait",
        appIcon: "",
        slidesByDevice: { iphone: [{ id: "legacy-slide" }] },
      }),
    );

    const result = await invoke(rootDir, ["workspace", "import"]);

    expect(result).toMatchObject({ exitCode: 0, stderr: [] });
    expect(result.stdout[0]).toMatchObject({
      command: "workspace import",
      importResult: { status: "imported" },
      workspace: { projectOrder: [expect.stringMatching(/^prj_/)] },
    });
  });

  it("imports an external legacy folder into an occupied workspace without changing the source", async () => {
    const rootDir = await temporaryRoot();
    const sourceDirectory = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Keep me"]);
    const service = createWorkspaceProjectService({ rootDir });
    const before = await service.getWorkspace();
    const existing = await service.getProject(before.workspace.activeProjectId!);
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    await mkdir(join(sourceDirectory, "public"));
    await writeFile(join(sourceDirectory, "public", "capture.png"), png);
    const legacy = JSON.stringify({
      schemaVersion: 2, appName: "Imported App", themeId: "ubulk-dark",
      connectedCanvas: true, locales: ["en"], locale: "en",
      device: "iphone", orientation: "portrait", appIcon: "/capture.png",
      slidesByDevice: { iphone: [{
        id: "imported-slide", layout: "hero", headline: { en: "Keep this" },
        screenshot: "/capture.png", imageElements: [{
          id: "overlay", src: "/capture.png", fit: "contain",
          transform: { x: 12, y: 34, width: 120, height: 240, rotation: 4, zIndex: 6 },
        }],
      }] },
    });
    await writeFile(join(sourceDirectory, "app-store-screenshots.json"), legacy);

    const result = await invoke(rootDir, ["project", "import", "--source", sourceDirectory]);
    expect(result).toMatchObject({ exitCode: 0, stderr: [] });
    expect(result.stdout[0]).toMatchObject({ importResult: { status: "imported", warnings: [] } });
    const after = await service.getWorkspace();
    expect(after.workspace.projectOrder).toHaveLength(2);
    expect(await service.getProject(existing.projectId)).toEqual(existing);
    const imported = await service.getProject(after.workspace.activeProjectId!);
    const app = imported.appsById[imported.selection.appId];
    const deck = app.versionsById[imported.selection.versionId].decksById[imported.selection.deckId];
    expect(deck).toMatchObject({ themeId: "ubulk-dark", connectedCanvas: true });
    expect(deck.slides[0].imageElements?.[0]).toMatchObject({
      id: "overlay", transform: { x: 12, y: 34, width: 120, height: 240, rotation: 4, zIndex: 6 },
    });
    expect(Object.values(imported.assetsById)).toHaveLength(3);
    for (const asset of Object.values(imported.assetsById)) {
      expect(await readFile(join(rootDir, "public", asset.url.slice(1)))).toEqual(png);
    }
    expect(await readFile(join(rootDir, imported.migration!.backupPath), "utf8")).toBe(legacy);
    expect(await readFile(join(sourceDirectory, "app-store-screenshots.json"), "utf8")).toBe(legacy);
    expect((await readdir(sourceDirectory)).sort()).toEqual(["app-store-screenshots.json", "public"]);
    expect(await readdir(join(sourceDirectory, "public"))).toEqual(["capture.png"]);

    const repeated = await invoke(rootDir, ["project", "import", "--source", sourceDirectory]);
    expect(repeated.exitCode).toBe(1);
    expect(await service.getWorkspace()).toEqual(after);
  });

  it("rejects incomplete external imports without registering a project", async () => {
    const rootDir = await temporaryRoot();
    const sourceDirectory = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Keep me"]);
    const before = await invoke(rootDir, ["workspace", "show"]);
    await writeFile(join(sourceDirectory, "vibescreens.json"), JSON.stringify({
      schemaVersion: 2, appName: "Missing assets", locale: "en", locales: ["en"],
      device: "iphone", slidesByDevice: { iphone: [{ id: "missing", screenshot: "/missing.png" }] },
    }));
    const result = await invoke(rootDir, ["project", "import", "--source", sourceDirectory]);
    expect(result.exitCode).toBe(1);
    expect(await invoke(rootDir, ["workspace", "show"])).toEqual(before);
  });

  it("fails external imports with no source or a non-legacy schema", async () => {
    const rootDir = await temporaryRoot();
    const sourceDirectory = await temporaryRoot();
    expect((await invoke(rootDir, ["project", "import"])).exitCode).toBe(2);
    expect((await invoke(rootDir, ["project", "import", "--source", sourceDirectory])).exitCode).toBe(1);
    for (const schemaVersion of [3, 4]) {
      await writeFile(join(sourceDirectory, "vibescreens.json"), JSON.stringify({ schemaVersion }));
      expect((await invoke(rootDir, ["project", "import", "--source", sourceDirectory])).exitCode).toBe(1);
    }
    const result = await invoke(rootDir, ["project", "list"]);
    expect(result.stdout[0].projects).toEqual([]);
  });

  it("creates and inspects projects without exposing revision or document payloads", async () => {
    const rootDir = await temporaryRoot();

    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    expect(created).toMatchObject({ exitCode: 0, stderr: [] });
    expect(created.stdout[0]).toMatchObject({
      ok: true,
      command: "project create",
      project: { name: "Agent Project" },
    });

    const listed = await invoke(rootDir, ["project", "list"]);
    expect(listed).toMatchObject({ exitCode: 0, stderr: [] });
    expect(listed.stdout[0]).toMatchObject({
      ok: true,
      projects: [expect.objectContaining({ name: "Agent Project" })],
    });
  });

  it("exposes only the Project -> Version hierarchy", async () => {
    const rootDir = await temporaryRoot();
    const help = await invoke(rootDir, ["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout[0].commands).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^app /)]),
    );

    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const workspace = await invoke(rootDir, ["workspace", "show"]);
    const workspaceProjects = (workspace.stdout[0] as { projects: unknown[] }).projects;
    expect(workspaceProjects[0]).not.toHaveProperty("appCount");
    const versions = await invoke(rootDir, ["version", "list"]);
    expect(versions).toMatchObject({ exitCode: 0, stderr: [] });
    expect(versions.stdout[0]).not.toHaveProperty("app");
    expect((versions.stdout[0] as { project: { selection: object } }).project.selection)
      .not.toHaveProperty("appId");

    const legacyAppCommand = await invoke(rootDir, ["app", "list"]);
    expect(legacyAppCommand.exitCode).toBe(2);
    expect(legacyAppCommand.stderr[0]).toMatchObject({ code: "invalid_arguments" });
  });

  it("duplicates, reorders, and styles slides through domain commands", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const initialSlideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);

    expect((await invoke(rootDir, [
      "slide", "duplicate", "--slide", initialSlideId, "--id", "agent-slide-copy",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "slide", "update", "--slide", "agent-slide-copy",
      "--label-scale", "1.2", "--headline-scale", "0.8", "--app-name-scale", "1.4",
      "--background", "#112233",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "slide", "reorder", "--slide", "agent-slide-copy", "--index", "0",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "slide", "update", "--slide", "agent-slide-copy", "--background", "none",
    ])).exitCode).toBe(0);

    const service = createWorkspaceProjectService({ rootDir });
    const workspace = await service.getWorkspace();
    const project = await service.getProject(workspace.workspace.activeProjectId!);
    const app = project.appsById[project.selection.appId];
    const deck = app.versionsById[project.selection.versionId].decksById[project.selection.deckId];
    expect(deck.slides[0]).toMatchObject({
      id: "agent-slide-copy",
      typography: { labelScale: 1.2, headlineScale: 0.8, appNameScale: 1.4 },
    });
    expect(deck.slides[0]).not.toHaveProperty("backgroundColor");
  });

  it("duplicates nested elements with fresh IDs like the editor", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);

    await invoke(rootDir, [
      "element", "add", "--slide", slideId, "--type", "text", "--id", "source-text",
    ]);
    await invoke(rootDir, [
      "element", "add", "--slide", slideId, "--type", "image", "--id", "source-image",
    ]);
    const duplicated = await invoke(rootDir, [
      "slide", "duplicate", "--slide", slideId, "--id", "duplicated-slide",
    ]);

    expect(duplicated.exitCode).toBe(0);
    const service = createWorkspaceProjectService({ rootDir });
    const workspace = await service.getWorkspace();
    const project = await service.getProject(workspace.workspace.activeProjectId!);
    const app = project.appsById[project.selection.appId];
    const deck = app.versionsById[project.selection.versionId].decksById[project.selection.deckId];
    const source = deck.slides.find((slide) => slide.id === slideId)!;
    const copy = deck.slides.find((slide) => slide.id === "duplicated-slide")!;
    expect(copy.textElements?.[0].id).not.toBe(source.textElements?.[0].id);
    expect(copy.imageElements?.[0].id).not.toBe(source.imageElements?.[0].id);
  });

  it("applies the editor layout transition side effects", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);

    await invoke(rootDir, [
      "slide", "update", "--slide", slideId, "--screenshot", "/primary.png",
    ]);
    await invoke(rootDir, [
      "element", "update", "--slide", slideId, "--element", "caption", "--x", "42",
    ]);
    expect((await invoke(rootDir, [
      "slide", "update", "--slide", slideId, "--layout", "two-devices",
    ])).exitCode).toBe(0);

    const service = createWorkspaceProjectService({ rootDir });
    const workspace = await service.getWorkspace();
    let project = await service.getProject(workspace.workspace.activeProjectId!);
    let app = project.appsById[project.selection.appId];
    let deck = app.versionsById[project.selection.versionId].decksById[project.selection.deckId];
    let slide = deck.slides.find((entry) => entry.id === slideId)!;
    expect(slide.screenshotSecondary).toBe("/primary.png");
    expect(slide.transforms).toBeUndefined();

    expect((await invoke(rootDir, [
      "slide", "update", "--slide", slideId, "--layout", "no-device",
    ])).exitCode).toBe(0);
    project = await service.getProject(workspace.workspace.activeProjectId!);
    app = project.appsById[project.selection.appId];
    deck = app.versionsById[project.selection.versionId].decksById[project.selection.deckId];
    slide = deck.slides.find((entry) => entry.id === slideId)!;
    expect(slide.screenshotSecondary).toBeUndefined();
  });

  it("manages built-in, text, and image elements without raw document edits", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const initialSlideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);

    expect((await invoke(rootDir, [
      "element", "add", "--slide", initialSlideId, "--type", "text",
      "--id", "title", "--text", "Hello", "--x", "10", "--y", "20", "--width", "300", "--height", "90",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "element", "update", "--slide", initialSlideId, "--element", "title",
      "--text", "Updated", "--font-size", "54", "--font-weight", "800", "--color", "#ffffff", "--align", "right",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "element", "add", "--slide", initialSlideId, "--type", "image",
      "--id", "art", "--x", "50", "--y", "60", "--width", "200", "--height", "220",
      "--fit", "contain", "--fade-edge", "bottom", "--fade-amount", "40",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "element", "reorder", "--slide", initialSlideId, "--element", "art", "--position", "front",
    ])).exitCode).toBe(0);
    expect((await invoke(rootDir, [
      "element", "update", "--slide", initialSlideId, "--element", "caption",
      "--x", "40", "--rotation", "12", "--z-index", "20",
    ])).exitCode).toBe(0);

    const listed = await invoke(rootDir, ["element", "list", "--slide", initialSlideId]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout[0].elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "caption", transform: expect.objectContaining({ x: 40, rotation: 12, zIndex: 20 }) }),
      expect.objectContaining({ id: "title", type: "text", text: "Updated", fontSize: 54, fontWeight: 800, align: "right" }),
      expect.objectContaining({ id: "art", type: "image", fit: "contain", fade: { edge: "bottom", amount: 40 } }),
    ]));

    expect((await invoke(rootDir, [
      "element", "delete", "--slide", initialSlideId, "--element", "art",
    ])).exitCode).toBe(0);
    const afterDelete = await invoke(rootDir, ["element", "list", "--slide", initialSlideId]);
    expect(afterDelete.stdout[0].elements).not.toContainEqual(expect.objectContaining({ id: "art" }));
  });

  it("attaches an imported image to an existing image element", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);
    expect((await invoke(rootDir, [
      "element", "add", "--slide", slideId, "--type", "image", "--id", "art",
    ])).exitCode).toBe(0);
    const sourcePath = join(rootDir, "overlay.png");
    await writeFile(
      sourcePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const imported = await invoke(rootDir, [
      "asset", "import", "--file", sourcePath, "--kind", "image", "--slide", slideId,
      "--field", "image", "--element-id", "art",
    ]);
    expect(imported.exitCode).toBe(0);
    const listed = await invoke(rootDir, ["element", "list", "--slide", slideId]);
    const images = (listed.stdout[0].elements as Array<{ id: string; src?: string }>).filter(
      (element) => element.id === "art",
    );
    expect(images).toEqual([
      expect.objectContaining({ id: "art", src: expect.stringMatching(/^\/vibescreens-assets\//) }),
    ]);
  });

  it("rejects deck-filtered bundle exports because the editor dialog has no deck filter", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Export Project"]);
    const calls: unknown[] = [];
    const stdout: unknown[] = [];
    const stderr: unknown[] = [];

    const exitCode = await runVibeScreensCli([
      "--root", rootDir,
      "export", "bundle",
      "--scope", "current",
      "--decks", "deck_fake",
      "--output", "exports/current.zip",
    ], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    }, {
      exportBundle: async (input: unknown) => {
        calls.push(input);
        return { outputPath: "/tmp/no.zip", bytes: 1, files: 2, pngs: 1, manifest: {} as never };
      },
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(JSON.parse(String(stderr[0]))).toMatchObject({ code: "invalid_arguments" });
    expect(calls).toEqual([]);
  });

  it("resets the active deck content to editor defaults", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);
    const before = await invoke(rootDir, ["slide", "list"]);
    const originalHeadline = (before.stdout[0].slides as Array<{ id: string; headline: string }>).find(
      (slide) => slide.id === slideId,
    )!.headline;
    await invoke(rootDir, ["slide", "update", "--slide", slideId, "--headline", "Changed"]);

    const reset = await invoke(rootDir, ["deck", "reset"]);
    expect(reset.exitCode).toBe(0);
    const after = await invoke(rootDir, ["slide", "list"]);
    expect(after.stdout[0].slides).toEqual(
      expect.arrayContaining([expect.objectContaining({ headline: originalHeadline })]),
    );
    expect(after.stdout[0].slides).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ headline: "Changed" })]),
    );
  });

  it("uses target-device defaults instead of copying slides across device families", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const iphone = await invoke(rootDir, ["slide", "list"]);
    const iphoneIds = (iphone.stdout[0] as { slides: Array<{ id: string }> }).slides.map(({ id }) => id);

    expect((await invoke(rootDir, [
      "deck", "create", "--device", "android", "--orientation", "portrait", "--locale", "de",
    ])).exitCode).toBe(0);
    const android = await invoke(rootDir, ["slide", "list"]);
    const androidIds = (android.stdout[0] as { slides: Array<{ id: string }> }).slides.map(({ id }) => id);

    expect(androidIds).not.toEqual(iphoneIds);
    expect(androidIds).toHaveLength(DEFAULT_PROJECT.slidesByDevice.android.length);
  });

  it("imports a managed asset and changes slides through validated commands", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const sourcePath = join(rootDir, "capture.png");
    await writeFile(
      sourcePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const added = await invoke(rootDir, [
      "slide",
      "add",
      "--id",
      "agent-slide",
      "--headline",
      "Einfach starten",
      "--label",
      "SCHNELL",
      "--layout",
      "hero",
    ]);
    expect(added).toMatchObject({ exitCode: 0, stderr: [] });
    expect(added.stdout[0]).toMatchObject({
      command: "slide add",
      slide: {
        id: "agent-slide",
        headline: "Einfach starten",
      },
    });

    const imported = await invoke(rootDir, [
      "asset",
      "import",
      "--file",
      sourcePath,
      "--kind",
      "screenshot",
      "--slide",
      "agent-slide",
      "--field",
      "screenshot",
    ]);
    expect(imported).toMatchObject({ exitCode: 0, stderr: [] });
    const asset = imported.stdout[0].asset as { url: string };
    expect(asset.url).toMatch(/^\/vibescreens-assets\/.*\.png$/);

    const updated = await invoke(rootDir, [
      "slide",
      "update",
      "--slide",
      "agent-slide",
      "--headline",
      "Noch einfacher",
      "--inverted",
      "true",
    ]);
    expect(updated.stdout[0]).toMatchObject({
      slide: { id: "agent-slide", headline: "Noch einfacher", inverted: true },
    });

    const listed = await invoke(rootDir, ["slide", "list"]);
    expect(listed.stdout[0]).toMatchObject({
      slides: expect.arrayContaining([
        expect.objectContaining({
          id: "agent-slide",
          headline: "Noch einfacher",
          screenshot: asset.url,
        }),
      ]),
    });
  });

  it("keeps a winning content-addressed asset when a concurrent identical import loses CAS", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    await invoke(rootDir, ["slide", "add", "--id", "first-slide", "--headline", "First"]);
    await invoke(rootDir, ["slide", "add", "--id", "second-slide", "--headline", "Second"]);
    const sourcePath = join(rootDir, "capture.png");
    await writeFile(
      sourcePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const imports = await Promise.all([
      invoke(rootDir, [
        "asset", "import", "--file", sourcePath, "--kind", "screenshot",
        "--slide", "first-slide", "--field", "screenshot",
      ]),
      invoke(rootDir, [
        "asset", "import", "--file", sourcePath, "--kind", "screenshot",
        "--slide", "second-slide", "--field", "screenshot",
      ]),
    ]);

    expect(imports.map(({ exitCode }) => exitCode).sort()).toEqual([0, 1]);
    const winner = imports.find(({ exitCode }) => exitCode === 0);
    expect(winner).toBeDefined();
    const asset = winner?.stdout[0].asset as { url: string };
    await expect(access(join(rootDir, "public", asset.url.slice(1)))).resolves.toBeUndefined();

    const listed = await invoke(rootDir, ["slide", "list"]);
    expect(listed.stdout[0]).toMatchObject({
      slides: expect.arrayContaining([
        expect.objectContaining({ screenshot: asset.url }),
      ]),
    });
  });

  it("validates an asset attachment before writing bytes", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const sourcePath = join(rootDir, "capture.png");
    await writeFile(
      sourcePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const result = await invoke(rootDir, [
      "asset", "import", "--file", sourcePath, "--kind", "screenshot",
      "--slide", "missing-slide", "--field", "screenshot",
    ]);

    expect(result.exitCode).toBe(2);
    await expect(access(join(rootDir, "public", "vibescreens-assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects invalid imported image geometry before writing bytes", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);
    const sourcePath = join(rootDir, "overlay.png");
    await writeFile(
      sourcePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const result = await invoke(rootDir, [
      "asset", "import", "--file", sourcePath, "--kind", "image",
      "--slide", slideId, "--width", "-10", "--height", "0",
    ]);

    expect(result.exitCode).toBe(2);
    await expect(access(join(rootDir, "public", "vibescreens-assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates imported image element identity before writing bytes", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);
    const sourcePath = join(rootDir, "overlay.png");
    await writeFile(
      sourcePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const result = await invoke(rootDir, [
      "asset", "import", "--file", sourcePath, "--kind", "image",
      "--slide", slideId, "--element-id", "caption",
    ]);

    expect(result.exitCode).toBe(2);
    await expect(access(join(rootDir, "public", "vibescreens-assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects transforms the editor cannot create", async () => {
    const rootDir = await temporaryRoot();
    const created = await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const slideId = ((created.stdout[0].project as { selection: { slideId: string } }).selection.slideId);

    expect((await invoke(rootDir, [
      "element", "update", "--slide", slideId, "--element", "caption", "--rotation", "181",
    ])).exitCode).toBe(2);
    expect((await invoke(rootDir, [
      "element", "update", "--slide", slideId, "--element", "caption", "--z-index", "1.5",
    ])).exitCode).toBe(2);
  });

  it("matches the editor font content validation and 16 MiB limit", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const invalidPath = join(rootDir, "invalid.woff2");
    await writeFile(invalidPath, "not a font");

    const invalid = await invoke(rootDir, [
      "asset", "import", "--file", invalidPath, "--kind", "font",
    ]);
    expect(invalid.exitCode).toBe(2);
    await expect(access(join(rootDir, "public", "vibescreens-assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const validPath = join(rootDir, "large.woff2");
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
    Buffer.from("wOF2").copy(bytes);
    await writeFile(validPath, bytes);
    const valid = await invoke(rootDir, [
      "asset", "import", "--file", validPath, "--kind", "font",
    ]);
    expect(valid.exitCode).toBe(0);
  });

  it("plans the exact browser export scope without exposing an App command", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);

    const planned = await invoke(rootDir, ["export", "plan", "--scope", "current"]);

    expect(planned.exitCode).toBe(0);
    expect(planned.stdout[0]).toMatchObject({
      command: "export plan",
      scope: { kind: "current" },
      manifest: {
        project: { name: "Agent Project" },
        scope: { kind: "current" },
      },
    });
    expect(JSON.stringify(planned.stdout[0])).not.toContain('"appId"');
    const help = await invoke(rootDir, ["--help"]);
    expect(help.stdout[0].commands).toEqual(expect.arrayContaining(["export plan", "export bundle"]));
    expect(help.stdout[0].commands).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^app /),
    ]));
  });

  it("delegates bundle rendering to the browser exporter with a frozen scope", async () => {
    const rootDir = await temporaryRoot();
    await invoke(rootDir, ["project", "create", "--name", "Agent Project"]);
    const stdout: Record<string, unknown>[] = [];
    const stderr: Record<string, unknown>[] = [];
    const calls: unknown[] = [];

    const exitCode = await runVibeScreensCli([
      "export", "bundle", "--root", rootDir, "--scope", "all",
      "--include-drafts", "true", "--url", "http://127.0.0.1:8010",
      "--output", join(rootDir, "exports", "agent.zip"),
    ], {
      stdout: (line) => stdout.push(JSON.parse(line) as Record<string, unknown>),
      stderr: (line) => stderr.push(JSON.parse(line) as Record<string, unknown>),
    }, {
      exportBundle: async (input: unknown) => {
        calls.push(input);
        return {
          outputPath: join(rootDir, "exports", "agent.zip"),
          bytes: 128,
          files: 3,
          pngs: 1,
          manifest: {} as never,
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({
        url: "http://127.0.0.1:8010",
        outputPath: join(rootDir, "exports", "agent.zip"),
        scope: { kind: "all", includeDrafts: true },
      }),
    ]);
    expect(stdout[0]).toMatchObject({
      command: "export bundle",
      outputPath: join(rootDir, "exports", "agent.zip"),
      bytes: 128,
      files: 3,
    });
  });

  it("rejects unknown flags before mutating data", async () => {
    const rootDir = await temporaryRoot();

    const result = await invoke(rootDir, [
      "project",
      "create",
      "--name",
      "Agent Project",
      "--raw-json",
      "{}",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    });
    const listed = await invoke(rootDir, ["project", "list"]);
    expect(listed.stdout[0]).toMatchObject({ projects: [] });
  });
});
