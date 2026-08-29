import { describe, expect, it } from "vitest";

import {
  createAppId,
  createDeckId,
  createVersionId,
  isAppId,
  isDeckId,
  isVersionId,
} from "../ids";

describe("domain IDs", () => {
  it("creates distinct branded app IDs with the app prefix", () => {
    const first = createAppId();
    const second = createAppId();

    expect(first).toMatch(/^app_[A-Za-z0-9_-]{1,64}$/);
    expect(second).toMatch(/^app_[A-Za-z0-9_-]{1,64}$/);
    expect(second).not.toBe(first);
  });

  it("creates distinct branded version IDs with the ver prefix", () => {
    const first = createVersionId();
    const second = createVersionId();

    expect(first).toMatch(/^ver_[A-Za-z0-9_-]{1,64}$/);
    expect(second).toMatch(/^ver_[A-Za-z0-9_-]{1,64}$/);
    expect(second).not.toBe(first);
  });

  it("creates distinct branded deck IDs with the deck prefix", () => {
    const first = createDeckId();
    const second = createDeckId();

    expect(first).toMatch(/^deck_[A-Za-z0-9_-]{1,64}$/);
    expect(second).toMatch(/^deck_[A-Za-z0-9_-]{1,64}$/);
    expect(second).not.toBe(first);
  });

  it("validates only bounded, path-safe IDs with the right prefix", () => {
    expect(isAppId("app_a")).toBe(true);
    expect(isAppId(`app_${"a".repeat(64)}`)).toBe(true);
    expect(isAppId("ver_a")).toBe(false);
    expect(isAppId("app_../escape")).toBe(false);
    expect(isAppId(`app_${"a".repeat(65)}`)).toBe(false);

    expect(isVersionId("ver_a")).toBe(true);
    expect(isVersionId(`ver_${"a".repeat(64)}`)).toBe(true);
    expect(isVersionId("app_a")).toBe(false);
    expect(isVersionId("ver_../escape")).toBe(false);
    expect(isVersionId(`ver_${"a".repeat(65)}`)).toBe(false);

    expect(isDeckId("deck_a")).toBe(true);
    expect(isDeckId(`deck_${"a".repeat(64)}`)).toBe(true);
    expect(isDeckId("ver_a")).toBe(false);
    expect(isDeckId("deck_../escape")).toBe(false);
    expect(isDeckId(`deck_${"a".repeat(65)}`)).toBe(false);
  });
});
