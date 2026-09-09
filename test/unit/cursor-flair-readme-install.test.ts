import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin is not in Cursor's Marketplace (listing declined). Leading
 * Install with "search Flair in the Marketplace" is an instruction that
 * cannot succeed (flair#1421). This tripwire keeps the two paths that
 * work — directory listing and local copy/symlink — as the lead.
 */
const README = join(import.meta.dir, "../../packages/cursor-flair/README.md");
const PACKAGE_JSON = join(import.meta.dir, "../../packages/cursor-flair/package.json");

function installSection(readme: string): string {
  const after = readme.split("## Install\n")[1];
  expect(after, "README is missing an ## Install section").toBeDefined();
  return after.split("\n## ")[0] ?? "";
}

describe("cursor-flair README install path", () => {
  const readme = readFileSync(README, "utf8");
  const install = installSection(readme);

  test("Install leads with the directory listing or the local repo path, not Marketplace", () => {
    const first = install
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    expect(first).toBeDefined();
    expect(
      first!.startsWith("**Plugin directory.**") || first!.startsWith("**From this repository"),
      `Install lead was ${JSON.stringify(first)}`,
    ).toBe(true);
    expect(first).not.toMatch(/Marketplace/i);
  });

  test("Install names the two paths that work", () => {
    expect(install).toContain("cursor.directory/plugins/flair");
    expect(install).toContain("~/.cursor/plugins/local/flair");
    expect(install).toContain("cp -R packages/cursor-flair ~/.cursor/plugins/local/flair");
  });

  test("Install does not tell the reader to search the Marketplace", () => {
    expect(install).not.toMatch(/search \*\*Flair\*\* in the Marketplace/i);
    expect(install).not.toMatch(/^\*\*Marketplace\.\*\*/m);
  });

  test("package.json description does not claim a Marketplace listing", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { description: string };
    expect(pkg.description.toLowerCase()).not.toContain("marketplace");
  });
});
