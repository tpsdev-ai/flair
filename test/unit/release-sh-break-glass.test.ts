// flair#1038 — release.sh --publish must be unmistakably break-glass.
//
// Source-inspection of the same script already lives in
// ci-gate-coverage.test.ts (partial-publish tagging). These cases spawn the
// real script: a half-remembered `--publish` must print the banner and stop
// before any npm publish, and phase-1 next-steps must not recruit operators
// into this path.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release.sh");
const SRC = readFileSync(SCRIPT, "utf8");

function runPublish(args: string[], stdin?: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    input: stdin,
    timeout: 20_000,
    cwd: REPO_ROOT,
    env,
  });
}

/** Spawn with no npm credentials so the auth gate is what actually runs. */
function runPublishUnauth(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "flair-release-unauth-"));
  return runPublish(args, undefined, {
    ...process.env,
    HOME: home,
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    npm_config_userconfig: join(home, ".npmrc"),
    NPM_TOKEN: "",
    NODE_AUTH_TOKEN: "",
  });
}

function output(r: ReturnType<typeof spawnSync>): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("release.sh --publish is the break-glass path", () => {
  test("prints the BREAK-GLASS banner before any publish work", () => {
    const r = runPublish(["9.9.9", "--publish"], "nope\n");
    const out = output(r);
    expect(out).toContain("BREAK-GLASS");
    expect(out).toContain("git tag v9.9.9 && git push origin v9.9.9");
    expect(out).toContain("docs/releasing.md");
    expect(out).not.toContain("Publishing to npm");
    expect(r.status).not.toBe(0);
  });

  test("declining the prompt aborts without publishing", () => {
    const r = runPublish(["9.9.9", "--publish"], "nope\n");
    const out = output(r);
    expect(r.status).toBe(1);
    expect(out).toContain("Aborted. Nothing was published.");
    expect(out).not.toContain("Publishing to npm");
    expect(out).not.toContain("npm login");
  });

  test("non-interactive --publish without acknowledgement refuses", () => {
    const r = runPublish(["9.9.9", "--publish"]);
    const out = output(r);
    expect(r.status).toBe(1);
    expect(out).toContain("BREAK-GLASS");
    expect(out).toContain("--break-glass");
    expect(out).not.toContain("Publishing to npm");
  });

  test("--break-glass acknowledges, then fails closed before npm publish", () => {
    const r = runPublish(["9.9.9", "--publish", "--break-glass"]);
    const out = output(r);
    expect(out).toContain("BREAK-GLASS");
    expect(out).toContain("Acknowledged via --break-glass.");
    expect(r.status).not.toBe(0);
    expect(out).not.toContain("Publishing to npm");
    // Either our auth message or a later safety check — never npm's ENEEDAUTH.
    expect(out).not.toMatch(/need auth You need to authorize this machine using `npm login`/);
  });

  test("unauthenticated --break-glass names the tag path, not npm login as the fix", () => {
    const r = runPublishUnauth(["9.9.9", "--publish", "--break-glass"]);
    const out = output(r);
    expect(r.status).toBe(1);
    expect(out).toContain("This machine is not logged into npm");
    expect(out).toContain("git tag v9.9.9 && git push origin v9.9.9");
    expect(out).toMatch(/Do not run `npm login` unless CI staging is actually unavailable/);
    expect(out).not.toContain("Publishing to npm");
    expect(out).not.toMatch(/need auth You need to authorize this machine using `npm login`/);
  });

  test("--break-glass without --publish fails closed instead of entering Phase 1", () => {
    const r = runPublish(["9.9.9", "--break-glass"]);
    const out = output(r);
    expect(r.status).toBe(1);
    expect(out).toContain("--break-glass is an acknowledgement for --publish");
    expect(out).not.toContain("PR PREP");
    expect(out).not.toContain("Publishing to npm");
  });

  test("--break-glass --publish is accepted as publish + acknowledgement", () => {
    const r = runPublishUnauth(["9.9.9", "--break-glass", "--publish"]);
    const out = output(r);
    expect(out).toContain("BREAK-GLASS");
    expect(out).toContain("Acknowledged via --break-glass.");
    expect(out).toContain("This machine is not logged into npm");
    expect(r.status).toBe(1);
    expect(out).not.toContain("PR PREP");
    expect(out).not.toContain("Publishing to npm");
  });
});

describe("release.sh phase-1 wording does not recruit --publish", () => {
  test("printed next-steps name the tag push as the normal path", () => {
    const next = SRC.split('echo "Next steps:"')[1] ?? "";
    expect(next).toContain("git tag -a v${VERSION}");
    expect(next).toContain("stage-publishes via OIDC");
    expect(next).toContain("Break-glass only");
    // The old step 4 was an unmarked `--publish`. That line must not be
    // the sole/unqualified next step anymore.
    expect(next).toMatch(/Break-glass only[\s\S]*--publish/);
  });

  test("the release-PR body tags first and marks --publish as break-glass", () => {
    expect(SRC).toContain("tag the release (OIDC staging — no npm login)");
    expect(SRC).toContain("Break-glass only, if CI staging is unavailable:");
  });
});
