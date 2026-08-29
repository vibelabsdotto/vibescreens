import { NextResponse } from "next/server";

import {
  createAssetUploadService,
  type AssetUploadService,
} from "../../../lib/asset-upload-service";
import { rejectCrossSiteMultipartWrite } from "../../../lib/request-guard";
import { apiErrorResponse, HttpRequestError } from "../../../lib/server-http";

export const dynamic = "force-dynamic";

const MAX_FONT_BYTES = 16 * 1024 * 1024;
const FONT_TYPES = {
  woff2: { format: "woff2", mime: "font/woff2", signature: "wOF2" },
  woff: { format: "woff", mime: "font/woff", signature: "wOFF" },
  ttf: { format: "truetype", mime: "font/ttf", signature: "ttf" },
  otf: { format: "opentype", mime: "font/otf", signature: "OTTO" },
} as const;

type FontExtension = keyof typeof FONT_TYPES;

function plainFilename(value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new HttpRequestError(400, "Font name must be a plain filename", "invalid_filename");
  }
  return value;
}

function optionalFormString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpRequestError(400, `${key} must be a string`, "invalid_body");
  }
  return value;
}

function fontExtension(filename: string): FontExtension {
  const extension = filename.split(".").pop()?.toLocaleLowerCase("en-US");
  if (extension === undefined || !(extension in FONT_TYPES)) {
    throw new HttpRequestError(
      400,
      "Use a WOFF2, WOFF, TTF, or OTF font file.",
      "unsupported_font",
    );
  }
  return extension as FontExtension;
}

function fontContentMatches(bytes: Buffer, extension: FontExtension): boolean {
  if (bytes.byteLength < 4) return false;
  if (extension === "ttf") {
    return (
      (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) ||
      bytes.subarray(0, 4).toString("ascii") === "true"
    );
  }
  return bytes.subarray(0, 4).toString("ascii") === FONT_TYPES[extension].signature;
}

export function createUploadFontRouteHandlers(service: AssetUploadService) {
  return {
    async POST(request: Request) {
      const blocked = rejectCrossSiteMultipartWrite(request);
      if (blocked !== null) {
        return NextResponse.json(
          { ok: false, code: "write_rejected", error: blocked.error },
          { status: blocked.status },
        );
      }

      try {
        const form = await request.formData().catch(() => null);
        if (form === null) {
          throw new HttpRequestError(400, "Invalid multipart form data", "invalid_multipart");
        }
        const file = form.get("font");
        if (!(file instanceof File)) {
          throw new HttpRequestError(400, "Choose a font file first.", "missing_font");
        }
        const originalName = plainFilename(file.name);
        const extension = fontExtension(originalName);
        if (file.size > MAX_FONT_BYTES) {
          throw new HttpRequestError(
            413,
            "Font file is too large (16MB maximum).",
            "asset_too_large",
          );
        }

        const bytes = Buffer.from(await file.arrayBuffer());
        if (!fontContentMatches(bytes, extension)) {
          throw new HttpRequestError(
            400,
            "Font content does not match its file extension.",
            "invalid_font_content",
          );
        }
        const fontType = FONT_TYPES[extension];
        const result = await service.uploadAsset({
          projectId: optionalFormString(form, "projectId"),
          appId: optionalFormString(form, "appId"),
          versionId: optionalFormString(form, "versionId"),
          kind: "font",
          extension,
          originalName,
          mime: fontType.mime,
          bytes,
        });
        return NextResponse.json({
          ok: true,
          font: { src: result.asset.url, format: fontType.format },
          asset: result.asset,
          project: result.project,
          revision: result.project.revision,
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const handlers = createUploadFontRouteHandlers(
  createAssetUploadService({ rootDir: process.cwd() }),
);

export const POST = handlers.POST;
