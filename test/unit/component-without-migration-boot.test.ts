/**
 * component-without-migration-boot.test.ts — the composed boot-1 helper's own
 * test (flair#1785 slice 2).
 *
 * Hermetic on purpose: the helper is pointed at a SYNTHETIC source component, so
 * this needs no built tree and no Harper — it can run anywhere. The integration
 * fixture is what exercises the real built component.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  componentWithoutMigrationBoot,
  OMITTED_TRIGGER_REL,
} from "../helpers/component-without-migration-boot.js";

let tempRoots: string[] = [];

function makeSource(): string {
  const src = mkdtempSync(join(tmpdir(), "flair-composed-src-"));
  tempRoots.push(src);
  mkdirSync(join(src, "dist", "resources", "migrations"), { recursive: true });
  writeFileSync(join(src, OMITTED_TRIGGER_REL), "export const scheduled = true;\n");
  writeFileSync(join(src, "dist", "resources", "health.js"), "export const health = true;\n");
  writeFileSync(join(src, "dist", "resources", "migrations", "runner.js"), "export const runner = true;\n");
  writeFileSync(join(src, "config.yaml"), "name: synth\njsResource:\n  files: dist/resources/*.js\n");
  writeFileSync(join(src, "package.json"), '{"name":"synth","version":"0.0.0"}\n');
  mkdirSync(join(src, "schemas"), { recursive: true });
  writeFileSync(join(src, "schemas", "memory.graphql"), "type Memory { id: ID }\n");
  return src;
}

afterEach(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
  tempRoots = [];
});

describe("componentWithoutMigrationBoot — the composed boot-1 copy (flair#1785 slice 2)", () => {
  test("copies the component, omits ONLY the trigger, keeps everything else, and cleans up", () => {
    const src = makeSource();
    const copy = componentWithoutMigrationBoot({ sourceRoot: src });
    try {
      expect(existsSync(copy.dir)).toBe(true);

      // The one omitted file: the boot-cycle trigger.
      expect(existsSync(join(copy.dir, OMITTED_TRIGGER_REL))).toBe(false);

      // Everything else the component needs is present.
      expect(existsSync(join(copy.dir, "config.yaml"))).toBe(true);
      expect(existsSync(join(copy.dir, "package.json"))).toBe(true);
      expect(existsSync(join(copy.dir, "dist", "resources", "health.js"))).toBe(true);
      expect(existsSync(join(copy.dir, "dist", "resources", "migrations", "runner.js"))).toBe(true);
      expect(existsSync(join(copy.dir, "schemas", "memory.graphql"))).toBe(true);

      // The glob the loader actually reads matches the ordinary resources and
      // NOT the trigger.
      const globbed = readdirSync(join(copy.dir, "dist", "resources")).filter((n) => n.endsWith(".js"));
      expect(globbed).toContain("health.js");
      expect(globbed).not.toContain("migration-boot.js");

      // The SOURCE is untouched — the omission is per-copy, never in place.
      expect(existsSync(join(src, OMITTED_TRIGGER_REL))).toBe(true);
    } finally {
      copy.cleanup();
    }
    expect(existsSync(copy.dir)).toBe(false); // cleanup removes the copy
  });

  test("refuses an unbuilt source BY NAME (a missing source trigger cannot prove composition)", () => {
    const src = mkdtempSync(join(tmpdir(), "flair-composed-empty-"));
    tempRoots.push(src);
    expect(() => componentWithoutMigrationBoot({ sourceRoot: src })).toThrow(
      /source trigger not found .*not built/,
    );
  });
});
