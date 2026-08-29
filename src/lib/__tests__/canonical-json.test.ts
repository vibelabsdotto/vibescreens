import { describe, expect, it } from "vitest";

import { canonicalJson, sha256CanonicalJson } from "../canonical-json";

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const value = {
      z: [{ second: 2, first: 1 }, "tail"],
      a: { beta: true, alpha: false },
    };

    expect(canonicalJson(value)).toBe(
      '{"a":{"alpha":false,"beta":true},"z":[{"first":1,"second":2},"tail"]}',
    );
  });

  it("produces the same JSON and SHA-256 for different insertion orders", async () => {
    const first = { b: 2, a: 1 };
    const second = { a: 1, b: 2 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    await expect(sha256CanonicalJson(first)).resolves.toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    await expect(sha256CanonicalJson(second)).resolves.toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });
});
