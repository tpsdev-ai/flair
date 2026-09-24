/**
 * upgrade-no-downgrade.test.ts — flair#1778 slice 1, fails-on-main.
 *
 * THE HAZARD. `flair upgrade` classified by bare equality, so an install AHEAD
 * of registry `latest` (a staged / never-promoted version, e.g. 0.55.0 while
 * `latest` is still 0.54.2) was "outdated": `--check` printed
 * "⬆️ 0.55.0 → 0.54.2", and a plain `flair upgrade` reached
 * `npm install -g @tpsdev-ai/flair@0.54.2` — a silent downgrade on a documented
 * command.
 *
 * THE PROOF. Serve a local registry whose `latest` is 0.54.2, put a stub `flair`
 * reporting 0.55.0 on PATH, and run the real CLI with a scratch HOME, a stub npm
 * that only RECORDS its argv, and a dead FLAIR_URL. On main the output carries
 * the arrow and npm is invoked; after the fix it prints
 * "(ahead of latest 0.54.2)", never the arrow, and npm is never asked to install.
 *
 * Isolated: the CLI is spawned as a CHILD with HOME set at spawn (so its data
 * dir is a scratch tree — never a real instance), and every write stays inside
 * scratch trees. No real instance, no service manager, no install.
 */

import { describe, test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dirname, "..", "..");

// Each case spawns the real CLI as a child; bun's 5s default is too tight.
setDefaultTimeout(60_000);

/** This repo's OWN version: `mcpServerSpec()` pins wired clients to it, so it is
 *  the "running CLI" every pin comparison is measured against. Read at test
 *  time so a release bump moves it too. */
function repoVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")) as { version?: string };
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`root package.json has no version: ${pkg.version}`);
  }
  return pkg.version;
}

/** The NEXT MINOR, strictly greater than the version it is derived from
 *  (0.55.2 → 0.56.0, 0.56.0 → 0.57.0). "Ahead of the running CLI" must survive
 *  a release bump; a literal near the current version does not — the bump
 *  overtakes it and the fixture stops meaning "ahead" at all. */
function nextMinor(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`repo version is not semver: ${version}`);
  return `${m[1]}.${Number(m[2]) + 1}.0`;
}

const HOME = mkdtempSync(join(tmpdir(), "flair-1778-home-"));
const SCRATCH = mkdtempSync(join(tmpdir(), "flair-1778-scratch-"));
const BIN = join(SCRATCH, "bin");
const PREFIX = join(SCRATCH, "prefix");
const INSTALLED_FILE = join(SCRATCH, "installed-version");
const NPM_LOG = join(SCRATCH, "npm-invocations.log");
// A scratch node_modules reachable via NODE_PATH: this is the "genuinely
// outdated sibling" (flair-client@0.1.0) that the mixed fixture installs,
// while @tpsdev-ai/flair is ahead. probeLibVersion resolves it from here.
const NODE_MODULES = join(SCRATCH, "node_modules");
const CACHE_FILE = join(HOME, ".flair", ".version-check-cache.json");
const CLAUDE_JSON = join(HOME, ".claude.json");
mkdirSync(BIN, { recursive: true });
mkdirSync(join(PREFIX, "lib", "node_modules"), { recursive: true });
mkdirSync(join(NODE_MODULES, "@tpsdev-ai", "flair-client"), { recursive: true });
writeFileSync(
  join(NODE_MODULES, "@tpsdev-ai", "flair-client", "package.json"),
  JSON.stringify({ name: "@tpsdev-ai/flair-client", version: "0.1.0" }),
);
writeFileSync(INSTALLED_FILE, "0.55.0\n");

