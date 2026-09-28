import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tempDir } from "../helpers/temp-dir.ts";
import { readFragments } from "../../scripts/changelog-fragments.mjs";
const repo = realpathSync(join(import.meta.dirname, "../.."));
function lint(text: string): string | null {
  const path = join(realpathSync(tempDir("flair-1769-fragment-")), "fixed-example.md");
  writeFileSync(path, text);
  try { readFragments(dirname(path)); return null; }
  catch (error) { if (!(error instanceof Error)) throw error; return error.message; }
}
const entry = (body: string) => `- **A concise change.**\n  ${body}\n`;
for (const body of ["Run `flair doctor`.", "Set `FLAIR_MODE`.", "Add `--local`.", "Remove `--old`.", "You must run the upgrade.", "Before upgrading, set the mode."]) {
  test(`requires Heads-up: ${body}`, () => {
    expect(lint(entry(body))).toContain("Heads-up");
    expect(lint(entry(body + "\n  > **Heads-up:** " + body))).toBeNull();
  });
}
for (const body of ["The `--local` flag is documented.", "`FLAIR_MODE` selects the mode.", "The server will not start.", "The renderer can run commands.", "```sh\nRun `example`.\n```"]) {
  test(`descriptive or quoted: ${body}`, () => expect(lint(entry(body))).toBeNull());
}
test("lede and wrapped instructions", () => {
  expect(lint("- **Run `flair doctor`.**\n  Details.")).toBeNull();
  expect(lint(entry("Run\n  `flair doctor`."))).toContain("Heads-up");
  expect(lint(entry("Run `flair doctor`.\n  ```md\n  > **Heads-up:** example\n  ```"))).toContain("Heads-up");
});
test("release preview renders and fails visibly", () => {
  const release = readFileSync(join(repo, "scripts/release.sh"), "utf8");
  const block = release.match(/# Preview published release notes\.\n([\s\S]*?)\n# 2\. Bump/);
  if (!block) throw new Error("release preview block missing");
  expect(release.indexOf(block[0])).toBeLessThan(release.indexOf('git_push_auth "$RELEASE_BRANCH"'));
  const root = realpathSync(tempDir("flair-1769-preview-"));
  for (const dir of ["scripts", "bin"]) mkdirSync(join(root, dir));
  for (const name of ["changelog-release-notes.mjs", "changelog-extract.mjs"]) copyFileSync(join(repo, "scripts", name), join(root, "scripts", name));
  symlinkSync(process.execPath, join(root, "bin/node"));
  const run = () => {
    const result = spawnSync("/bin/bash", ["-c", block[1]], { cwd: root, env: { ROOT: root, VERSION: "1.2.3", PATH: join(root, "bin"), HOME: root, USERPROFILE: root }, encoding: "utf8", timeout: 5000 });
    if (result.error) throw result.error; return result;
  };
  writeFileSync(join(root, "CHANGELOG.md"), "## [1.2.3]\n\n### Fixed\n\n" + entry("Hidden detail.\n  > **Heads-up:** Run `flair doctor`."));
  const good = run(); expect(good.status).toBe(0); expect(good.stdout).toContain("> **Heads-up:** Run `flair doctor`.");
  expect(good.stdout).toContain("**A concise change.**"); expect(good.stdout).not.toContain("Hidden detail.");
  writeFileSync(join(root, "CHANGELOG.md"), "");
  const bad = run(); expect(bad.status).not.toBe(0); expect(bad.stdout).toContain("Release-note rendering failed.");
});
