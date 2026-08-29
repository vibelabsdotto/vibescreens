import { NextResponse } from "next/server";

import {
  createAssetUploadService,
  type AssetUploadService,
} from "../../../lib/asset-upload-service";
import { rejectCrossSiteWrite, sniffImageType } from "../../../lib/request-guard";
import {
  apiErrorResponse,
  HttpRequestError,
  readJsonBody,
  requireJsonObject,
} from "../../../lib/server-http";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_JSON_BYTES = 12 * 1024 * 1024;
const IMAGE_KINDS = new Set(["screenshot", "image", "app-icon"] as const);
const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
} as const;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type ImageAssetKind = "screenshot" | "image" | "app-icon";

function parseDataUrl(dataUrl: string): { mime: keyof typeof MIME_EXT; bytes: Buffer } {
  const match = /^data:(image\/(?:png|jpeg));base64,([^\r\n]*)$/i.exec(dataUrl);
  if (match === null) {
    throw new HttpRequestError(400, "Unsupported data URL", "invalid_data_url");
  }
  const mime = match[1].toLocaleLowerCase("en-US") as keyof typeof MIME_EXT;
  const encoded = match[2];
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !STRICT_BASE64.test(encoded)
  ) {
    throw new HttpRequestError(400, "Invalid base64 image data", "invalid_base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new HttpRequestError(400, "Invalid base64 image data", "invalid_base64");
  }
  return { mime, bytes };
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpRequestError(400, `${key} must be a string`, "invalid_body");
  }
  return value;
}

function imageKind(value: unknown): ImageAssetKind {
  if (value === undefined) return "screenshot";
  if (typeof value !== "string" || !IMAGE_KINDS.has(value as ImageAssetKind)) {
    throw new HttpRequestError(400, "Invalid image asset kind", "invalid_asset_kind");
  }
  return value as ImageAssetKind;
}

function plainFilename(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new HttpRequestError(400, "fileName must be a plain filename", "invalid_filename");
  }
  return value;
}

export function createUploadRouteHandlers(service: AssetUploadService) {
  return {
    async POST(request: Request) {
      const blocked = rejectCrossSiteWrite(request);
      if (blocked !== null) {
        return NextResponse.json(
          { ok: false, code: "write_rejected", error: blocked.error },
          { status: blocked.status },
        );
      }

      try {
        const body = requireJsonObject(
          await readJsonBody(request, MAX_IMAGE_JSON_BYTES),
        );
        if (typeof body.dataUrl !== "string" || body.dataUrl.length === 0) {
          throw new HttpRequestError(400, "Missing dataUrl", "invalid_body");
        }
        const parsed = parseDataUrl(body.dataUrl);
        if (parsed.bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new HttpRequestError(413, "Image too large (>8MB)", "asset_too_large");
        }
        const sniffed = sniffImageType(parsed.bytes);
        if (sniffed !== parsed.mime) {
          throw new HttpRequestError(
            400,
            "Content does not match declared image type",
            "invalid_image_content",
          );
        }

        const result = await service.uploadAsset({
          projectId: optionalString(body, "projectId"),
          appId: optionalString(body, "appId"),
          versionId: optionalString(body, "versionId"),
          kind: imageKind(body.kind),
          extension: MIME_EXT[parsed.mime],
          originalName: plainFilename(optionalString(body, "fileName")),
          mime: parsed.mime,
          bytes: parsed.bytes,
        });
        return NextResponse.json({
          ok: true,
          path: result.asset.url,
          asset: result.asset,
          revision: result.project.revision,
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const handlers = createUploadRouteHandlers(
  createAssetUploadService({ rootDir: process.cwd() }),
);

export const POST = handlers.POST;
