/**
 * Pins flair#1619 stabilize rules without importing src/cli.ts.
 * A leaked process.version is how a byte-identical dump false-fails one
 * Node matrix leg; the committed snapshot must not contain it.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { stabilizeCliSurfaceText } from "../helpers/cli-surface.ts";

describe("stabilizeCliSurfaceText", () => {
  test("replaces homedir, package version, and process.version", () => {
    const raw = `home=${homedir()} pkg=9.9.9 runtime=${process.version}`;
    expect(stabilizeCliSurfaceText(raw, { version: "9.9.9" })).toBe(
      "home=~ pkg=$FLAIR_VERSION runtime=$NODE_VERSION",
    );
  });

  test("an explicit nodeVersion is replaced even when it is not this process", () => {
    const out = stabilizeCliSurfaceText("found v26.8.2", { nodeVersion: "v26.8.2" });
    expect(out).toBe("found $NODE_VERSION");
    expect(out).not.toContain("v26.8.2");
  });
});
