import { describe, expect, it } from "vitest";

import { hasTheme, themeById } from "../constants";

describe("project theme compatibility", () => {
  it("renders migrated UBulk projects with their original theme", () => {
    expect(hasTheme("ubulk-dark")).toBe(true);
    expect(themeById("ubulk-dark")).toEqual({
      id: "ubulk-dark",
      name: "UBulk Dark",
      bg: "#0B0B0F",
      bgAlt: "#F7F3ED",
      fg: "#F7F3ED",
      fgAlt: "#0B0B0F",
      accent: "#FF7A1A",
      muted: "#A7A3A0",
    });
  });
});
