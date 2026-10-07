import { existsSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { EmbeddingModelError } from "../../resources/embeddings/errors.ts";
import { resolveFlairAddonPath } from "../../resources/embeddings/engine.ts";

describe("flair addon resolution", () => {
  it("resolves llama-addon.node from Flair's node-llama-cpp prebuilt", () => {
    const addon = resolveFlairAddonPath();
    expect(addon.endsWith("llama-addon.node")).toBe(true);
    expect(addon.includes("@node-llama-cpp")).toBe(true);
    expect(existsSync(addon)).toBe(true);
  });

  it("refuses to build from source when no prebuilt package resolves", () => {
    const miss = (): string => {
      throw new Error("cannot find module");
    };
    let caught: unknown;
    try {
      resolveFlairAddonPath(miss);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingModelError);
    if (!(caught instanceof EmbeddingModelError)) return;
    expect(caught.code).toBe("engine");
    expect(caught.remedy).toContain("Refusing to build llama.cpp from source");
  });

  it("does not treat an unreadable package entry as a found addon", () => {
    expect(() => resolveFlairAddonPath(() => "/no/such/prebuilt/dist/index.js")).toThrow(EmbeddingModelError);
  });
});
