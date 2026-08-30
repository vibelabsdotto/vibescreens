import { describe, expect, it } from "vitest";

import { getResetDeckActions, getSelectableLocales } from "./toolbar-contract";

describe("getResetDeckActions", () => {
  it("offers exactly one reset action for the active v3 deck", () => {
    expect(getResetDeckActions("iPhone")).toEqual([
      {
        id: "active-deck",
        label: "Reset active iPhone deck",
      },
    ]);
  });
});

describe("getSelectableLocales", () => {
  it("keeps existing locales and offers English and German for single-locale projects", () => {
    expect(getSelectableLocales(["en"])).toEqual(["en", "de"]);
  });

  it("deduplicates locale tags case-insensitively without changing persisted spelling", () => {
    expect(getSelectableLocales(["fr-FR", "EN", "fr-fr"])).toEqual([
      "fr-FR",
      "EN",
      "de",
    ]);
  });
});
