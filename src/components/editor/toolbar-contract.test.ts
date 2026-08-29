import { describe, expect, it } from "vitest";

import { getResetDeckActions } from "./toolbar-contract";

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
