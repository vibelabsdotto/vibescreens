export const MAX_IMAGE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_FONT_ASSET_BYTES = 16 * 1024 * 1024;

export type SupportedFontExtension = "woff2" | "woff" | "ttf" | "otf";

export function hasValidFontSignature(
  bytes: Uint8Array,
  extension: SupportedFontExtension,
): boolean {
  if (bytes.length < 4) return false;
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (extension === "woff2") return signature === "wOF2";
  if (extension === "woff") return signature === "wOFF";
  if (extension === "otf") return signature === "OTTO";
  return (
    (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00)
    || signature === "true"
  );
}