for (const bin of ["flair", "flair-mcp"]) {
  const p = join(BIN, bin);
  writeFileSync(p, `#!/bin/sh\ncat ${INSTALLED_FILE}\n`);
  chmodSync(p, 0o755);
}
writeFileSync(
  join(BIN, "npm"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${NPM_LOG}\nif [ "$1" = "prefix" ]; then echo ${PREFIX}; fi\nexit 0\n`,
);
chmodSync(join(BIN, "npm"), 0o755);

const servers: Server[] = [];
function listen(srv: Server): Promise<number> {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve((srv.address() as any).port)));
}

/** Minimal registry stand-in: a per-package `latest`, default LATEST. */
async function startRegistry(overrides: Record<string, string> = {}): Promise<string> {
  const srv = createServer((req, res) => {
    const url = req.url ?? "";
    let version = "0.54.2";
    for (const [pkg, v] of Object.entries(overrides)) if (url.includes(pkg)) version = v;
    const body = JSON.stringify({ name: "@tpsdev-ai/flair", version });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  const port = await listen(srv);
  return `http://127.0.0.1:${port}`;
}

afterAll(() => {
  for (const s of servers) s.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
});

function setInstalled(version: string): void {
  writeFileSync(INSTALLED_FILE, `${version}\n`);
}

async function runUpgrade(
  registry: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const env = {
    ...process.env,
    HOME,
    PATH: `${BIN}:${process.env.PATH}`,
    FLAIR_URL: "http://127.0.0.1:9", // dead port: no instance can be detected
    npm_config_prefix: PREFIX,
    npm_config_registry: registry,
    npm_config_userconfig: join(SCRATCH, "user-npmrc"),
    npm_config_globalconfig: join(SCRATCH, "global-npmrc"),
    FLAIR_ALLOW_INSECURE_REGISTRY: "1",
    ...extraEnv,
  };
  // Async spawn, NOT spawnSync: the stub registry lives in THIS process, and a
  // synchronous child would block the event loop so the stub could never answer.
  const proc = Bun.spawn(["bun", join(REPO, "src", "cli.ts"), "upgrade", ...args], {
    cwd: REPO,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { stdout, stderr, status };
}

function manifestHash(dir: string): string {
  const entries: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else entries.push(`${p}:${statSync(p).size}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function npmInvocations(): string {
  return existsSync(NPM_LOG) ? readFileSync(NPM_LOG, "utf-8") : "";
}

/** The primed version-check cache (`~/.flair/.version-check-cache.json`). */
function readVersionCheckCache(): { latest?: string; checkedAt?: number } | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

describe("flair#1778 — an install AHEAD of registry latest is never downgraded", () => {
  test("HAZARD: --check shows '(ahead of latest)', no arrow, no '→ 0.54.2'", async () => {
    setInstalled("0.55.0");
    const reg = await startRegistry();
    const { stdout } = await runUpgrade(reg, ["--check"]);
    expect(stdout).not.toContain("⬆️");
    expect(stdout).not.toContain("→ 0.54.2");
    expect(stdout).toContain("(ahead of latest 0.54.2)");
    expect(stdout).toContain("No upgrades available");
  });

  test("HAZARD: plain run invokes NO install and leaves the tree byte-identical", async () => {
    setInstalled("0.55.0");
    const reg = await startRegistry();
    const before = manifestHash(PREFIX);
    const { stdout } = await runUpgrade(reg, []);
    expect(manifestHash(PREFIX)).toBe(before);
    const npm = npmInvocations();
    expect(npm).not.toContain("install");
    expect(npm).not.toContain("@tpsdev-ai/flair@0.54.2");
    expect(stdout).not.toContain("⬆️");
    expect(stdout).toContain("(ahead of latest 0.54.2)");
  });

  test("regression: installed 0.54.2 / latest 0.55.1 still upgrades", async () => {
    setInstalled("0.54.2");
    const reg = await startRegistry({ "": "0.55.1" });
    const { stdout } = await runUpgrade(reg, ["--check"]);
    expect(stdout).toContain("⬆️");
    expect(stdout).toContain("→ 0.55.1");
  });

  test("prerelease: installed 0.56.0-rc.1 ahead of 0.55.1; 0.55.1 outdated vs a prerelease latest", async () => {
    setInstalled("0.56.0-rc.1");
    let r = await runUpgrade(await startRegistry({ "": "0.55.1" }), ["--check"]);
    expect(r.stdout).toContain("(ahead of latest 0.55.1)");
    expect(r.stdout).not.toContain("⬆️");

    // The registry validator (isStrictSemver) ACCEPTS a prerelease `latest`, so
    // a prerelease can be a real upgrade target — asserted, not assumed.
    setInstalled("0.55.1");
    r = await runUpgrade(await startRegistry({ "": "0.56.0-rc.1" }), ["--check"]);
    expect(r.stdout).toContain("→ 0.56.0-rc.1");
  });

  test("unparseable installed version renders '❔ unknown', no arrow, no install", async () => {
    // A version-shaped but semver-INVALID string: the bin probe returns it, and
    // the classifier must render "unknown", never "outdated", never drop it.
    setInstalled("1.2.3.4");
    const reg = await startRegistry();
    const check = await runUpgrade(reg, ["--check"]);
    expect(check.stdout).toContain("1.2.3.4 (unknown)");
    expect(check.stdout).not.toContain("⬆️");

    const before = manifestHash(PREFIX);
    await runUpgrade(reg, []);
    expect(manifestHash(PREFIX)).toBe(before);
    expect(npmInvocations()).not.toContain("install");
  });

  test("N1: an unparseable installed version is never summarised as 'Everything is up to date'", async () => {
    // The summary must be NEUTRAL whenever any finding is `ahead` OR `unknown`:
    // "✅ Everything is up to date." claims a convergence we cannot see when the
    // installed version did not even parse (flair#1778 slice-1 follow-up).
    //
    // NOTE: the raw string must be one the bin probe RETURNS VERBATIM yet semver
    // rejects. probeBinVersion only yields a semver-SHAPED match (its regex
    // requires digits), and any non-match falls back to probeLibVersion, which
    // self-references this package (0.55.x) — so a bare "not-a-version" would
    // resolve to "current" and never exercise the unknown path. "0.55.1.rc" is
    // version-shaped (so it comes back from the probe) but not valid semver.
    const unparseable = "0.55.1.rc";
    setInstalled(unparseable);
    const reg = await startRegistry({ "": "0.55.1" });
    const { stdout } = await runUpgrade(reg, []);
    expect(stdout).not.toContain("Everything is up to date");
    expect(stdout).toContain("No upgrades available");
    // ...and ONE line naming the package and the raw string that was unparsed.
    expect(stdout).toContain(`@tpsdev-ai/flair: could not parse installed version "${unparseable}"`);
  });

  test("N3: flair ahead + an outdated sibling — only the sibling installs; the pin holds; the cache expects the RUNNING flair", async () => {
    setInstalled("0.55.0");
    // A wired MCP pin AHEAD of the running CLI: the post-install pin refresh
    // must HOLD it (never lower a pin), so this file stays byte-identical.
    // Derived from the CLI's own version — a literal near the current version
    // is overtaken by the next release bump (flair#1778 N3 follow-up).
    const ahead = nextMinor(repoVersion());
    const claudeBefore = JSON.stringify({
      mcpServers: {
        flair: {
          command: "npx",
          args: ["-y", `@tpsdev-ai/flair-mcp@${ahead}`],
          type: "stdio",
          env: { FLAIR_AGENT_ID: "local", FLAIR_URL: "http://127.0.0.1:9" },
        },
      },
    }, null, 2) + "\n";
    writeFileSync(CLAUDE_JSON, claudeBefore);
    writeFileSync(NPM_LOG, "");

    // flair ahead of latest (0.54.2); flair-client genuinely outdated (0.1.0
    // vs 0.60.0). --all surfaces the usually-hidden transitive flair-client.
    const reg = await startRegistry({
      "@tpsdev-ai/flair": "0.54.2",
      "@tpsdev-ai/flair-client": "0.60.0",
    });
    const { stdout, status } = await runUpgrade(reg, ["--all", "--no-restart"], {
      NODE_PATH: NODE_MODULES,
      FLAIR_AGENT_ID: "local",
    });

    // The genuinely-outdated sibling IS installed...
    const npm = npmInvocations();
    expect(npm).toContain("install -g @tpsdev-ai/flair-client@0.60.0");
    // ...and flair, ahead of latest, is NEVER installed (no downgrade).
    expect(npm).not.toContain("install -g @tpsdev-ai/flair@");
    expect(stdout).toContain("@tpsdev-ai/flair: 0.55.0 (ahead of latest 0.54.2)");

    // The owned-pin refresh HOLDS: the wired pin file is byte-identical, and
    // the printed line names both pins.
    expect(readFileSync(CLAUDE_JSON, "utf-8")).toBe(claudeBefore);
    expect(stdout).toContain(`keeping pinned ${ahead}`);
    expect(stdout).toContain("a pin is never lowered");

    // Post-install verification expects the RUNNING flair version (0.55.0),
    // never registry latest (0.54.2) — the primeVersionCheckCache effective
    // target. This is the observable of the "effective-target line".
    expect(readVersionCheckCache()?.latest).toBe("0.55.0");

    // No failed-upgrade / rollback report.
    expect(stdout).not.toContain("post-restart verification failed");
    expect(stdout).not.toContain("Rolling back");
    expect(stdout).not.toContain("upgrade failed");
    expect(status).toBe(0);
  });

  test("Q2: an openclaw plugin with an unparseable version renders ❔ unknown and the neutral summary", async () => {
    // probeOpenclawPluginVersion returns the extension package.json's version
    // VERBATIM (no regex), so `unknown` is reachable for the openclaw-plugin
    // kind (unlike the flair/flair-mcp bin probes, which only return
    // semver-shaped strings).
    setInstalled("0.55.0");
    mkdirSync(join(HOME, ".openclaw", "extensions", "openclaw-flair"), { recursive: true });
    writeFileSync(
      join(HOME, ".openclaw", "extensions", "openclaw-flair", "package.json"),
      JSON.stringify({ name: "@tpsdev-ai/openclaw-flair", version: "garbage" }),
    );
    writeFileSync(NPM_LOG, "");
    const reg = await startRegistry({ "@tpsdev-ai/flair": "0.54.2" });
    const { stdout } = await runUpgrade(reg, []);
    expect(stdout).not.toContain("Everything is up to date");
    expect(stdout).toContain("No upgrades available");
    expect(stdout).toContain('@tpsdev-ai/openclaw-flair: could not parse installed version "garbage"');
    const npm = npmInvocations();
    expect(npm).not.toContain("install -g @tpsdev-ai/openclaw-flair");
    expect(npm).not.toContain("install -g @tpsdev-ai/flair@");
  });

  test("Q3: with flair ahead and a sibling undetected, the summary never says 'up to date'", async () => {
    setInstalled("0.55.0");
    // Clean wiring so flair-mcp is genuinely UNDETECTED (no global bin, not
    // wired) and no openclaw unknown lingers from Q2.
    rmSync(CLAUDE_JSON, { force: true });
    rmSync(join(HOME, ".openclaw", "extensions", "openclaw-flair"), { recursive: true, force: true });
    const mcpStub = join(BIN, "flair-mcp");
    const original = readFileSync(mcpStub, "utf-8");
    writeFileSync(mcpStub, "#!/bin/sh\nexit 0\n");
    chmodSync(mcpStub, 0o755);
    try {
      const reg = await startRegistry({ "@tpsdev-ai/flair": "0.54.2" });
      const { stdout } = await runUpgrade(reg, []);
      // The `missing > 0` branch used to claim "all detected packages are up to
      // date" even with an ahead finding — the same false convergence N1 fixes.
      expect(stdout).not.toContain("all detected packages are up to date");
      expect(stdout).toContain("no upgrades available for the rest");
      expect(stdout).toContain("not detected");
      expect(stdout).toContain("@tpsdev-ai/flair: 0.55.0 (ahead of latest 0.54.2)");
    } finally {
      writeFileSync(mcpStub, original);
      chmodSync(mcpStub, 0o755);
    }
  });
});
