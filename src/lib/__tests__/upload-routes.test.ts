import { describe, expect, it, vi } from "vitest";

import type { AppId, AssetId, VersionId } from "../ids";
import { ProjectRevisionConflictError } from "../project-repository";
import type { AssetRef, ProjectDocumentV3 } from "../project-schema";
import type { AssetUploadService } from "../asset-upload-service";
import type { ProjectId } from "../workspace";
import { createUploadRouteHandlers } from "../../app/api/upload/route";
import { createUploadFontRouteHandlers } from "../../app/api/upload-font/route";

const PROJECT_ID = "prj_route_upload" as ProjectId;
const APP_ID = "app_route_upload" as AppId;
const VERSION_ID = "ver_route_upload" as VersionId;
const PNG_BYTES = Buffer.from("89504e470d0a1a0a00000000", "hex");
const WOFF2_BYTES = Buffer.from("774f463200000000", "hex");

function asset(kind: AssetRef["kind"], extension: string, mime: string): AssetRef {
  const sha256 = "b".repeat(64);
  const directory = {
    screenshot: "screenshots",
    image: "images",
    font: "fonts",
    "app-icon": "app-icons",
  }[kind];
  return {
    id: `asset_${kind.replace("-", "_")}` as AssetId,
    scope: { appId: APP_ID, versionId: VERSION_ID },
    kind,
    originalName: `upload.${extension}`,
    mime,
    bytes: kind === "font" ? WOFF2_BYTES.byteLength : PNG_BYTES.byteLength,
    sha256,
    extension,
    url: `/vibescreens-assets/${PROJECT_ID}/${APP_ID}/${VERSION_ID}/${directory}/${sha256}.${extension}`,
  };
}

function uploadService(resultAsset: AssetRef) {
  const project = { revision: 8 } as ProjectDocumentV3;
  const uploadAsset = vi.fn(async () => ({ asset: resultAsset, project }));
  return {
    service: { uploadAsset } as AssetUploadService,
    uploadAsset,
    project,
  };
}

function imageRequest(
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request("http://localhost:3000/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function fontRequest(file: File, headers: HeadersInit = {}, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("font", file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request("http://localhost:3000/api/upload-font", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("image upload route", () => {
  it("validates and forwards kind, original name, bytes, and explicit scope", async () => {
    const stored = asset("image", "png", "image/png");
    const { service, uploadAsset } = uploadService(stored);
    const { POST } = createUploadRouteHandlers(service);

    const response = await POST(
      imageRequest({
        dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
        fileName: "overlay.png",
        kind: "image",
        projectId: PROJECT_ID,
        versionId: VERSION_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(uploadAsset).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      versionId: VERSION_ID,
      kind: "image",
      extension: "png",
      originalName: "overlay.png",
      mime: "image/png",
      bytes: PNG_BYTES,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      path: stored.url,
      project: { revision: 8 },
      revision: 8,
    });
  });

  it("defaults image uploads to screenshot assets", async () => {
    const stored = asset("screenshot", "png", "image/png");
    const { service, uploadAsset } = uploadService(stored);
    const { POST } = createUploadRouteHandlers(service);

    await POST(
      imageRequest({
        dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
        projectId: PROJECT_ID,
        versionId: VERSION_ID,
      }),
    );

    expect(uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "screenshot", originalName: undefined }),
    );
  });

  it.each([
    ["invalid kind", { dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`, kind: "font" }],
    ["traversal filename", { dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`, fileName: "../escape.png" }],
    ["non-canonical base64", { dataUrl: "data:image/png;base64,abc===" }],
    ["mismatched declared MIME", { dataUrl: `data:image/jpeg;base64,${PNG_BYTES.toString("base64")}` }],
    ["unsupported content", { dataUrl: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}` }],
  ])("rejects %s before storing", async (_label, body) => {
    const { service, uploadAsset } = uploadService(asset("screenshot", "png", "image/png"));
    const { POST } = createUploadRouteHandlers(service);

    const response = await POST(imageRequest(body));

    expect(response.status).toBe(400);
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("requires guarded application/json writes", async () => {
    const { service, uploadAsset } = uploadService(asset("screenshot", "png", "image/png"));
    const { POST } = createUploadRouteHandlers(service);
    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

    const wrongType = await POST(
      new Request("http://localhost:3000/api/upload", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ dataUrl }),
      }),
    );
    const crossSite = await POST(
      imageRequest({ dataUrl }, { origin: "https://attacker.example" }),
    );

    expect(wrongType.status).toBe(415);
    expect(crossSite.status).toBe(403);
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("maps stale registration to a response with no usable path", async () => {
    const conflict = new ProjectRevisionConflictError({
      projectId: PROJECT_ID,
      revision: 9,
      updatedAt: "2026-08-28T13:00:00.000Z",
    });
    const uploadAsset = vi.fn(async () => {
      throw conflict;
    });
    const { POST } = createUploadRouteHandlers({ uploadAsset } as AssetUploadService);

    const response = await POST(
      imageRequest({
        dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
        projectId: PROJECT_ID,
        versionId: VERSION_ID,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "project_revision_conflict" });
    expect(body).not.toHaveProperty("path");
    expect(body).not.toHaveProperty("asset");
  });
});

describe("font upload route", () => {
  it("guards multipart, validates font content, and preserves the existing font response", async () => {
    const stored = asset("font", "woff2", "font/woff2");
    const { service, uploadAsset } = uploadService(stored);
    const { POST } = createUploadFontRouteHandlers(service);
    const file = new File([WOFF2_BYTES], "Brand.woff2", { type: "font/woff2" });

    const response = await POST(
      fontRequest(file, {}, {
        projectId: PROJECT_ID,
        versionId: VERSION_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(uploadAsset).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      versionId: VERSION_ID,
      kind: "font",
      extension: "woff2",
      originalName: "Brand.woff2",
      mime: "font/woff2",
      bytes: WOFF2_BYTES,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      font: { src: stored.url, format: "woff2" },
      project: { revision: 8 },
      revision: 8,
    });
  });

  it("rejects cross-site multipart before parsing or storing", async () => {
    const { service, uploadAsset } = uploadService(asset("font", "woff2", "font/woff2"));
    const { POST } = createUploadFontRouteHandlers(service);

    const response = await POST(
      fontRequest(
        new File([WOFF2_BYTES], "Brand.woff2"),
        { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      ),
    );

    expect(response.status).toBe(403);
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported extension", new File([WOFF2_BYTES], "Brand.txt")],
    ["traversal filename", new File([WOFF2_BYTES], "../Brand.woff2")],
    ["invalid font content", new File([Buffer.from("not a font")], "Brand.ttf")],
  ])("rejects %s without changing the asset registry", async (_label, file) => {
    const { service, uploadAsset } = uploadService(asset("font", "woff2", "font/woff2"));
    const { POST } = createUploadFontRouteHandlers(service);

    const response = await POST(fontRequest(file));

    expect(response.status).toBe(400);
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("enforces the 16 MiB font limit before registration", async () => {
    const { service, uploadAsset } = uploadService(asset("font", "woff2", "font/woff2"));
    const { POST } = createUploadFontRouteHandlers(service);
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
    WOFF2_BYTES.copy(oversized);

    const response = await POST(fontRequest(new File([oversized], "large.woff2")));

    expect(response.status).toBe(413);
    expect(uploadAsset).not.toHaveBeenCalled();
  });
});
