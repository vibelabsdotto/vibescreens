import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { WORKSPACE_PICKER_LABELS } from "./workspace-bar-contract";

describe("workspace picker labels", () => {
  it("treats the project as the app and exposes only project and version selectors", () => {
    expect(WORKSPACE_PICKER_LABELS).toEqual({
      project: "Project",
      version: "Version",
    });
    expect(WORKSPACE_PICKER_LABELS).not.toHaveProperty("app");
  });

  it("does not expose App lifecycle callbacks", async () => {
    const source = await readFile(new URL("./workspace-bar.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/on(?:Select|Create|Rename|Delete)App/);
    expect(source).not.toContain("AppId");
  });
});
