import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("editor upload targeting", () => {
  it("binds image uploads to the project and version that initiated them", async () => {
    const source = await readFile(new URL("./screenshot-picker.tsx", import.meta.url), "utf8");
    expect(source).toContain("projectId");
    expect(source).toContain("versionId");
    expect(source).toMatch(/JSON\.stringify\(\{[^}]*projectId[^}]*versionId/s);
    expect(source).toContain("await onBeforeUpload?.()");
  });

  it("binds font uploads to the project and version that initiated them", async () => {
    const source = await readFile(new URL("./font-importer.tsx", import.meta.url), "utf8");
    expect(source).toContain('form.append("projectId"');
    expect(source).toContain('form.append("versionId"');
    expect(source).toContain("await onBeforeUpload?.()");
  });

  it("locks editor mutations for the complete upload request", async () => {
    const source = await readFile(new URL("./screenshot-editor.tsx", import.meta.url), "utf8");
    expect(source).toContain("uploadsInFlight > 0");
    expect(source).toContain("onUploadStateChange");
  });
});
