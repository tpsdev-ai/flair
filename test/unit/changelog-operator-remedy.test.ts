import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tempDir } from "../helpers/temp-dir.ts";
import { readFragments } from "../../scripts/changelog-fragments.mjs";
import { renderReleaseNotes } from "../../scripts/changelog-release-notes.mjs";

const repo = realpathSync(join(import.meta.dirname, "../.."));
const remedy = "operator remedy would be omitted from release notes; put it in a > **Heads-up:** block";
const rejection = `.changelog/unreleased/fixed-example.md: ${remedy}`;

function lint(text: string): string | null {
  const path = join(realpathSync(tempDir("flair-1769-fragment-")), "fixed-example.md");
  writeFileSync(path, text);
  try {
    const fragments = readFragments(dirname(path));
    expect(fragments).toHaveLength(1);
    expect(fragments[0].body).toBe(text.trimEnd());
    return null;
  } catch (error) {
    if (error instanceof Error && error.message === rejection) return error.message;
    throw error;
  }
}

const entry = (body: string) => `- **A concise change.**\n  ${body}\n`;
const render = (text: string) => renderReleaseNotes(`### Fixed\n\n${text}`, { version: "1.2.3" });

for (const body of [
  "Run `flair doctor`.",
  "Set `FLAIR_MODE`.",
  "Add `--local`.",
  "Remove `--old`.",
  "You must run the upgrade.",
  "Before upgrading, set the mode.",
]) {
  test(`requires Heads-up: ${body}`, () => {
    expect(lint(entry(body))).toBe(rejection);
    // Move the instruction into the surfaced block; duplication leaves body prose to scan.
    const surfaced = entry(`> **Heads-up:** ${body}`);
    expect(lint(surfaced)).toBeNull();
    expect(render(surfaced)).toContain(`> **Heads-up:** ${body}`);
    expect(lint(entry(`${body}\n  > **Heads-up:** ${body}`))).toBe(rejection);
  });
}

for (const body of [
  "The `--local` flag is documented.",
  "`FLAIR_MODE` selects the mode.",
  "The server will not start.",
  "The renderer can run commands.",
  "```sh\nRun `example`.\n```",
]) {
  test(`descriptive or quoted: ${body}`, () => {
    expect(lint(entry(body))).toBeNull();
  });
}

test("lede and wrapped instructions", () => {
  expect(lint("- **Run `flair doctor`.**\n  Details.")).toBeNull();
  expect(lint(entry("Run\n  `flair doctor`."))).toBe(rejection);
  expect(lint(entry("Run `flair doctor`.\n  ```md\n  > **Heads-up:** example\n  ```"))).toBe(rejection);
});

for (const [position, body] of [
  ["before", "Run `flair doctor` before upgrading.\n  > **Heads-up:** The default port changed."],
  ["after a continuation", "> **Heads-up:** The default port changed.\n  > Check the new address.\n  Run `flair doctor`."],
  ["after a blank line", "> **Heads-up:** The default port changed.\n\n  Run `flair doctor`."],
  ["in a separate quote", "> **Heads-up:** The default port changed.\n\n  > You must run `flair doctor`."],
  ["between blocks", "> **Heads-up:** The default port changed.\n  Run `flair doctor`.\n  > **Heads-up:** The log format changed."],
]) {
  test(`R2: unrelated Heads-up does not exempt instructions ${position}`, () => {
    const text = entry(body);
    expect(lint(text)).toBe(rejection);
    expect(render(text)).not.toContain("flair doctor");
  });
}

for (const prefix of ["After upgrading, run", "To upgrade, run"]) {
  test(`R2: requires Heads-up for ${prefix}`, () => {
    const body = `${prefix} \`flair doctor\`.`;
    for (const unsurfaced of [body, `Details. ${body}`, body.replace(", ", ",\n  ")]) {
      const text = entry(unsurfaced);
      expect(lint(text)).toBe(rejection);
      expect(render(text)).not.toContain("flair doctor");
    }
    const surfaced = entry(`> **Heads-up:** ${body}`);
    expect(lint(surfaced)).toBeNull();
    expect(render(surfaced)).toContain(`> **Heads-up:** ${body}`);
  });
}

test("Heads-up instructions and contiguous quote continuations stay surfaced", () => {
  const lines = [
    "> **Heads-up:** Run `flair doctor`.",
    "> You must set the mode.",
    ">",
    "> After upgrading, run `flair doctor`.",
    "> To upgrade, run `flair doctor`.",
  ];
  const text = entry(`${lines.join("\n  ")}\n  Descriptive detail.`);
  expect(lint(text)).toBeNull();
  const notes = render(text);
  for (const line of lines) expect(notes).toContain(`  ${line}\n`);
  expect(notes).not.toContain("Descriptive detail.");
});

test("release preview renders and fails visibly", () => {
  const release = readFileSync(join(repo, "scripts/release.sh"), "utf8");
  const block = release.match(/# Preview published release notes\.\n([\s\S]*?)\n# 2\. Bump/);
  if (!block) throw new Error("release preview block missing");
  const pushIndex = release.indexOf('git_push_auth "$RELEASE_BRANCH"');
  expect(pushIndex).toBeGreaterThanOrEqual(0);
  expect(release.indexOf(block[0])).toBeLessThan(pushIndex);

  const root = realpathSync(tempDir("flair-1769-preview-"));
  for (const dir of ["scripts", "bin"]) mkdirSync(join(root, dir));
  for (const name of ["changelog-release-notes.mjs", "changelog-extract.mjs"]) {
    copyFileSync(join(repo, "scripts", name), join(root, "scripts", name));
  }
  symlinkSync(process.execPath, join(root, "bin/node"));

  const run = () => {
    const result = spawnSync("/bin/bash", ["-c", block[1]], {
      cwd: root,
      env: {
        ROOT: root,
        VERSION: "1.2.3",
        PATH: join(root, "bin"),
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
      },
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.error) throw result.error;
    expect(result.signal).toBeNull();
    return result;
  };

  writeFileSync(
    join(root, "CHANGELOG.md"),
    "## [1.2.3]\n\n### Fixed\n\n" + entry("Hidden detail.\n  > **Heads-up:** Run `flair doctor`."),
  );
  const good = run();
  expect(good.status).toBe(0);
  expect(good.stdout).toContain("> **Heads-up:** Run `flair doctor`.");
  expect(good.stdout).toContain("**A concise change.**");
  expect(good.stdout).not.toContain("Hidden detail.");

  writeFileSync(join(root, "CHANGELOG.md"), "");
  const bad = run();
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain("Release-note rendering failed.");
});
