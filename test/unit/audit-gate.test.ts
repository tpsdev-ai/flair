import { pinFixtureHistory, readFixtureHistory } from "../helpers/audit-history.ts";
import { describe, it, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import {
  isVulnerable,
  validateAllowlist,
  MAX_LIFETIME_DAYS_BY_SEVERITY,
  lifetimeCapsFromPolicy,
  overCapReportLines,
  flattenAdvisories,
  flattenNpmAdvisories,
  parseNpmAuditOutput,
  parseBunAuditOutput,
  npmAuditReportRefusal,
  bunAuditReportRefusal,
  registryUrlFor,
  overCapApprovalProblems,
  readAllowlistHistory,
  validateAllowlistHistory,
  vendorPinnedNodeProblems,
} from "../../scripts/audit-gate.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ALLOWLIST = JSON.parse(
  readFileSync(join(REPO_ROOT, ".github", "audit-allowlist.json"), "utf8"),
);
// The committed allowlist is checked as of the latest date any entry was added (never earlier than
// 2026-11-02, the date these checks were pinned to), capped at the real date: deterministic while every
// `added` is in the past, and an `added` after today still fails "added is after today" (flair#3026).
// Unparseable `added` values are skipped here and reported by the schema check. Expiry against the real
// date stays the audit gate's job in CI.
function allowlistAsOf(entries: Array<{ added: string }>, now: number): Date {
  const added = entries.map((e) => Date.parse(e.added)).filter(Number.isFinite);
  return new Date(Math.min(now, Math.max(Date.parse("2026-11-02"), ...added)));
}
const ALLOWLIST_AS_OF = allowlistAsOf(ALLOWLIST.entries, Date.now());
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");
/**
 * The seven consumer-install inputs: the flag, the allowlist source, the package
 * the flag's prefix must hold, and the workspace directory the job packs it
 * from. Listed here, not imported from the gate, so dropping an input from the
 * gate fails a case below.
 */
const CONSUMER_INPUTS = [
  { flag: "--npm-install-prefix", source: "npm-install", pkg: "@tpsdev-ai/flair", dir: "." },
  { flag: "--adk-npm-install-prefix", source: "npm-install-adk", pkg: "@tpsdev-ai/adk-flair", dir: "packages/adk-flair-js" },
  { flag: "--mcp-npm-install-prefix", source: "npm-install-mcp", pkg: "@tpsdev-ai/flair-mcp", dir: "packages/flair-mcp" },
  { flag: "--openclaw-npm-install-prefix", source: "npm-install-openclaw", pkg: "@tpsdev-ai/openclaw-flair", dir: "packages/openclaw-flair" },
  { flag: "--pi-npm-install-prefix", source: "npm-install-pi", pkg: "@tpsdev-ai/pi-flair", dir: "packages/pi-flair" },
  { flag: "--n8n-npm-install-prefix", source: "npm-install-n8n", pkg: "@tpsdev-ai/n8n-nodes-flair", dir: "packages/n8n-nodes-flair" },
  { flag: "--bench-npm-install-prefix", source: "npm-install-bench", pkg: "@tpsdev-ai/flair-bench", dir: "packages/flair-bench" },
];
/** The version every fixture workspace manifest and install record carries. */
const FIXTURE_VERSION = "1.0.0";

/** Parsed JSON at `path`, or `fallback` when the file cannot be read or parsed. */
function readJson(path: string, fallback: Record<string, any>): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Writes the files the gate's identity check reads from an npm install of the
 * packed tarball of `pkg` into `prefix`: the installed manifest (merged into
 * any already there), the consumer's package.json naming `pkg` in
 * `dependencies` from a local .tgz, and package-lock.json's "" row and
 * `node_modules/<pkg>` row to match, in the shape npm writes
 * (audit-gate-real-tools.test.ts checks real npm).
 */
function writeInstallRecord(prefix: string, pkg: string, version = FIXTURE_VERSION) {
  const dir = join(prefix, "node_modules", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...readJson(join(dir, "package.json"), {}), name: pkg, version }));
  const tgz = `file:../packed/${pkg.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  const consumer = readJson(join(prefix, "package.json"), { name: "consumer", version: "1.0.0" });
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ ...consumer, dependencies: { ...consumer.dependencies, [pkg]: tgz } }));
  const lock = readJson(join(prefix, "package-lock.json"), { lockfileVersion: 3 });
  const packages = lock.packages ?? {};
  packages[""] = { ...packages[""], dependencies: { ...packages[""]?.dependencies, [pkg]: tgz } };
  packages[`node_modules/${pkg}`] = { ...packages[`node_modules/${pkg}`], version, resolved: tgz };
  writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({ ...lock, packages }));
}

/**
 * Makes `root` a fixture repo holding the workspace manifest the job packs for
 * each input, and writes each input's install record into its own prefix.
 */
function writeIdentities(root: string, prefixOf: (source: string) => string) {
  for (const input of CONSUMER_INPUTS) {
    mkdirSync(join(root, input.dir), { recursive: true });
    const manifest = join(root, input.dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ ...readJson(manifest, {}), name: input.pkg, version: FIXTURE_VERSION }));
    writeInstallRecord(prefixOf(input.source), input.pkg);
  }
}

/**
 * Sets `deps` as the `dependencies` of `input`'s package in its workspace
 * manifest under `root` and in `prefix`'s install record (the installed
 * manifest and its package-lock.json row), so all three declare the same.
 */
function declareDependencies(
  root: string,
  input: (typeof CONSUMER_INPUTS)[number],
  prefix: string,
  deps: Record<string, string>,
) {
  for (const path of [join(root, input.dir, "package.json"), join(prefix, "node_modules", input.pkg, "package.json")]) {
    writeFileSync(path, JSON.stringify({ ...readJson(path, {}), dependencies: deps }));
  }
  const lockPath = join(prefix, "package-lock.json");
  const lock = readJson(lockPath, {});
  lock.packages[`node_modules/${input.pkg}`] = { ...lock.packages[`node_modules/${input.pkg}`], dependencies: deps };
  writeFileSync(lockPath, JSON.stringify(lock));
}

/** Every input's flag followed by its prefix. */
const prefixArgs = (prefixOf: (source: string) => string) =>
  CONSUMER_INPUTS.flatMap((input) => [input.flag, prefixOf(input.source)]);

/**
 * Commits a fixture's allowlist so the gate can read the history its cumulative
 * lifetime check depends on.
 */
function commitAllowlistHistory(root: string, date?: string) {
  const snapshots = JSON.parse(readFileSync(join(root, ".github/audit-allowlist.json"), "utf8"));
  const addedDays = snapshots.entries.map((entry: { added?: string }) => entry.added)
    .filter((day: unknown): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day));
  date ??= `${addedDays.sort().at(-1) ?? "2026-01-01"}T12:00:00Z`;
  mkdirSync(join(root, "tmp"), { recursive: true });
  const env = {
    ...process.env,
    TMPDIR: join(root, "tmp"),
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  for (const args of [["init", "-q"], ["add", ".github/audit-allowlist.json"], ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "fixture allowlist"]]) {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, timeout: 20_000 });
    if (res.status !== 0) throw new Error(`fixture git ${args[0]} failed (${res.status}): ${res.stderr}`);
  }
  pinFixtureHistory(root);
}

/**
 * These tests exist because the audit step's original defect was not a wrong
 * threshold — it was that the step could not fail at all, so no run of it was
 * ever evidence of anything. Each assertion below is a way the gate must be
 * able to go red.
 */

// ─── The regression guard that matters most ──────────────────────────────────

describe("the audit step must remain able to fail", () => {
  const auditJob = TEST_YML.slice(TEST_YML.indexOf("\n  audit:"), TEST_YML.indexOf("\n  sast-semgrep:"));
  // The job's comments deliberately quote the old broken step, so assertions
  // about the job's BEHAVIOUR must read the YAML, not the prose around it.
  const auditDirectives = auditJob
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("invokes the gate script", () => {
    expect(auditDirectives).toContain("scripts/audit-gate.mjs");
  });

  it("has no continue-on-error directive in the audit job", () => {
    // Reinstating this is the exact regression this whole change removes.
    expect(auditDirectives).not.toContain("continue-on-error");
  });

  it("does not swallow the gate's exit code with || echo, || true or || :", () => {
    const gateLine = auditDirectives.split("\n").find((l) => l.includes("audit-gate.mjs")) ?? "";
    expect(gateLine).not.toMatch(/\|\|\s*(true|echo|:)/);
    expect(gateLine.length).toBeGreaterThan(0);
  });

  it("no longer runs the bare `bun audit` whose exit code was discarded", () => {
    expect(auditDirectives).not.toMatch(/run:\s*bun audit/);
  });

  it("invokes the gate with every consumer-install prefix flag", () => {
    // The gate invocation is one shell command continued with backslashes.
    const lines = auditDirectives.split("\n");
    const start = lines.findIndex((l) => l.includes("audit-gate.mjs"));
    expect(start).toBeGreaterThanOrEqual(0);
    let end = start;
    while (end < lines.length - 1 && lines[end]!.trimEnd().endsWith("\\")) end++;
    const invocation = lines.slice(start, end + 1).join("\n");
    for (const input of CONSUMER_INPUTS) {
      expect(invocation).toMatch(new RegExp(`(?:^|\\s)${input.flag} "\\$[A-Z0-9_]+"`));
    }
    expect(invocation.match(/--[a-z0-9-]*npm-install-prefix/g)?.length).toBe(CONSUMER_INPUTS.length);
  });

  it("still carries the reasoning that explains why it is blocking", () => {
    // A future reader who deletes the comment loses the only record of why the
    // escape hatch was removed, which is how it got reinstated last time.
    expect(auditJob).toContain("PROMOTION CRITERION");
    expect(auditJob).toContain("BLOCKING");
  });
});

// ─── No bun-only mode (flair#1498) ───────────────────────────────────────────

describe("the gate refuses to run bun-only", () => {
  it("exits non-zero with the named-observation line when --npm-install-prefix is absent", () => {
    // A bun-only pass is the exact escape Sherlock's verdict forbade: a PR whose
    // tarball lane is skipped would merge with the npm observation never made.
    const res = spawnSync("node", [join(REPO_ROOT, "scripts", "audit-gate.mjs")], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("--npm-install-prefix");
    expect(res.stderr).toContain("npm-install observation");
    expect(res.stderr).toContain("missing --npm-install-prefix <dir> — the published @tpsdev-ai/flair package's");
  }, 6_000);

  it("exits non-zero when the ADK consumer observation is absent (flair#2398)", () => {
    // The published ADK package is a separate consumer artifact; npm overrides
    // in a package do not reach its consumers, so the root tree alone is not the
    // observation. A gate that can skip this check is not checking it.
    const res = spawnSync(
      "node",
      [join(REPO_ROOT, "scripts", "audit-gate.mjs"), "--npm-install-prefix", REPO_ROOT],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("--adk-npm-install-prefix");
    expect(res.stderr).toContain("consumer-install observation");
  }, 6_000);
});

// ─── The four added consumer-install inputs (flair#2757) ─────────────────────

describe("the four added consumer-install inputs, stand-in tools (flair#2757)", () => {
  const INPUTS = CONSUMER_INPUTS.slice(2);
  const GHSA = "GHSA-0000-0000-2757";
  const report = (nodes = ["node_modules/hono"]) => ({
    vulnerabilities: { hono: { nodes, via: [{
      url: `https://github.com/advisories/${GHSA}`, title: "Fixture advisory", severity: "high", range: "<4.0.1",
    }] } },
  });
  const entry = (sources: string[], extra: Record<string, unknown> = {}) => ({
    ghsa: GHSA, package: "hono", severity: "high", class: "remediation-available", sources,
    approvedBy: "fixture", introducedBy: "fixture -> hono", reason: "Fixture entry.",
    added: "2026-10-01", expires: "2026-11-01", removeWhen: "the fixture tree resolves hono >= 4.0.1",
    ...extra,
  });

  /**
   * The real gate in a fixture repo with stand-in tools. Each input has its own
   * prefix holding that input's install record (writeIdentities); `setup` runs
   * after that. `bun` reports nothing, and `npm` prints `reports[source]` in
   * that input's prefix and an empty report in every other prefix. `omit`
   * leaves a flag off the command line; `reuse` maps a flag to the source whose
   * prefix it is given instead of its own.
   */
  function runGate(opts: {
    omit?: string;
    reuse?: Record<string, string>;
    reports?: Record<string, object>;
    entries?: object[];
    setup?: (prefixes: Record<string, string>, root: string) => void;
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-consumers-"));
    try {
      for (const dir of ["scripts", ".github", "bin", "home", "tmp"]) mkdirSync(join(root, dir));
      writeFileSync(join(root, "scripts/audit-gate.mjs"), readFileSync(join(REPO_ROOT, "scripts/audit-gate.mjs")));
      writeFileSync(join(root, ".github/audit-allowlist.json"), JSON.stringify({
        policy: ALLOWLIST.policy, entries: opts.entries ?? [],
      }));
      commitAllowlistHistory(root);
      const prefixes: Record<string, string> = Object.fromEntries(
        CONSUMER_INPUTS.map(({ source }) => [source, join(root, `prefix-${source}`)]),
      );
      writeIdentities(root, (source) => prefixes[source]!);
      opts.setup?.(prefixes, root);
      const cases = Object.entries(opts.reports ?? {})
        .map(([source, body]) => `  */prefix-${source}) printf '%s\\n' '${JSON.stringify(body)}' ;;\n`)
        .join("");
      const empty = JSON.stringify({ vulnerabilities: {} });
      writeFileSync(join(root, "bin/npm"), `#!/bin/sh\ncase "$PWD" in\n${cases}  *) printf '%s\\n' '${empty}' ;;\nesac\n`);
      writeFileSync(join(root, "bin/bun"), "#!/bin/sh\nprintf '{}\\n'\n");
      chmodSync(join(root, "bin/npm"), 0o755);
      chmodSync(join(root, "bin/bun"), 0o755);
      writeFileSync(join(root, "offline.mjs"), "globalThis.fetch = async () => { throw new Error('fixture offline'); };\n");
      const args = CONSUMER_INPUTS.flatMap(({ flag, source }) =>
        flag === opts.omit ? [] : [flag, prefixes[opts.reuse?.[flag] ?? source]!]);
      return spawnSync(
        process.execPath,
        ["--import", join(root, "offline.mjs"), join(root, "scripts/audit-gate.mjs"), ...args],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            HOME: join(root, "home"),
            TMPDIR: join(root, "tmp"),
            AUDIT_GATE_TODAY: "2026-10-01",
          },
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** The identity refusal: exit 2, the stderr lines asked for, and no audit report on stdout. */
  function expectIdentityRefusal(res: ReturnType<typeof runGate>, ...lines: string[]) {
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(2);
    for (const line of lines) expect(res.stderr).toContain(line);
    expect(res.stdout).toBe("");
  }

  it("passes when every prefix holds its package and the stand-in npm reports nothing", () => {
    const res = runGate();
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS —");
  }, 12_000);

  for (const input of INPUTS) {
    it(`exits 2 naming ${input.flag} when that mandatory input is absent`, () => {
      const res = runGate({ omit: input.flag });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(`missing ${input.flag} <dir>`);
      expect(res.stderr).toContain(input.pkg);
      expect(res.stdout).toBe("");
    }, 12_000);

    it(`fails the gate on an advisory only the ${input.flag} prefix's stand-in report lists`, () => {
      const res = runGate({ reports: { [input.source]: report() } });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("advisories reported: 1 (1 high)");
      expect(res.stdout).toContain(`HIGH ${GHSA} in hono (<4.0.1) is NOT allowlisted`);
      expect(res.stdout).not.toContain("PASS —");
    }, 12_000);

    it(`allowlists that advisory under the ${input.source} source and not under npm-install`, () => {
      const listed = runGate({ reports: { [input.source]: report() }, entries: [entry([input.source])] });
      expect(listed.error).toBeUndefined();
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain("PASS —");
      const mislabelled = runGate({ reports: { [input.source]: report() }, entries: [entry(["npm-install"])] });
      expect(mislabelled.status).toBe(1);
      expect(mislabelled.stdout).toContain(`observed in [${input.source}]. SOURCES MISMATCH`);
      expect(mislabelled.stdout).not.toContain("PASS —");
    }, 24_000);
  }

  describe("the identity check: each prefix holds its input's package at the packed version", () => {
    const mcp = CONSUMER_INPUTS.find((input) => input.source === "npm-install-mcp")!;

    for (const input of CONSUMER_INPUTS) {
      it(`exits 2 naming ${input.flag} when its prefix holds another package instead of ${input.pkg}`, () => {
        const res = runGate({
          setup: (prefixes) => {
            rmSync(prefixes[input.source]!, { recursive: true, force: true });
            writeInstallRecord(prefixes[input.source]!, "clean-fixture");
          },
        });
        expectIdentityRefusal(
          res,
          `${input.flag} `,
          `is not an npm install of the packed ${input.pkg}@${FIXTURE_VERSION}`,
          `no readable node_modules/${input.pkg}/package.json`,
          "found direct dependencies clean-fixture",
        );
      }, 12_000);
    }

    it("exits 2 when the installed package's version differs from the workspace manifest's", () => {
      const res = runGate({ setup: (prefixes) => writeInstallRecord(prefixes[mcp.source]!, mcp.pkg, "0.9.0") });
      expectIdentityRefusal(
        res,
        `${mcp.flag} `,
        `node_modules/${mcp.pkg}/package.json has version "0.9.0"`,
        'package-lock.json records version "0.9.0"',
      );
    }, 12_000);

    it("exits 2 when package-lock.json resolves the package from the registry, not a local .tgz", () => {
      const res = runGate({
        setup: (prefixes) => {
          const lockPath = join(prefixes[mcp.source]!, "package-lock.json");
          const lock = readJson(lockPath, {});
          lock.packages[`node_modules/${mcp.pkg}`].resolved = "https://registry.npmjs.org/@tpsdev-ai/flair-mcp/-/flair-mcp-1.0.0.tgz";
          writeFileSync(lockPath, JSON.stringify(lock));
        },
      });
      expectIdentityRefusal(res, `${mcp.flag} `, "not a local .tgz");
    }, 12_000);

    /** Rewrites the MCP prefix's file `name` (package.json or package-lock.json) with `edit`. */
    const editMcpFile = (prefixes: Record<string, string>, name: string, edit: (json: Record<string, any>) => void) => {
      const path = join(prefixes[mcp.source]!, name);
      const json = readJson(path, {});
      edit(json);
      writeFileSync(path, JSON.stringify(json));
    };

    for (const flag of ["dev", "optional", "devOptional", "peer", "extraneous"]) {
      it(`exits 2 when package-lock.json marks the package's row "${flag}"`, () => {
        const res = runGate({
          setup: (prefixes) => editMcpFile(prefixes, "package-lock.json", (lock) => {
            lock.packages[`node_modules/${mcp.pkg}`][flag] = true;
          }),
        });
        expectIdentityRefusal(res, `${mcp.flag} `, `package-lock.json marks "node_modules/${mcp.pkg}" "${flag}": true`);
      }, 12_000);
    }

    for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
      it(`exits 2 when the consumer's package.json names the package in ${field} instead of dependencies`, () => {
        const res = runGate({
          setup: (prefixes) => editMcpFile(prefixes, "package.json", (consumer) => {
            consumer[field] = { [mcp.pkg]: consumer.dependencies[mcp.pkg] };
            delete consumer.dependencies[mcp.pkg];
          }),
        });
        expectIdentityRefusal(
          res,
          `${mcp.flag} `,
          'package.json does not name it in "dependencies" from a local .tgz (found null)',
          `package.json also names it in "${field}"`,
        );
      }, 12_000);
    }

    it("exits 2 when the consumer's package.json is missing", () => {
      const res = runGate({ setup: (prefixes) => rmSync(join(prefixes[mcp.source]!, "package.json")) });
      expectIdentityRefusal(res, `${mcp.flag} `, "no readable package.json");
    }, 12_000);

    it("exits 2 when package-lock.json's root row names the package with a registry spec", () => {
      const res = runGate({
        setup: (prefixes) => editMcpFile(prefixes, "package-lock.json", (lock) => {
          lock.packages[""].dependencies[mcp.pkg] = FIXTURE_VERSION;
        }),
      });
      expectIdentityRefusal(
        res,
        `${mcp.flag} `,
        `package-lock.json's "" row does not name it in "dependencies" from a local .tgz (found "${FIXTURE_VERSION}")`,
      );
    }, 12_000);

    it("exits 2 naming each dependency the installed manifest or the lock row declares differently from the workspace manifest", () => {
      const declared = { zod: "4.3.6", "@tpsdev-ai/flair-client": "1.0.0" };
      const installed = runGate({
        setup: (prefixes, root) => {
          declareDependencies(root, mcp, prefixes[mcp.source]!, declared);
          const path = join(prefixes[mcp.source]!, "node_modules", mcp.pkg, "package.json");
          writeFileSync(path, JSON.stringify({ ...readJson(path, {}), dependencies: { zod: "3.0.0", other: "1.0.0" } }));
        },
      });
      expectIdentityRefusal(
        installed,
        `${mcp.flag} `,
        `node_modules/${mcp.pkg}/package.json declares dependencies that differ from ${mcp.dir}/package.json: ` +
          'zod is "3.0.0" (expected "4.3.6"), @tpsdev-ai/flair-client is missing (expected "1.0.0"), other "1.0.0" is not in the workspace manifest',
      );
      expect(installed.stderr).not.toContain(`"node_modules/${mcp.pkg}" row declares`);
      const row = runGate({
        setup: (prefixes, root) => {
          declareDependencies(root, mcp, prefixes[mcp.source]!, declared);
          editMcpFile(prefixes, "package-lock.json", (lock) => {
            delete lock.packages[`node_modules/${mcp.pkg}`].dependencies;
          });
        },
      });
      expectIdentityRefusal(
        row,
        `${mcp.flag} `,
        `package-lock.json's "node_modules/${mcp.pkg}" row declares dependencies that differ from ${mcp.dir}/package.json: ` +
          'zod is missing (expected "4.3.6"), @tpsdev-ai/flair-client is missing (expected "1.0.0")',
      );
      expect(row.stderr).not.toContain(`node_modules/${mcp.pkg}/package.json declares`);
    }, 24_000);

    for (const [name, contents] of [["missing", null], ["unparseable", "{invalid"]] as const) {
      it(`exits 2 when the prefix's package-lock.json is ${name}`, () => {
        const res = runGate({
          setup: (prefixes) => {
            const lockPath = join(prefixes[mcp.source]!, "package-lock.json");
            if (contents === null) rmSync(lockPath);
            else writeFileSync(lockPath, contents);
          },
        });
        expectIdentityRefusal(res, `${mcp.flag} `, "no readable package-lock.json");
      }, 12_000);
    }

    it("exits 2 when two flags name the same prefix", () => {
      const res = runGate({ reuse: { "--pi-npm-install-prefix": mcp.source } });
      expectIdentityRefusal(res, "--mcp-npm-install-prefix and --pi-npm-install-prefix name the same prefix");
    }, 12_000);

    it("exits 2 when the workspace manifest the job packs names another package or is missing", () => {
      const renamed = runGate({
        setup: (_prefixes, root) =>
          writeFileSync(join(root, mcp.dir, "package.json"), JSON.stringify({ name: "other", version: FIXTURE_VERSION })),
      });
      expectIdentityRefusal(
        renamed,
        `the workspace manifest ${mcp.dir}/package.json names "other", expected ${mcp.pkg}`,
      );
      const missing = runGate({ setup: (_prefixes, root) => rmSync(join(root, mcp.dir, "package.json")) });
      expectIdentityRefusal(
        missing,
        `cannot read the workspace manifest ${mcp.dir}/package.json the job packs for ${mcp.flag}`,
      );
    }, 24_000);
  });

  describe("a vendor-pinned entry on one of these sources", () => {
    const vendorEntry = (introducedBy = "@tpsdev-ai/flair-mcp -> @modelcontextprotocol/sdk -> hono") =>
      entry(["npm-install-mcp"], { class: "vendor-pinned", version: "4.0.0", introducedBy });
    const installChain = (prefixes: Record<string, string>, root: string) => {
      const rows: [string, object][] = [
        ["node_modules/@tpsdev-ai/flair-mcp", {
          name: "@tpsdev-ai/flair-mcp", version: FIXTURE_VERSION, dependencies: { "@modelcontextprotocol/sdk": "1.0.0" },
        }],
        ["node_modules/@modelcontextprotocol/sdk", {
          name: "@modelcontextprotocol/sdk", version: "1.0.0", dependencies: { hono: "4.0.0" },
        }],
        ["node_modules/hono", { name: "hono", version: "4.0.0" }],
      ];
      for (const [node, manifest] of rows) {
        mkdirSync(join(prefixes["npm-install-mcp"]!, node), { recursive: true });
        writeFileSync(join(prefixes["npm-install-mcp"]!, node, "package.json"), JSON.stringify(manifest));
      }
      const mcp = CONSUMER_INPUTS.find((input) => input.source === "npm-install-mcp")!;
      declareDependencies(root, mcp, prefixes["npm-install-mcp"]!, { "@modelcontextprotocol/sdk": "1.0.0" });
    };

    it("passes when its chain resolves to the reported node at the entry's version", () => {
      const res = runGate({ reports: { "npm-install-mcp": report() }, entries: [vendorEntry()], setup: installChain });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("PASS —");
    }, 12_000);

    it("blocks a reported node outside its chain", () => {
      const outside = "node_modules/other/node_modules/hono";
      const res = runGate({
        reports: { "npm-install-mcp": report(["node_modules/hono", outside]) },
        entries: [vendorEntry()],
        setup: installChain,
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(`node "${outside}" is outside the dependency chain`);
      expect(res.stdout).not.toContain("PASS —");
    }, 12_000);

    it("prints the single-chain consumer diagnostics byte for byte", () => {
      // Captured at 49f24987, before an advisory could carry several entries.
      const golden = {
        "outside": {
          "status": 1,
          "lines": [
            "::error::audit-gate: GHSA-0000-0000-2757 (hono): node \"node_modules/other/node_modules/hono\" is outside the dependency chain @tpsdev-ai/flair-mcp -> @modelcontextprotocol/sdk -> hono (resolved node node_modules/hono).",
            "    - GHSA-0000-0000-2757 (hono): node \"node_modules/other/node_modules/hono\" is outside the dependency chain @tpsdev-ai/flair-mcp -> @modelcontextprotocol/sdk -> hono (resolved node node_modules/hono)."
          ]
        },
        "wrongRoot": {
          "status": 1,
          "lines": [
            "::error::audit-gate: GHSA-0000-0000-2757 (hono): cannot verify @tpsdev-ai/flair-mcp dependency chain: invalid @tpsdev-ai/flair-mcp dependency chain.",
            "    - GHSA-0000-0000-2757 (hono): cannot verify @tpsdev-ai/flair-mcp dependency chain: invalid @tpsdev-ai/flair-mcp dependency chain."
          ]
        }
      };
      const diag = (out: string) => out.split("\n").filter((l) => l.startsWith("::error::") || l.startsWith("    - "));
      const outside = runGate({
        reports: { "npm-install-mcp": report(["node_modules/hono", "node_modules/other/node_modules/hono"]) },
        entries: [vendorEntry()],
        setup: installChain,
      });
      const wrongRoot = runGate({
        reports: { "npm-install-mcp": report() },
        entries: [vendorEntry("@tpsdev-ai/pi-flair -> @modelcontextprotocol/sdk -> hono")],
        setup: installChain,
      });
      expect({
        outside: { status: outside.status, lines: diag(outside.stdout) },
        wrongRoot: { status: wrongRoot.status, lines: diag(wrongRoot.stdout) },
      }).toEqual(golden);
    }, 24_000);

    it("blocks a chain that does not start at the observed package", () => {
      const res = runGate({
        reports: { "npm-install-mcp": report() },
        entries: [vendorEntry("@tpsdev-ai/pi-flair -> @modelcontextprotocol/sdk -> hono")],
        setup: installChain,
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("invalid @tpsdev-ai/flair-mcp dependency chain");
      expect(res.stdout).not.toContain("PASS —");
    }, 12_000);
  });
});

// ─── Vendor-pinned entries cover their npm-audit-reported nodes ──────────────

describe("vendor-pinned npm-install nodes", () => {
  const harperNode = "node_modules/harper/node_modules/fastify";
  const hoistedNode = "node_modules/fastify";
  const advisory = (nodes: string[], nodeVersions = {}) => ({
    ghsa: "GHSA-w2qp-rph6-63g4", package: "fastify", nodes, nodeVersions,
  });

  function withInstalledHarper(run: (prefix: string) => void, node = harperNode) {
    const prefix = mkdtempSync(join(tmpdir(), "flair-audit-nodes-"));
    try {
      const harperRoot = node.slice(0, node.indexOf("node_modules/harper/") + "node_modules/harper".length);
      mkdirSync(join(prefix, node), { recursive: true });
      writeFileSync(join(prefix, harperRoot, "npm-shrinkwrap.json"), JSON.stringify({
        packages: { "node_modules/fastify": { version: "5.11.3" } },
      }));
      writeFileSync(join(prefix, node, "package.json"), JSON.stringify({ version: "5.11.3" }));
      run(prefix);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  }

  it("allows an advisory whose nodes are all under harper with matching pins", () => {
    withInstalledHarper((prefix) => {
      expect(vendorPinnedNodeProblems(advisory([harperNode]), prefix)).toEqual([]);
    });
  });

  it("allows harper nested below the packed Flair package", () => {
    const nestedNode = "node_modules/@tpsdev-ai/flair/node_modules/harper/node_modules/fastify";
    withInstalledHarper((prefix) => {
      expect(vendorPinnedNodeProblems(advisory([nestedNode]), prefix)).toEqual([]);
    }, nestedNode);
  });

  it("blocks and names a hoisted node even when the same advisory has a harper node", () => {
    withInstalledHarper((prefix) => {
      const problems = vendorPinnedNodeProblems(advisory([harperNode, hoistedNode]), prefix);
      expect(problems.join("\n")).toContain(hoistedNode);
      expect(problems.join("\n")).toContain("extend the allowlist schema and add a separate, justified entry scoped to that node");
    });
  });

  it("blocks a node whose installed version differs from harper's shrinkwrap pin", () => {
    withInstalledHarper((prefix) => {
      writeFileSync(join(prefix, harperNode, "package.json"), JSON.stringify({ version: "5.12.0" }));
      expect(vendorPinnedNodeProblems(advisory([harperNode]), prefix).join("\n")).toContain(
        "installed version 5.12.0",
      );
    });
  });

  it("blocks a version supplied by audit data that differs from harper's pin", () => {
    withInstalledHarper((prefix) => {
      const problems = vendorPinnedNodeProblems(advisory([harperNode], { [harperNode]: "5.12.0" }), prefix);
      expect(problems.join("\n")).toContain("audit version 5.12.0");
    });
  });

  it("refuses an empty version supplied by audit data", () => {
    withInstalledHarper((prefix) => {
      const problems = vendorPinnedNodeProblems(advisory([harperNode], { [harperNode]: "" }), prefix);
      expect(problems.join("\n")).toContain("missing or invalid version");
    });
  });

  it("refuses empty node evidence and an unreadable shrinkwrap", () => {
    withInstalledHarper((prefix) => {
      expect(vendorPinnedNodeProblems(advisory([]), prefix).join("\n")).toContain("reported no nodes");
      rmSync(join(prefix, "node_modules/harper/npm-shrinkwrap.json"));
      const problems = vendorPinnedNodeProblems(advisory([harperNode]), prefix).join("\n");
      expect(problems).toContain("Without npm-shrinkwrap.json in harper, restore a readable installed package.json, a consumer package-lock that marks the node inBundle");
      expect(problems).not.toContain("shrinkwrap evidence");
    });
  });

  it("refuses a shrinkwrap whose package rows cannot be parsed", () => {
    withInstalledHarper((prefix) => {
      writeFileSync(join(prefix, "node_modules/harper/npm-shrinkwrap.json"), "{invalid");
      const problems = vendorPinnedNodeProblems(advisory([harperNode]), prefix).join("\n");
      expect(problems).toContain("Restore readable package and shrinkwrap evidence, then rerun the gate.");
      expect(problems).not.toContain("inBundle");
    });
  });

  it("refuses a missing installed package version", () => {
    withInstalledHarper((prefix) => {
      writeFileSync(join(prefix, harperNode, "package.json"), "{}");
      expect(vendorPinnedNodeProblems(advisory([harperNode]), prefix).join("\n")).toContain(
        "missing or invalid version",
      );
    });
  });

  function runFixtureGate(nodes: string[], installedVersion = "5.11.3", adk = false,
    adkVersions: { installed?: string | null; reported?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-gate-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, ".github"));
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "tmp"));
      // The prefix the stand-in npm reports the advisory in.
      const tree = join(root, "tree");
      mkdirSync(join(tree, harperNode), { recursive: true });
      writeFileSync(join(tree, "node_modules/harper/npm-shrinkwrap.json"), JSON.stringify({
        packages: { "node_modules/fastify": { version: "5.11.3" } },
      }));
      writeFileSync(join(tree, harperNode, "package.json"), JSON.stringify({ version: installedVersion }));
      writeFileSync(join(root, "scripts/audit-gate.mjs"), readFileSync(join(REPO_ROOT, "scripts/audit-gate.mjs")));
      writeFileSync(join(root, ".github/audit-allowlist.json"), JSON.stringify({
        policy: ALLOWLIST.policy,
        entries: [adk ? {
          ...ALLOWLIST.entries.find((entry: { package: string }) => entry.package === "uuid"),
          added: "2026-09-03",
        } : {
          ghsa: "GHSA-w2qp-rph6-63g4",
          package: "fastify",
          severity: "moderate",
          class: "vendor-pinned",
          sources: ["npm-install"],
          approvedBy: "fixture",
          introducedBy: "harper -> fastify",
          reason: "Fixture pin in harper's shrinkwrap.",
          added: "2026-09-03",
          expires: "2027-03-02",
          removeWhen: "harper's shrinkwrap resolves fastify >=5.12.1",
        }],
      }));
      commitAllowlistHistory(root);
      writeFileSync(join(root, "bin/bun"), "#!/bin/sh\nprintf '{}\\n'\n");
      const chain = ["@tpsdev-ai/adk-flair", "@google/adk", "@google-cloud/vertexai", "google-auth-library", "gaxios", "uuid"];
      let parent = tree;
      for (const [i, pkg] of chain.entries()) {
        parent = join(parent, "node_modules", pkg);
        mkdirSync(parent, { recursive: true });
        writeFileSync(join(parent, "package.json"), JSON.stringify({
          name: pkg, version: pkg === "uuid" ? (adkVersions.installed === null ? undefined : adkVersions.installed ?? "9.0.1") : "1.0.0",
          dependencies: i + 1 < chain.length ? { [chain[i + 1]!]: "*" } : {},
        }));
      }
      const report = {
        ...(adkVersions.reported === undefined ? {} : { packages: Object.fromEntries(
          nodes.map((node) => [node, { version: adkVersions.reported }]),
        ) }),
        vulnerabilities: { [adk ? "uuid" : "fastify"]: { nodes, via: [{
        url: `https://github.com/advisories/${adk ? "GHSA-w5hq-g745-h8pq" : "GHSA-w2qp-rph6-63g4"}`,
        severity: "moderate", range: adk ? "<11.1.1" : "<5.12.1",
      }] } } };
      const empty = JSON.stringify({ vulnerabilities: {} });
      mkdirSync(join(root, "adk-prefix"));
      // The root and ADK inputs share these two directories (which one gets
      // the report depends on `adk`); every other input gets a clean-* prefix.
      const prefixOf = (source: string) =>
        source === "npm-install" ? (adk ? join(root, "adk-prefix") : tree)
          : source === "npm-install-adk" ? (adk ? tree : join(root, "adk-prefix"))
            : join(root, `clean-${source}`);
      writeIdentities(root, prefixOf);
      if (adk) {
        const adkInput = CONSUMER_INPUTS.find((input) => input.source === "npm-install-adk")!;
        declareDependencies(root, adkInput, tree, { [chain[1]!]: "*" });
      }
      writeFileSync(join(root, "bin/npm"), `#!/bin/sh
case "$PWD" in
  */adk-prefix|*/clean-*) printf '%s\\n' '${empty}' ;;
  *) printf '%s\\n' '${JSON.stringify(report)}' ;;
esac
`);
      chmodSync(join(root, "bin/bun"), 0o755);
      chmodSync(join(root, "bin/npm"), 0o755);
      writeFileSync(join(root, "offline.mjs"), "globalThis.fetch = async () => { throw new Error('fixture offline'); };\n");
      const snapshot = () => readdirSync(root, { recursive: true }).sort().map((name) => {
        const path = join(root, name);
        return [name, statSync(path).isFile() ? readFileSync(path).toString("base64") : "<dir>"];
      });
      const before = snapshot();
      const res = spawnSync(process.execPath, ["--import", join(root, "offline.mjs"), join(root, "scripts/audit-gate.mjs"), ...prefixArgs(prefixOf)], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), AUDIT_GATE_TODAY: "2026-10-01",
          // bun caches its transpilation of a large script under HOME, which the snapshot covers; "0" turns that cache off.
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      });
      return { res, wrote: JSON.stringify(snapshot()) !== JSON.stringify(before) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const adkUuidNode = "node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid";

  it("passes an ADK-source uuid advisory with matching installed, allowlist and reported versions", () => {
    const { res, wrote } = runFixtureGate([adkUuidNode], "5.11.3", true, { reported: "9.0.1" });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS —");
    expect(wrote).toBe(false);
  }, 12_000);

  for (const refusal of [
    { name: "missing installed version", installed: null, reported: undefined, error: "missing or invalid installed version" },
    { name: "different installed version", installed: "9.0.2", reported: undefined, error: "installed version 9.0.2 differs from allowlist version 9.0.1" },
    { name: "conflicting audit version", installed: "9.0.1", reported: "9.0.2", error: 'audit version "9.0.2" conflicts with installed version 9.0.1' },
  ]) {
    it(`blocks an ADK-source uuid advisory with ${refusal.name}`, () => {
      const { res, wrote } = runFixtureGate([adkUuidNode], "5.11.3", true, refusal);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(adkUuidNode);
      expect(res.stdout).toContain(refusal.error);
      expect(res.stdout).not.toContain("PASS —");
      expect(wrote).toBe(false);
    }, 12_000);
  }

  it("blocks an ADK-source uuid advisory outside the named chain", () => {
    const outside = "node_modules/other/node_modules/uuid";
    const { res, wrote } = runFixtureGate([outside], "5.11.3", true);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(outside);
    expect(res.stdout).toContain("outside the dependency chain");
    expect(res.stdout).not.toContain("PASS —");
    expect(wrote).toBe(false);
  }, 12_000);

  it("blocks an ADK-source uuid advisory with a path outside the named chain", () => {
    const { res } = runFixtureGate([adkUuidNode, "node_modules/uuid"], "5.11.3", true);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("outside the dependency chain");
  }, 12_000);

  // The single-chain ADK diagnostics, byte for byte, as the gate printed them
  // before an advisory could carry several entries (captured at 49f24987).
  const SINGLE_CHAIN_ADK_GOLDEN: Record<string, { status: number; lines: string[] }> = {
    "outside": {
      "status": 1,
      "lines": [
        "::error::audit-gate: GHSA-w5hq-g745-h8pq (uuid): node \"node_modules/other/node_modules/uuid\" is outside the dependency chain @tpsdev-ai/adk-flair -> @google/adk -> @google-cloud/vertexai -> google-auth-library -> gaxios -> uuid (resolved node node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid).",
        "    - GHSA-w5hq-g745-h8pq (uuid): node \"node_modules/other/node_modules/uuid\" is outside the dependency chain @tpsdev-ai/adk-flair -> @google/adk -> @google-cloud/vertexai -> google-auth-library -> gaxios -> uuid (resolved node node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid)."
      ]
    },
    "additional": {
      "status": 1,
      "lines": [
        "::error::audit-gate: GHSA-w5hq-g745-h8pq (uuid): node \"node_modules/uuid\" is outside the dependency chain @tpsdev-ai/adk-flair -> @google/adk -> @google-cloud/vertexai -> google-auth-library -> gaxios -> uuid (resolved node node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid).",
        "    - GHSA-w5hq-g745-h8pq (uuid): node \"node_modules/uuid\" is outside the dependency chain @tpsdev-ai/adk-flair -> @google/adk -> @google-cloud/vertexai -> google-auth-library -> gaxios -> uuid (resolved node node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid)."
      ]
    },
    "missing": {
      "status": 1,
      "lines": [
        "::error::audit-gate: GHSA-w5hq-g745-h8pq (uuid): cannot verify @tpsdev-ai/adk-flair node \"node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid\" version: missing or invalid installed version.",
        "    - GHSA-w5hq-g745-h8pq (uuid): cannot verify @tpsdev-ai/adk-flair node \"node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid\" version: missing or invalid installed version."
      ]
    },
    "different": {
      "status": 1,
      "lines": [
        "::error::audit-gate: GHSA-w5hq-g745-h8pq (uuid): cannot verify @tpsdev-ai/adk-flair node \"node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid\" version: installed version 9.0.2 differs from allowlist version 9.0.1.",
        "    - GHSA-w5hq-g745-h8pq (uuid): cannot verify @tpsdev-ai/adk-flair node \"node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid\" version: installed version 9.0.2 differs from allowlist version 9.0.1."
      ]
    },
    "conflicting": {
      "status": 1,
      "lines": [
        "::error::audit-gate: GHSA-w5hq-g745-h8pq (uuid): cannot verify @tpsdev-ai/adk-flair node \"node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid\" version: audit version \"9.0.2\" conflicts with installed version 9.0.1.",
        "    - GHSA-w5hq-g745-h8pq (uuid): cannot verify @tpsdev-ai/adk-flair node \"node_modules/@tpsdev-ai/adk-flair/node_modules/@google/adk/node_modules/@google-cloud/vertexai/node_modules/google-auth-library/node_modules/gaxios/node_modules/uuid\" version: audit version \"9.0.2\" conflicts with installed version 9.0.1."
      ]
    }
  };

  for (const [name, nodes, versions] of [
    ["outside", ["node_modules/other/node_modules/uuid"], {}],
    ["additional", [adkUuidNode, "node_modules/uuid"], {}],
    ["missing", [adkUuidNode], { installed: null }],
    ["different", [adkUuidNode], { installed: "9.0.2" }],
    ["conflicting", [adkUuidNode], { installed: "9.0.1", reported: "9.0.2" }],
  ] as const) {
    it(`prints the single-chain ADK diagnostics byte for byte: ${name}`, () => {
      const { res } = runFixtureGate([...nodes], "5.11.3", true, versions as { installed?: string | null; reported?: string });
      const lines = res.stdout.split("\n").filter((l) => l.startsWith("::error::") || l.startsWith("    - "));
      expect({ status: res.status, lines }).toEqual(SINGLE_CHAIN_ADK_GOLDEN[name]!);
    }, 12_000);
  }

  it("passes the gate for a harper-only node", () => {
    const { res, wrote } = runFixtureGate([harperNode]);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS —");
    expect(res.stdout).toContain("NOT-REPORTED-BY-BUN: GHSA-w2qp-rph6-63g4 fastify — npm reports it under harper; retire when ");
    expect(wrote).toBe(false);
  }, 12_000);

  it("blocks a mixed-node advisory in the gate and names the hoisted node", () => {
    const { res, wrote } = runFixtureGate([harperNode, hoistedNode]);
    expect(res.error).toBeUndefined();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(hoistedNode);
    expect(res.stdout).not.toContain("NOT-REPORTED-BY-BUN");
    expect(res.stdout).not.toContain("PASS —");
    expect(wrote).toBe(false);
  }, 12_000);

  it("does not print a blocked pin mismatch as NOT-REPORTED-BY-BUN", () => {
    const { res } = runFixtureGate([harperNode], "5.12.0");
    expect(res.error).toBeUndefined();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("installed version 5.12.0");
    expect(res.stdout).not.toContain("NOT-REPORTED-BY-BUN");
  }, 12_000);

  it("refuses unknown node evidence with a nonzero gate exit and no success output or writes", () => {
    const { res, wrote } = runFixtureGate([]);
    expect(res.error).toBeUndefined();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("reported no nodes");
    expect(res.stdout).toContain("Inspect the npm-install audit report");
    expect(res.stdout).not.toContain("PASS —");
    expect(wrote).toBe(false);
  }, 12_000);
});

// ─── Several entries for one advisory: per source, per location ──────────────

describe("several allowlist entries for one advisory, per source and per location", () => {
  const UUID = "GHSA-w5hq-g745-h8pq";
  const GLOB = "GHSA-3g3m-2fjr-6pw4";
  const MINIMATCH = "GHSA-g3hv-75wg-m249";
  const VERTEXAI = ["@tpsdev-ai/adk-flair", "@google/adk", "@google-cloud/vertexai", "google-auth-library", "gaxios", "uuid"].join(" -> ");
  const GTOKEN = ["@tpsdev-ai/adk-flair", "@google/adk", "@google-cloud/vertexai", "google-auth-library", "gtoken", "gaxios", "uuid"].join(" -> ");
  const ADK_GLOB = ["@tpsdev-ai/adk-flair", "@google/adk", "@google-cloud/aiplatform", "google-gax", "rimraf", "glob"].join(" -> ");
  const VERTEXAI_NODE = "node_modules/@google-cloud/vertexai/node_modules/uuid";
  const GTOKEN_NODE = "node_modules/gtoken/node_modules/uuid";
  const RANGES: Record<string, string> = { uuid: "<11.1.1", glob: ">=9.0.0 <=14.0.1", minimatch: "<11.0.1" };
  const GHSAS: Record<string, string> = { uuid: UUID, glob: GLOB, minimatch: MINIMATCH };

  const entry = (ghsa: string, pkg: string, cls: string, sources: string[], introducedBy: string, extra: Record<string, unknown> = {}) => ({
    ghsa, package: pkg, severity: "moderate", class: cls, sources, approvedBy: "fixture", introducedBy,
    reason: "Fixture entry.", added: "2026-09-30", expires: "2026-10-14", removeWhen: "the fixture tree resolves a patched copy",
    ...extra,
  });
  const uuidEntry = (introducedBy: string, extra: Record<string, unknown> = {}) =>
    entry(UUID, "uuid", "vendor-pinned", ["npm-install-adk"], introducedBy, { version: "9.0.1", ...extra });
  const TWO_UUID = [uuidEntry(VERTEXAI), uuidEntry(GTOKEN)];

  /** A bun report listing `pkgs`, in `bun audit --json`'s shape. */
  const bunReport = (pkgs: string[]) => Object.fromEntries(pkgs.map((pkg) => [pkg, [{
    id: 1, url: `https://github.com/advisories/${GHSAS[pkg]}`, title: `Fixture ${pkg} advisory`, severity: "moderate",
    vulnerable_versions: RANGES[pkg],
  }]]));
  /** An npm report listing each package at its nodes, in `npm audit --json`'s shape. */
  const npmReport = (nodesByPkg: Record<string, string[]>) => ({
    vulnerabilities: Object.fromEntries(Object.entries(nodesByPkg).map(([pkg, nodes]) => [pkg, { nodes, via: [{
      url: `https://github.com/advisories/${GHSAS[pkg]}`, title: `Fixture ${pkg} advisory`, severity: "moderate", range: RANGES[pkg],
    }] }])),
  });

  /** Writes package.json for each `[node, manifest]` row under `prefix`. */
  const writeTree = (prefix: string, rows: [string, Record<string, unknown>][]) => {
    for (const [node, manifest] of rows) {
      mkdirSync(join(prefix, node), { recursive: true });
      writeFileSync(join(prefix, node, "package.json"), JSON.stringify(manifest));
    }
  };
  const pkg = (name: string, version: string, deps: string[] = []) =>
    ({ name, version, dependencies: Object.fromEntries(deps.map((d) => [d, "*"])) });

  /**
   * The real gate in a fixture repo with stand-in tools. The ADK prefix holds
   * @google/adk's two uuid 9.0.1 copies (under @google-cloud/vertexai and under
   * gtoken), a uuid 11.1.1 at the top that no report names, and the
   * aiplatform -> google-gax -> rimraf -> glob 10.5.0 -> minimatch 9.0.9 path.
   * The root prefix holds harper's shrinkwrap-pinned glob 13.0.6 and minimatch
   * 10.2.4. `bun` prints `bun`; `npm` prints `npm[source]` in that source's
   * prefix and an empty report elsewhere.
   */
  function runMulti(opts: { entries: object[]; bun?: object; npm?: Record<string, object>; today?: string; history?: "full" | "none" | "unreadable" }) {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-multi-"));
    try {
      for (const dir of ["scripts", ".github", "bin", "home", "tmp"]) mkdirSync(join(root, dir));
      writeFileSync(join(root, "scripts/audit-gate.mjs"), readFileSync(join(REPO_ROOT, "scripts/audit-gate.mjs")));
      writeFileSync(join(root, ".github/audit-allowlist.json"), JSON.stringify({ policy: ALLOWLIST.policy, entries: opts.entries }));
      if (opts.history !== "none") commitAllowlistHistory(root);
      if (opts.history === "unreadable") {
        rmSync(join(root, ".github/audit-allowlist.json"));
        symlinkSync(join(root, ".github/missing.json"), join(root, ".github/audit-allowlist.json"));
      }
      const prefixes: Record<string, string> = Object.fromEntries(
        CONSUMER_INPUTS.map(({ source }) => [source, join(root, `prefix-${source}`)]),
      );
      writeIdentities(root, (source) => prefixes[source]!);
      const adk = prefixes["npm-install-adk"]!;
      writeTree(adk, [
        ["node_modules/@google/adk", pkg("@google/adk", "2.4.0", ["@google-cloud/vertexai", "@google-cloud/aiplatform", "@a2a-js/sdk"])],
        ["node_modules/@google-cloud/vertexai", pkg("@google-cloud/vertexai", "1.12.0", ["google-auth-library"])],
        ["node_modules/@google-cloud/vertexai/node_modules/google-auth-library", pkg("google-auth-library", "9.15.1", ["gaxios", "gtoken"])],
        ["node_modules/@google-cloud/vertexai/node_modules/gaxios", pkg("gaxios", "6.7.1", ["uuid"])],
        ["node_modules/@google-cloud/vertexai/node_modules/uuid", pkg("uuid", "9.0.1")],
        ["node_modules/gtoken", pkg("gtoken", "7.1.0", ["gaxios"])],
        ["node_modules/gtoken/node_modules/gaxios", pkg("gaxios", "6.7.1", ["uuid"])],
        ["node_modules/gtoken/node_modules/uuid", pkg("uuid", "9.0.1")],
        ["node_modules/@a2a-js/sdk", pkg("@a2a-js/sdk", "0.3.14", ["uuid"])],
        ["node_modules/uuid", pkg("uuid", "11.1.1")],
        ["node_modules/@google-cloud/aiplatform", pkg("@google-cloud/aiplatform", "6.11.0", ["google-gax"])],
        ["node_modules/google-gax", pkg("google-gax", "5.0.8", ["rimraf"])],
        ["node_modules/rimraf", pkg("rimraf", "5.0.10", ["glob"])],
        ["node_modules/glob", pkg("glob", "10.5.0", ["minimatch"])],
        ["node_modules/minimatch", pkg("minimatch", "9.0.9")],
      ]);
      const adkInput = CONSUMER_INPUTS.find((input) => input.source === "npm-install-adk")!;
      declareDependencies(root, adkInput, adk, { "@google/adk": "*" });
      const rootPrefix = prefixes["npm-install"]!;
      writeTree(rootPrefix, [
        ["node_modules/harper/node_modules/glob", { name: "glob", version: "13.0.6" }],
        ["node_modules/harper/node_modules/minimatch", { name: "minimatch", version: "10.2.4" }],
      ]);
      writeFileSync(join(rootPrefix, "node_modules/harper/npm-shrinkwrap.json"), JSON.stringify({
        packages: { "node_modules/glob": { version: "13.0.6" }, "node_modules/minimatch": { version: "10.2.4" } },
      }));
      const empty = JSON.stringify({ vulnerabilities: {} });
      const cases = Object.entries(opts.npm ?? {})
        .map(([source, body]) => `  */prefix-${source}) printf '%s\\n' '${JSON.stringify(body)}' ;;\n`)
        .join("");
      writeFileSync(join(root, "bin/npm"), `#!/bin/sh\ncase "$PWD" in\n${cases}  *) printf '%s\\n' '${empty}' ;;\nesac\n`);
      writeFileSync(join(root, "bin/bun"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(opts.bun ?? {})}'\n`);
      chmodSync(join(root, "bin/npm"), 0o755);
      chmodSync(join(root, "bin/bun"), 0o755);
      writeFileSync(join(root, "offline.mjs"), "globalThis.fetch = async () => { throw new Error('fixture offline'); };\n");
      return spawnSync(
        process.execPath,
        ["--import", join(root, "offline.mjs"), join(root, "scripts/audit-gate.mjs"), ...prefixArgs((source) => prefixes[source]!)],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            HOME: join(root, "home"),
            TMPDIR: join(root, "tmp"),
            AUDIT_GATE_TODAY: opts.today ?? "2026-10-01",
          },
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const uuidAt = (...nodes: string[]) => ({ "npm-install-adk": npmReport({ uuid: nodes }) });
  const expectPass = (res: ReturnType<typeof runMulti>) => {
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS —");
  };
  const expectBlocked = (res: ReturnType<typeof runMulti>, ...lines: string[]) => {
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    for (const line of lines) expect(res.stdout).toContain(line);
    expect(res.stdout).not.toContain("PASS —");
  };

  it("two_adk_uuid_chains_pass: one entry per uuid copy covers both ADK nodes", () => {
    const res = runMulti({ entries: TWO_UUID, npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE) });
    expectPass(res);
    expect(res.stdout).toContain("advisories reported: 1 (1 moderate)");
    expect(res.stdout).toContain("allowlisted (justified + dated):  1");
  }, 12_000);

  it("extra_uncovered_uuid_node: a third reported uuid copy is covered by no entry", () => {
    const res = runMulti({ entries: TWO_UUID, npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE, "node_modules/uuid") });
    expectBlocked(res, `${UUID} (uuid): node "node_modules/uuid" in npm-install-adk is covered by no allowlist entry`);
  }, 12_000);

  it("refuses an empty ADK chain beside a valid sibling before matching", () => {
    const res = runMulti({ entries: [uuidEntry(VERTEXAI), uuidEntry("")], npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE) });
    expectBlocked(res, 'missing required field "introducedBy"');
    expect(res.stdout).not.toContain("allowlisted (justified + dated)");
  }, 12_000);

  for (const [name, introducedBy, refusal] of [
    ["prefix-only", "@tpsdev-ai/adk-flair -> @google/adk", "invalid @tpsdev-ai/adk-flair dependency chain"],
    ["broken-edge", "@tpsdev-ai/adk-flair -> @google/adk -> gtoken -> gaxios -> uuid", "@google/adk does not depend on gtoken"],
    ["wrong-copy", "@tpsdev-ai/adk-flair -> @google/adk -> @a2a-js/sdk -> uuid", "is STALE — it covers no reported advisory location"],
  ] as const) {
    it(`refuses the ${name} ADK chain beside a valid sibling, and leaves the gtoken copy uncovered`, () => {
      const res = runMulti({ entries: [uuidEntry(VERTEXAI), uuidEntry(introducedBy)], npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE) });
      expectBlocked(res, refusal, `node "${GTOKEN_NODE}" in npm-install-adk is covered by no allowlist entry`);
    }, 12_000);
  }

  it("stale_chain_with_live_sibling: an entry whose node is not reported is stale though its sibling covers the GHSA", () => {
    const res = runMulti({ entries: TWO_UUID, npm: uuidAt(VERTEXAI_NODE) });
    expectBlocked(res, `allowlist entry[1] (${UUID} / uuid, sources [npm-install-adk], via ${GTOKEN}) is STALE`);
    expect(res.stdout).not.toContain("NOT allowlisted");
  }, 12_000);

  it("reports a non-array sources value beside a sibling entry instead of crashing", () => {
    // The gate stops before matching, so no later diagnostic names this entry.
    const res = runMulti({
      entries: [uuidEntry(VERTEXAI), uuidEntry(GTOKEN, { sources: "npm-install-adk" })],
      npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE),
    });
    expectBlocked(res, `entry[1] (${UUID} / uuid): "sources" must be a non-empty array`);
    expect(res.stderr).not.toContain("audit-gate crashed");
    expect(res.stdout).not.toContain("allowlisted (justified + dated)");
  }, 12_000);

  it("refuses a required field that is not a string, and does not admit the advisory", () => {
    // String({}) is "[object Object]", so a presence check alone let an object
    // through, and the bun admission path never reads introducedBy.
    const objectChain = entry(GLOB, "glob", "remediation-available", ["bun"], "harper -> @fastify/static -> glob", { introducedBy: {} });
    expect(validateAllowlist({ policy: ALLOWLIST.policy, entries: [objectChain] }, new Date("2026-10-01")).join("\n"))
      .toContain('"introducedBy" must be a string (found object)');
    const res = runMulti({ entries: [objectChain], bun: bunReport(["glob"]) });
    expectBlocked(res, '"introducedBy" must be a string (found object)');
    expect(res.stdout).not.toContain("allowlisted (justified + dated)");
  }, 12_000);

  it("refuses an array-valued class before matching", () => {
    // The gate stops before matching, so this entry is never counted as allowlisted.
    const arrayClass = entry(GLOB, "glob", "remediation-available", ["bun"], "harper -> @fastify/static -> glob", { class: ["remediation-available"] });
    const res = runMulti({ entries: [arrayClass], bun: bunReport(["glob"]) });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('"class" must be a string (found an array)');
    expect(res.stderr).not.toContain("audit-gate crashed");
    expect(res.stdout).not.toContain("allowlisted (justified + dated)");
  }, 12_000);

  it("refuses vendor-pinned on the bun source and accepts remediation-available there", () => {
    const vendor = entry(GLOB, "glob", "vendor-pinned", ["bun"], "harper -> @fastify/static -> glob");
    expect(validateAllowlist({ policy: ALLOWLIST.policy, entries: [vendor] }, new Date("2026-10-01")).join("\n"))
      .toContain('class "vendor-pinned" cannot cover source "bun"');
    expectBlocked(runMulti({ entries: [vendor], bun: bunReport(["glob"]) }), 'class "vendor-pinned" cannot cover source "bun"');
    const remediation = entry(GLOB, "glob", "remediation-available", ["bun"], "harper -> @fastify/static -> glob");
    expect(validateAllowlist({ policy: ALLOWLIST.policy, entries: [remediation] }, new Date("2026-10-01"))).toEqual([]);
    expectPass(runMulti({ entries: [remediation], bun: bunReport(["glob"]) }));
  }, 24_000);

  const ACROSS = [
    entry(GLOB, "glob", "remediation-available", ["bun"], "harper -> @fastify/static -> glob"),
    entry(GLOB, "glob", "vendor-pinned", ["npm-install"], "harper -> @fastify/static -> glob", { removeWhen: "harper's shrinkwrap resolves a patched glob" }),
    entry(GLOB, "glob", "vendor-pinned", ["npm-install-adk"], ADK_GLOB, { version: "10.5.0" }),
    entry(MINIMATCH, "minimatch", "remediation-available", ["bun"], "harper -> @fastify/static -> glob -> minimatch"),
    entry(MINIMATCH, "minimatch", "vendor-pinned", ["npm-install"], "harper -> @fastify/static -> glob -> minimatch", { removeWhen: "harper's shrinkwrap resolves a patched minimatch" }),
    entry(MINIMATCH, "minimatch", "vendor-pinned", ["npm-install-adk"], `${ADK_GLOB} -> minimatch`, { version: "9.0.9" }),
  ];
  const ACROSS_REPORTS = {
    bun: bunReport(["glob", "minimatch"]),
    npm: {
      "npm-install": npmReport({ glob: ["node_modules/harper/node_modules/glob"], minimatch: ["node_modules/harper/node_modules/minimatch"] }),
      "npm-install-adk": npmReport({ glob: ["node_modules/glob"], minimatch: ["node_modules/minimatch"] }),
    },
  };

  it("glob_and_minimatch_across_sources_pass: bun remediation-available, npm-install and npm-install-adk vendor-pinned", () => {
    const res = runMulti({ entries: ACROSS, ...ACROSS_REPORTS });
    expectPass(res);
    expect(res.stdout).toContain("advisories reported: 6 (6 moderate)");
    expect(res.stdout).toContain("allowlisted (justified + dated):  6");
  }, 12_000);

  it("same_ghsa_different_classes_per_source: one advisory, a different true class in each source", () => {
    expectPass(runMulti({
      entries: ACROSS.slice(0, 2),
      bun: bunReport(["glob"]),
      npm: { "npm-install": npmReport({ glob: ["node_modules/harper/node_modules/glob"] }) },
    }));
  }, 12_000);

  it("blocks the npm-install glob copy when only its bun sibling is listed", () => {
    const res = runMulti({ entries: [ACROSS[0]!, ACROSS[2]!], ...ACROSS_REPORTS, npm: { "npm-install": ACROSS_REPORTS.npm["npm-install"] } });
    expectBlocked(res, `MODERATE ${GLOB} in glob (>=9.0.0 <=14.0.1) is NOT allowlisted in source [npm-install]`);
  }, 12_000);

  it("duplicate_coverage_fails: two entries naming bun for one advisory and package", () => {
    const twice = [
      entry(GLOB, "glob", "remediation-available", ["bun"], "harper -> @fastify/static -> glob"),
      entry(GLOB, "glob", "remediation-available", ["bun"], "@tpsdev-ai/pi-flair -> @earendil-works/pi-coding-agent -> glob"),
    ];
    const problems = validateAllowlist({ policy: ALLOWLIST.policy, entries: twice }, new Date("2026-10-01")).join("\n");
    expect(problems).toContain("duplicate coverage — entry[0]");
    expect(problems).toContain("and entry[1]");
    expect(problems).toContain('both cover GHSA-3g3m-2fjr-6pw4 (glob) in source "bun"');
    expectBlocked(runMulti({ entries: twice, bun: bunReport(["glob"]) }), "duplicate coverage");
  }, 12_000);

  it("duplicate_coverage_fails: two ADK entries whose chains resolve to the same node", () => {
    const res = runMulti({
      entries: [uuidEntry(VERTEXAI), uuidEntry(VERTEXAI, { sources: ["npm-install-adk", "npm-install-mcp"] }), uuidEntry(GTOKEN)],
      npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE),
    });
    expectBlocked(res, `duplicate coverage — entry[0]`, `all resolve to node "${VERTEXAI_NODE}" in npm-install-adk`);
  }, 12_000);

  it("still refuses an exact duplicate of one entry", () => {
    const problems = validateAllowlist({ policy: ALLOWLIST.policy, entries: [uuidEntry(VERTEXAI), uuidEntry(VERTEXAI)] }, new Date("2026-10-01"));
    expect(problems.join("\n")).toContain("duplicate entry for GHSA-w5hq-g745-h8pq (entry[0] has the same package, sources and introducedBy)");
  });

  it("expired_or_unapproved_sibling: an expired sibling blocks while the other entry is valid", () => {
    const res = runMulti({ entries: [uuidEntry(VERTEXAI), uuidEntry(GTOKEN, { expires: "2026-10-01" })], npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE) });
    expectBlocked(res, `allowlist entry[1] (${UUID} / uuid, sources [npm-install-adk], via ${GTOKEN}) (moderate) EXPIRED on 2026-10-01`);
    expect(res.stdout).not.toContain(`entry[0] (${UUID} / uuid, sources [npm-install-adk], via ${VERTEXAI}) (moderate) EXPIRED`);
  }, 12_000);

  it("expired_or_unapproved_sibling: an unapproved sibling blocks while the other entry is valid", () => {
    const unapproved: Record<string, unknown> = uuidEntry(GTOKEN);
    delete unapproved.approvedBy;
    const res = runMulti({ entries: [uuidEntry(VERTEXAI), unapproved], npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE) });
    expectBlocked(res, 'entry[1] (GHSA-w5hq-g745-h8pq / uuid): missing required field "approvedBy"');
  }, 12_000);

  it("treats an entry as live the day before its expiry and expired on the day itself", () => {
    const entries = [uuidEntry(VERTEXAI, { expires: "2026-10-02" }), uuidEntry(GTOKEN, { expires: "2026-10-02" })];
    expectPass(runMulti({ entries, npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE), today: "2026-10-01" }));
    expectBlocked(
      runMulti({ entries, npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE), today: "2026-10-02" }),
      `allowlist entry[0] (${UUID} / uuid, sources [npm-install-adk], via ${VERTEXAI}) (moderate) EXPIRED on 2026-10-02`,
      `allowlist entry[1] (${UUID} / uuid, sources [npm-install-adk], via ${GTOKEN}) (moderate) EXPIRED on 2026-10-02`,
    );
  }, 24_000);

  it("rejects a nonexistent added date before advisory matching with real Git history", () => {
    const res = runMulti({ entries: [uuidEntry(VERTEXAI, { added: "2026-02-30" })], npm: uuidAt(VERTEXAI_NODE) });
    expectBlocked(res, '"added" must be a real calendar date (YYYY-MM-DD)');
    expect(res.stdout).toContain("no advisory was matched against it");
    expect(res.stdout).not.toContain("NOT allowlisted");
  }, 12_000);

  it("prints an over-cap entry without --explain", () => {
    const entries = [uuidEntry(VERTEXAI, {
      added: "2025-01-01",
      expires: "2026-10-01",
      overCapApproval: {
        approvedBy: "fixture-approver",
        reason: "Fixture approval reason.",
        approvedOn: "2026-09-01",
        expires: "2026-10-01",
      },
    })];
    const res = runMulti({ entries, npm: uuidAt(VERTEXAI_NODE), today: "2026-09-02" });
    expectPass(res);
    expect(res.stdout).toContain(
      "OVER-CAP: GHSA-w5hq-g745-h8pq uuid — cumulative 638d lifetime, 180d moderate cap, " +
        "approval recorded for fixture-approver until 2026-10-01: Fixture approval reason.",
    );
  }, 12_000);

  it("fails closed before matching when the allowlist has no readable history", () => {
    const res = runMulti({
      entries: [uuidEntry(VERTEXAI)],
      npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE),
      history: "none",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("FAILED TO READ ALLOWLIST HISTORY");
    expect(res.stdout).not.toContain("NOT allowlisted");
  }, 12_000);

  it("fails closed before matching when the allowlist file cannot be read", () => {
    const res = runMulti({
      entries: [uuidEntry(VERTEXAI)],
      npm: uuidAt(VERTEXAI_NODE, GTOKEN_NODE),
      history: "unreadable",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("cannot read");
    expect(res.stdout).not.toContain("NOT allowlisted");
  }, 12_000);
});

// ─── Cumulative lifetime and over-cap approval (#2897) ──────

describe("cumulative allowlist lifetime (#2897)", () => {
  const GHSA = "GHSA-aaaa-bbbb-cccc";
  const NEW_GHSA = "GHSA-dddd-eeee-ffff";
  const policy = ALLOWLIST.policy;
  const entry = (extra: Record<string, unknown> = {}) => ({
    ghsa: GHSA,
    package: "pkg-a",
    severity: "high",
    class: "remediation-available",
    sources: ["bun"],
    approvedBy: "fixture",
    introducedBy: "fixture -> pkg-a",
    reason: "Fixture entry.",
    added: "2026-09-01",
    expires: "2026-10-01",
    removeWhen: "the fixture resolves a patched copy",
    ...extra,
  });

  /** Runs one git command in a fixture repo with a fixed commit date. */
  function gitAt(root: string, date: string, args: string[]) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, timeout: 20_000 });
    if (res.status !== 0) throw new Error(`fixture git ${args[0]} failed (${res.status}): ${res.stderr || res.stdout || res.error?.message}`);
    return res.stdout;
  }

  /** A real repository with commits of the supplied allowlist snapshots. */
  function historyRepo(commits: { date: string; entries: object[]; raw?: string }[]) {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-history-"));
    mkdirSync(join(root, ".github"), { recursive: true });
    gitAt(root, commits[0]!.date, ["init", "-q"]);
    commits.forEach((commit, i) => {
      writeFileSync(join(root, ".github/audit-allowlist.json"), commit.raw ?? JSON.stringify({ policy, entries: commit.entries }));
      gitAt(root, commit.date, ["add", ".github/audit-allowlist.json"]);
      gitAt(root, commit.date, ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "--allow-empty", "-q", "-m", `fixture ${i}`]);
    });
    pinFixtureHistory(root);
    return root;
  }

  for (const date of ["2026-02-30", "2026-04-31", "2025-02-29", "2026-13-01"]) {
    for (const field of ["added", "expires"]) {
      it(`rejects nonexistent ${field} ${date} with a calendar-date problem`, () => {
        expect(validateAllowlist({ policy, entries: [entry({ [field]: date })] }, new Date("2026-09-21")).join("\n"))
          .toContain(`"${field}" must be a real calendar date (YYYY-MM-DD)`);
      });
    }
    for (const field of ["approvedOn", "expires"]) {
      it(`rejects nonexistent overCapApproval.${field} ${date} with a calendar-date problem`, () => {
        const candidate = entry({
          overCapApproval: { approvedBy: "fixture", reason: "Fixture approval.", approvedOn: "2026-09-01", expires: "2026-10-01", [field]: date },
        });
        expect(validateAllowlist({ policy, entries: [candidate] }, new Date("2026-09-21")).join("\n"))
          .toContain(`"overCapApproval.${field}" must be a real calendar date (YYYY-MM-DD)`);
      });
    }
    it(`rejects nonexistent first history day ${date} with a calendar-date problem`, () => {
      const firstDays = new Map([[GHSA.toUpperCase(), date]]);
      expect(validateAllowlistHistory({ entries: [entry()] }, firstDays, new Date("2026-09-21")).join("\n"))
        .toContain("first history day must be a real calendar date (YYYY-MM-DD)");
    });
    it(`rejects nonexistent AUDIT_GATE_TODAY ${date} before reading inputs`, () => {
      const res = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/audit-gate.mjs")], {
        encoding: "utf8", env: { ...process.env, AUDIT_GATE_TODAY: date }, timeout: 12_000,
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("AUDIT_GATE_TODAY must be a real calendar date (YYYY-MM-DD)");
      expect(res.stderr).not.toContain("missing --npm-install-prefix");
    });
  }

  for (const [date, nextDay] of [["2024-02-29", "2024-03-01"], ["2026-09-01", "2026-09-02"]]) {
    it(`accepts calendar date ${date} in entries, approvals and history`, () => {
      const candidate = entry({
        added: date, expires: nextDay,
        overCapApproval: { approvedBy: "fixture", reason: "Fixture approval.", approvedOn: date, expires: nextDay },
      });
      expect(validateAllowlist({ policy, entries: [candidate] }, new Date(date!))).toEqual([]);
      expect(validateAllowlistHistory({ entries: [candidate] }, new Map([[GHSA.toUpperCase(), date]]), new Date(date!))).toEqual([]);
    });
  }

  it("rejects a nonexistent added date that normalizes to a shorter lifetime than the Git history", () => {
    const root = historyRepo([{ date: "2026-03-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      const firstDays = readFixtureHistory(root);
      const firstDay = firstDays.get(GHSA.toUpperCase());
      expect(firstDay).toBe("2026-03-01");
      const candidate = entry({ added: "2026-02-30", expires: "2026-05-01" });
      expect((Date.parse(candidate.expires) - Date.parse(candidate.added)) / 86_400_000).toBe(60);
      expect((Date.parse(candidate.expires) - Date.parse(firstDay!)) / 86_400_000).toBe(61);
      expect(validateAllowlist({ policy, entries: [candidate] }, new Date("2026-03-01")).join("\n"))
        .toContain('"added" must be a real calendar date (YYYY-MM-DD)');
      expect(validateAllowlistHistory({ entries: [candidate] }, firstDays, new Date("2026-03-01")).join("\n"))
        .toContain('"added" must be a real calendar date (YYYY-MM-DD)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a non-canonical GHSA even when history used that casing", () => {
    const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA.toUpperCase() }] }]);
    try {
      expect(validateAllowlist({ policy, entries: [entry({ ghsa: GHSA.toUpperCase() })] }, new Date("2026-09-21")).join("\n"))
        .toContain('"ghsa" must use canonical casing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a canonical GHSA whose first history commit used different casing", () => {
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA.toUpperCase() }] },
      { date: "2026-09-20T12:00:00Z", entries: [{ ghsa: GHSA }] },
    ]);
    try {
      const firstDays = readFixtureHistory(root);
      expect(firstDays.get(GHSA.toUpperCase())).toBe("2026-09-01");
      expect(validateAllowlistHistory({ entries: [entry({ added: "2026-09-20" })] }, firstDays, new Date("2026-09-21"))).not.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a renewal after a split-line ghsa field is normalized", () => {
    const original = entry({ added: "2026-09-01", expires: "2026-10-01" });
    const renewed = entry({ added: "2026-09-20", expires: "2026-11-15" });
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [original], raw: JSON.stringify({ policy, entries: [original] }).replace('"ghsa":', '"ghsa":\n') },
      { date: "2026-09-20T12:00:00Z", entries: [original] },
      { date: "2026-09-21T12:00:00Z", entries: [renewed] },
    ]);
    try {
      const firstDays = readFixtureHistory(root);
      expect(validateAllowlist({ policy, entries: [renewed] }, new Date("2026-09-21"))).toEqual([]);
      const problems = validateAllowlistHistory({ policy, entries: [renewed] }, firstDays, new Date("2026-09-21"));
      expect(problems.join("\n")).toContain("first day this advisory appears in parsed allowlist history (2026-09-01)");
      expect(problems.join("\n")).toContain("lifetime cap:");
      expect(firstDays.get(GHSA.toUpperCase())).toBe("2026-09-01");
      expect(validateAllowlist({ policy, entries: [{ ...renewed, added: firstDays.get(GHSA.toUpperCase()) }] }, new Date("2026-09-21")).join("\n"))
        .toContain('lifetime 75d exceeds the 60d cap');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names an invalid JSON snapshot even when later history is valid", () => {
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [], raw: '{"entries":[' },
      { date: "2026-09-20T12:00:00Z", entries: [entry()] },
    ]);
    try {
      const sha = gitAt(root, "2026-09-21T12:00:00Z", ["rev-parse", "HEAD~1"]).trim();
      expect(() => readFixtureHistory(root)).toThrow(`cannot parse allowlist snapshot ${sha}:.github/audit-allowlist.json`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Writes a snapshot and commits it at the supplied committer date. */
  function commitPath(root: string, date: string, path: string, value: object, message: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
    gitAt(root, date, ["add", "-A", "."]);
    gitAt(root, date, ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", message]);
  }

  for (const operation of ["rename", "delete"] as const) {
    it(`refuses a ${operation} after the pinned start even when the fixed path is restored`, () => {
      const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [entry()] }]);
      try {
        if (operation === "rename") gitAt(root, "2026-09-05T12:00:00Z", ["mv", ".github/audit-allowlist.json", ".github/old-allowlist.json"]);
        else rmSync(join(root, ".github/audit-allowlist.json"));
        gitAt(root, "2026-09-05T12:00:00Z", ["add", "-A", "."]);
        gitAt(root, "2026-09-05T12:00:00Z", ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", operation]);
        const missing = gitAt(root, "2026-09-05T12:00:00Z", ["rev-parse", "HEAD"]).trim();
        commitPath(root, "2026-09-10T12:00:00Z", ".github/audit-allowlist.json", { entries: [entry()] }, "restore");
        expect(() => readFixtureHistory(root)).toThrow(`allowlist lineage cannot be established: missing .github/audit-allowlist.json at ${missing}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("reads an escaped advisory id from the pinned snapshot", () => {
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [], raw: JSON.stringify({ entries: [entry()] }).replace("GHSA", "\\u0047HSA") },
      { date: "2026-09-20T12:00:00Z", entries: [entry()] },
    ]);
    try {
      expect(readFixtureHistory(root).get(GHSA.toUpperCase())).toBe("2026-09-01");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a pinned start outside HEAD ancestry", () => {
    const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [entry()] }]);
    try {
      const start = gitAt(root, "2026-09-01T12:00:00Z", ["rev-parse", "HEAD"]).trim();
      gitAt(root, "2026-09-02T12:00:00Z", ["checkout", "--orphan", "unrelated"]);
      gitAt(root, "2026-09-02T12:00:00Z", ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "unrelated root"]);
      expect(() => readFixtureHistory(root)).toThrow(`allowlist lineage cannot be established: pinned start ${start} is not an ancestor of HEAD`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores snapshots outside the pinned start's descendants", () => {
    const root = historyRepo([
      { date: "2026-08-01T12:00:00Z", entries: [], raw: "invalid JSON" },
      { date: "2026-09-01T12:00:00Z", entries: [entry()] },
    ]);
    try {
      pinFixtureHistory(root, gitAt(root, "2026-09-01T12:00:00Z", ["rev-parse", "HEAD"]).trim());
      expect(readFixtureHistory(root).get(GHSA.toUpperCase())).toBe("2026-09-01");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const first of ["2026-09-10", "2030-01-01"]) {
    it(`keeps first introduction ${first} through removal and an earlier-dated reintroduction`, () => {
      const root = historyRepo([
        { date: `${first}T12:00:00Z`, entries: [entry()] },
        { date: "2026-09-15T12:00:00Z", entries: [] },
        { date: "2026-08-01T12:00:00Z", entries: [entry()] },
      ]);
      try {
        const days = readFixtureHistory(root);
        expect(days.get(GHSA.toUpperCase())).toBe(first);
        if (first === "2030-01-01") {
          expect(validateAllowlistHistory({ entries: [entry()] }, days, new Date("2026-09-21")).join("\n"))
            .toContain("first history day (2030-01-01) is after today (2026-09-21)");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("reads first appearance from a side-branch commit merged later", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-merge-"));
    try {
      gitAt(root, "2026-09-01T12:00:00Z", ["init", "-q", "-b", "main"]);
      commitPath(root, "2026-09-01T12:00:00Z", ".github/audit-allowlist.json",
        { policy, entries: [] }, "base");
      pinFixtureHistory(root);
      gitAt(root, "2026-09-02T12:00:00Z", ["checkout", "-q", "-b", "side"]);
      commitPath(root, "2026-09-05T12:00:00Z", ".github/audit-allowlist.json",
        { policy, entries: [entry({ ghsa: NEW_GHSA, added: "2026-09-05" })] }, "side adds the advisory");
      gitAt(root, "2026-09-10T12:00:00Z", ["checkout", "-q", "main"]);
      writeFileSync(join(root, "README.md"), "fixture\n");
      gitAt(root, "2026-09-10T12:00:00Z", ["add", "README.md"]);
      gitAt(root, "2026-09-10T12:00:00Z", ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "main moves on"]);
      gitAt(root, "2026-09-15T12:00:00Z", ["merge", "--no-ff", "-q", "-m", "merge side", "side"]);
      expect(readFixtureHistory(root).get(NEW_GHSA.toUpperCase())).toBe("2026-09-05");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an introduction day when a descendant has an earlier committer date", () => {
    const root = historyRepo([
      { date: "2026-09-10T12:00:00Z", entries: [entry()] },
      { date: "2026-08-01T12:00:00Z", entries: [entry()] },
    ]);
    try {
      expect(readFixtureHistory(root).get(GHSA.toUpperCase())).toBe("2026-09-10");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a future-dated first history commit", () => {
    const root = historyRepo([{ date: "2030-01-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      expect(validateAllowlistHistory({ entries: [entry({ added: "2026-09-01" })] }, readFixtureHistory(root), new Date("2026-09-21")).join("\n"))
        .toContain("first history day (2030-01-01) is after today (2026-09-21)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a future added date with existing history", () => {
    const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      const history = readFixtureHistory(root);
      expect(history.get(GHSA.toUpperCase())).toBe("2026-09-01");
      const candidate = entry({ added: "2026-09-22", expires: "2026-10-01" });
      expect(validateAllowlist({ policy, entries: [candidate] }, new Date("2026-09-21")).join("\n"))
        .toContain('"added" (2026-09-22) is after today (2026-09-21)');
      expect(validateAllowlistHistory({ entries: [candidate] }, history, new Date("2026-09-21")).join("\n"))
        .toContain('"added" (2026-09-22) is after today (2026-09-21)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a future approvedOn in a history-backed entry", () => {
    const root = historyRepo([{ date: "2026-08-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      const candidate = entry({
        added: "2026-07-01",
        expires: "2026-09-20",
        overCapApproval: {
          approvedBy: "fixture-approver",
          reason: "Fixture approval reason.",
          approvedOn: "2026-08-03",
          expires: "2026-09-25",
        },
      });
      expect(readFixtureHistory(root).get(GHSA.toUpperCase())).toBe("2026-08-01");
      expect(validateAllowlist({ policy, entries: [candidate] }, new Date("2026-08-02")).join("\n"))
        .toContain('"overCapApproval.approvedOn" (2026-08-03) is after today (2026-08-02)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a future approvedOn even when the entry is within its cap", () => {
    const root = historyRepo([{ date: "2026-08-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      const candidate = entry({
        added: "2026-08-01",
        expires: "2026-09-01",
        overCapApproval: {
          approvedBy: "fixture-approver",
          reason: "Fixture approval reason.",
          approvedOn: "2026-08-03",
          expires: "2026-09-25",
        },
      });
      expect(readFixtureHistory(root).get(GHSA.toUpperCase())).toBe("2026-08-01");
      expect(validateAllowlist({ policy, entries: [candidate] }, new Date("2026-08-02")).join("\n"))
        .toContain('"overCapApproval.approvedOn" (2026-08-03) is after today (2026-08-02)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a renewal that moves added later", () => {
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] },
      { date: "2026-09-20T12:00:00Z", entries: [{ ghsa: GHSA }] },
    ]);
    try {
      const firstDays = readFixtureHistory(root);
      expect(firstDays.get(GHSA.toUpperCase())).toBe("2026-09-01");
      expect(
        validateAllowlistHistory({ entries: [entry({ added: "2026-09-20" })] }, firstDays, new Date("2026-09-21")).join("\n"),
      ).toContain(
        '"added" (2026-09-20) is later than the first day this advisory appears in parsed allowlist history (2026-09-01)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a re-key to another source and chain", () => {
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] },
      { date: "2026-09-20T12:00:00Z", entries: [{ ghsa: GHSA, package: "pkg-b", sources: ["npm-install"] }] },
    ]);
    try {
      const firstDays = readFixtureHistory(root);
      expect(firstDays.get(GHSA.toUpperCase())).toBe("2026-09-01");
      expect(
        validateAllowlistHistory(
          { entries: [entry({ package: "pkg-b", sources: ["npm-install"], added: "2026-09-20" })] },
          firstDays,
          new Date("2026-09-21"),
        ).join("\n"),
      ).toContain("is later than the first day this advisory appears in parsed allowlist history (2026-09-01)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a delete-then-re-add", () => {
    const root = historyRepo([
      { date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] },
      { date: "2026-09-10T12:00:00Z", entries: [] },
      { date: "2026-09-20T12:00:00Z", entries: [{ ghsa: GHSA }] },
    ]);
    try {
      const firstDays = readFixtureHistory(root);
      expect(firstDays.get(GHSA.toUpperCase())).toBe("2026-09-01");
      expect(
        validateAllowlistHistory({ entries: [entry({ added: "2026-09-20" })] }, firstDays, new Date("2026-09-21")).join("\n"),
      ).toContain("first day this advisory appears in parsed allowlist history (2026-09-01)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an added date moved earlier", () => {
    const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      expect(validateAllowlistHistory({ entries: [entry({ added: "2026-08-15" })] }, readFixtureHistory(root), new Date("2026-09-21"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a new id on or before today and rejects one added later", () => {
    const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    try {
      const firstDays = readFixtureHistory(root);
      expect(firstDays.has(NEW_GHSA.toUpperCase())).toBe(false);
      expect(
        validateAllowlistHistory({ entries: [entry({ ghsa: NEW_GHSA, added: "2026-09-15" })] }, firstDays, new Date("2026-09-15")),
      ).toEqual([]);
      expect(
        validateAllowlistHistory({ entries: [entry({ ghsa: NEW_GHSA, added: "2026-09-16" })] }, firstDays, new Date("2026-09-15")).join("\n"),
      ).toContain("today (2026-09-15), and no parsed snapshot contained this advisory id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a shallow history", () => {
    const root = historyRepo([{ date: "2026-09-01T12:00:00Z", entries: [{ ghsa: GHSA }] }]);
    const shallow = mkdtempSync(join(tmpdir(), "flair-audit-shallow-"));
    try {
      const clone = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${root}`, shallow], {
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(clone.status).toBe(0);
      expect(() => readAllowlistHistory(shallow)).toThrow(/allowlist lineage cannot be established: .*shallow clone/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it("refuses an unreadable allowlist history", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-unreadable-"));
    try {
      mkdirSync(join(root, ".github"), { recursive: true });
      symlinkSync(join(root, ".github/missing.json"), join(root, ".github/audit-allowlist.json"));
      expect(() => readAllowlistHistory(root)).toThrow(/cannot read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a failed git call", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-nogit-"));
    try {
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, ".github/audit-allowlist.json"), JSON.stringify({ policy, entries: [] }));
      expect(() => readAllowlistHistory(root)).toThrow(/git rev-parse failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const TODAY = new Date("2026-08-02");
  const validApproval = {
    approvedBy: "fixture-approver",
    reason: "Fixture approval reason.",
    approvedOn: "2026-08-01",
    expires: "2026-09-25",
  };
  const overCapEntry = (extra: Record<string, unknown> = {}) =>
    entry({ added: "2026-07-01", expires: "2026-09-20", ...extra });
  const problems = (entryValue: object) =>
    validateAllowlist({ policy, entries: [entryValue] }, TODAY).join("\n");

  it("rejects an over-cap entry with no overCapApproval", () => {
    expect(problems(overCapEntry())).toContain("lifetime 81d exceeds the 60d cap");
    expect(problems(overCapEntry())).toContain("no overCapApproval is present");
  });

  it("accepts an over-cap entry with a valid overCapApproval", () => {
    expect(problems(overCapEntry({ overCapApproval: validApproval }))).toBe("");
  });

  it("rejects an approval missing a member or carrying a blank reason", () => {
    const missing = { ...validApproval } as Record<string, unknown>;
    delete missing.reason;
    expect(problems(overCapEntry({ overCapApproval: missing }))).toContain('"overCapApproval.reason" is required');
    expect(problems(overCapEntry({ overCapApproval: { ...validApproval, approvedBy: "  " } }))).toContain(
      '"overCapApproval.approvedBy" is required and must be non-blank',
    );
  });

  it("rejects an approval with an unreal calendar date", () => {
    expect(problems(overCapEntry({ overCapApproval: { ...validApproval, approvedOn: "2026-02-30" } }))).toContain(
      '"overCapApproval.approvedOn" must be a real calendar date',
    );
  });

  it("rejects an expired approval", () => {
    expect(
      problems(
        overCapEntry({
          added: "2026-05-01",
          expires: "2026-07-01",
          overCapApproval: { ...validApproval, approvedOn: "2026-06-01", expires: "2026-07-01" },
        }),
      ),
    ).toContain("the over-cap approval EXPIRED on 2026-07-01");
  });

  it("rejects an entry that outlives its approval", () => {
    expect(
      problems(
        overCapEntry({
          overCapApproval: { ...validApproval, expires: "2026-09-10" },
        }),
      ),
    ).toContain("the entry expires 2026-09-20, after the approval's expiry 2026-09-10");
  });

  it("rejects an approval longer than the severity cap", () => {
    expect(
      problems(
        overCapEntry({
          expires: "2026-09-01",
          overCapApproval: { ...validApproval, approvedOn: "2026-06-01", expires: "2026-09-10" },
        }),
      ),
    ).toContain("the approval lasts 101d, beyond the 60d cap");
  });

  it("rejects an approval dated after today", () => {
    expect(
      problems(overCapEntry({ overCapApproval: { ...validApproval, approvedOn: "2026-09-01" } })),
    ).toContain('"overCapApproval.approvedOn" (2026-09-01) is after today (2026-08-02)');
  });

  it("rejects an unknown severity or a missing cap instead of skipping the cap check", () => {
    expect(problems(overCapEntry({ severity: "severe" }))).toContain('no lifetime cap is configured for severity "severe"');
    expect(validateAllowlist({ policy: { maxLifetimeDaysBySeverity: {} }, entries: [entry()] }, TODAY).join("\n")).toContain(
      'policy.maxLifetimeDaysBySeverity is missing "critical"',
    );
  });
});

// ─── Pinned lifetime ceilings (#2973) ────────────────────────────────────────

describe("pinned lifetime ceilings", () => {
  const TODAY = new Date("2026-11-02");
  const SEVERITIES = ["critical", "high", "moderate", "low"] as const;
  const policy = (overrides: Record<string, unknown> = {}) => ({
    maxLifetimeDaysBySeverity: {
      critical: 30, high: 60, moderate: 180, low: 180, ...overrides,
    },
  });
  const problems = (allowlist: object) => validateAllowlist(allowlist, TODAY).join("\n");
  const entryAt = (severity: string, days: number) => ({
    ghsa: "GHSA-aaaa-bbbb-cccc",
    package: "pkg-a",
    severity,
    class: "remediation-available",
    sources: ["bun"],
    approvedBy: "reviewer-a",
    introducedBy: "pkg-a -> pkg-b",
    reason: "Fixture entry for the pinned ceiling tests.",
    added: "2026-01-01",
    expires: new Date(Date.parse("2026-01-01T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10),
    removeWhen: "the fixture resolves a patched copy",
  });

  for (const severity of SEVERITIES) {
    const ceiling = MAX_LIFETIME_DAYS_BY_SEVERITY[severity];

    it(`accepts a policy block declaring ${severity} at its ${ceiling}d pinned ceiling`, () => {
      expect(problems({ policy: policy(), entries: [] })).toBe("");
    });

    it(`accepts an entry at ${severity}'s ${ceiling}d ceiling`, () => {
      expect(problems({ policy: policy(), entries: [entryAt(severity, ceiling)] })).toBe("");
    });

    it(`rejects an entry one day over ${severity}'s ${ceiling}d ceiling`, () => {
      expect(problems({ policy: policy(), entries: [entryAt(severity, ceiling + 1)] })).toContain(
        `lifetime ${ceiling + 1}d exceeds the ${ceiling}d cap for severity "${severity}"`,
      );
    });

    it(`accepts ${severity} below its ${ceiling}d pinned ceiling`, () => {
      expect(problems({ policy: policy({ [severity]: ceiling - 1 }), entries: [] })).toBe("");
    });

    it(`rejects ${severity} above its ${ceiling}d pinned ceiling`, () => {
      expect(problems({ policy: policy({ [severity]: ceiling + 1 }), entries: [] })).toContain(
        `is ${ceiling + 1}d, above the ${ceiling}d ceiling pinned in scripts/audit-gate.mjs`,
      );
    });

    it(`enforces a below-ceiling cap on ${severity} entries`, () => {
      expect(problems({ policy: policy({ [severity]: ceiling - 1 }), entries: [entryAt(severity, ceiling)] }))
        .toContain(`lifetime ${ceiling}d exceeds the ${ceiling - 1}d cap for severity "${severity}"`);
    });

    it(`rejects a policy block that omits ${severity}`, () => {
      const partial = policy();
      delete (partial.maxLifetimeDaysBySeverity as Record<string, unknown>)[severity];
      expect(problems({ policy: partial, entries: [] })).toContain(
        `is missing "${severity}"; its pinned ceiling is ${ceiling}d`,
      );
    });
  }

  for (const [value, label] of [
    ["30", "a numeric string"], [null, "null"], [0, "zero"], [-1, "a negative number"],
    [Number.NaN, "NaN"], [Number.POSITIVE_INFINITY, "Infinity"], ["NaN", "the string NaN"],
    ["Infinity", "the string Infinity"],
  ] as const) {
    it(`rejects ${label} as a severity cap`, () => {
      expect(problems({ policy: policy({ critical: value }), entries: [] })).toContain(
        'policy.maxLifetimeDaysBySeverity["critical"] must be a finite positive number',
      );
    });
  }

  it("names the derived cap in the over-cap report when the policy declares a lower one", () => {
    const declared = policy({ high: 30 });
    const caps = lifetimeCapsFromPolicy({ policy: declared }, []);
    expect(caps.high).toBe(30);
    const entry = {
      ...entryAt("high", 40),
      overCapApproval: {
        approvedBy: "fixture-approver",
        reason: "Fixture approval reason.",
        approvedOn: "2026-11-01",
        expires: "2026-11-30",
      },
    };
    const lines = overCapReportLines({ policy: declared, entries: [entry] }, caps);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("30d high cap");
  });

  it("reports against the caps it is given, not the raw policy block", () => {
    const declared = policy({ high: 180 });
    const policyProblems: string[] = [];
    const caps = lifetimeCapsFromPolicy({ policy: declared }, policyProblems);
    expect(policyProblems.join("\n")).toContain("above the 60d ceiling");
    expect(caps.high).toBe(60);
    const entry = {
      ...entryAt("high", 90),
      overCapApproval: {
        approvedBy: "fixture-approver",
        reason: "Fixture approval reason.",
        approvedOn: "2026-11-01",
        expires: "2026-11-30",
      },
    };
    const lines = overCapReportLines({ policy: declared, entries: [entry] }, caps);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("60d high cap");
  });

  it("rejects a severity outside the four instead of accepting a new cap", () => {
    expect(problems({ policy: policy({ unknown: 365 }), entries: [] })).toContain(
      'names "unknown", which has no pinned ceiling',
    );
  });

  it("keeps the committed allowlist at or below every pinned ceiling", () => {
    expect(validateAllowlist(ALLOWLIST, ALLOWLIST_AS_OF).join("\n")).toBe("");
    for (const severity of SEVERITIES) {
      expect(ALLOWLIST.policy.maxLifetimeDaysBySeverity[severity])
        .toBeLessThanOrEqual(MAX_LIFETIME_DAYS_BY_SEVERITY[severity]);
    }
  });

  function runPolicyGate(fixturePolicy: object) {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-policy-"));
    try {
      for (const dir of ["scripts", ".github", "bin", "home", "tmp"]) mkdirSync(join(root, dir));
      writeFileSync(join(root, "scripts/audit-gate.mjs"), readFileSync(join(REPO_ROOT, "scripts", "audit-gate.mjs")));
      writeFileSync(join(root, ".github/audit-allowlist.json"), JSON.stringify({ policy: fixturePolicy, entries: [] }));
      commitAllowlistHistory(root);
      const prefixOf = (source: string) => join(root, `prefix-${source}`);
      writeIdentities(root, prefixOf);
      writeFileSync(join(root, "bin/bun"), "#!/bin/sh\nprintf '{}\\n'\n");
      writeFileSync(join(root, "bin/npm"), "#!/bin/sh\nprintf '%s\\n' '{\"vulnerabilities\":{}}'\n");
      chmodSync(join(root, "bin/bun"), 0o755);
      chmodSync(join(root, "bin/npm"), 0o755);
      return spawnSync(process.execPath, [join(root, "scripts/audit-gate.mjs"), ...prefixArgs(prefixOf)], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
          HOME: join(root, "home"), TMPDIR: join(root, "tmp"), AUDIT_GATE_TODAY: "2026-11-02",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("passes the real gate with the committed policy", () => {
    const res = runPolicyGate(ALLOWLIST.policy);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS —");
  }, 12_000);

  it("fails the real gate above a pinned ceiling, naming the severity", () => {
    const res = runPolicyGate(policy({ critical: 31 }));
    expect(res.error).toBeUndefined();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain('["critical"] is 31d, above the 30d ceiling pinned in scripts/audit-gate.mjs');
    expect(res.stdout).not.toContain("PASS —");
  }, 12_000);
});

// ─── Allowlist integrity ─────────────────────────────────────────────────────

describe("the as-of date the committed allowlist is checked against (flair#3026)", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");

  it("is the latest added date (never earlier than 2026-11-02) while every added date is in the past", () => {
    expect(allowlistAsOf([{ added: "2026-10-01" }, { added: "2026-11-09" }], now).toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(allowlistAsOf([{ added: "2026-10-01" }], now).toISOString().slice(0, 10)).toBe("2026-11-02");
  });

  it("is capped at the real date, so a future added date is still reported", () => {
    const entries = [{ added: "2026-11-09" }, { added: "2026-11-12" }];
    expect(allowlistAsOf(entries, now).getTime()).toBe(now);
    const future = structuredClone(ALLOWLIST);
    future.entries[0].added = "2026-11-12";
    const problems = validateAllowlist(future, allowlistAsOf(future.entries, now)).join("\n");
    expect(problems).toContain(`"added" (2026-11-12) is after today (2026-11-11)`);
  });

  it("skips an unparseable added date, which the schema check then reports", () => {
    expect(allowlistAsOf([{ added: "2026-11-09" }, { added: "not-a-date" }], now).toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(allowlistAsOf([{ added: "not-a-date" }], now).toISOString().slice(0, 10)).toBe("2026-11-02");
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].added = "not-a-date";
    expect(validateAllowlist(bad, allowlistAsOf(bad.entries, now)).join("\n")).toContain(
      `"added" must be a real calendar date (YYYY-MM-DD)`,
    );
  });
});

describe("the committed allowlist", () => {
  it("passes its own schema validation", () => {
    expect(validateAllowlist(ALLOWLIST, ALLOWLIST_AS_OF)).toEqual([]);
  });

  it("gives every entry a reason, an expiry and a removal condition", () => {
    for (const e of ALLOWLIST.entries) {
      expect(e.reason.length).toBeGreaterThan(40);
      expect(e.removeWhen.length).toBeGreaterThan(20);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("caps how long an exception may live, by severity, allowing only a valid over-cap approval", () => {
    // An unexpirable exception is how the original defect survived.
    const caps = ALLOWLIST.policy.maxLifetimeDaysBySeverity;
    expect(caps.critical).toBeLessThanOrEqual(30);
    for (const e of ALLOWLIST.entries) {
      const days = (Date.parse(e.expires) - Date.parse(e.added)) / 86_400_000;
      const cap = caps[e.severity];
      expect(typeof cap).toBe("number");
      expect(days).toBeGreaterThan(0);
      if (days > cap) expect(overCapApprovalProblems(e, ALLOWLIST_AS_OF, cap)).toEqual([]);
      else expect(days).toBeLessThanOrEqual(cap);
    }
  });

  it("rejects an entry parked beyond its severity cap", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].severity = "critical";
    bad.entries[0].added = "2026-07-27";
    bad.entries[0].expires = "2027-07-27";
    const problems = validateAllowlist(bad, ALLOWLIST_AS_OF);
    expect(problems.join("\n")).toContain("exceeds the 30d cap");
  });

  it("rejects an entry missing its justification", () => {
    const bad = structuredClone(ALLOWLIST);
    delete bad.entries[0].reason;
    expect(validateAllowlist(bad, ALLOWLIST_AS_OF).join("\n")).toContain(
      'missing required field "reason"',
    );
  });

  it("rejects an entry missing its removal condition", () => {
    const bad = structuredClone(ALLOWLIST);
    delete bad.entries[0].removeWhen;
    expect(validateAllowlist(bad, ALLOWLIST_AS_OF).join("\n")).toContain(
      'missing required field "removeWhen"',
    );
  });

  it("rejects a hand-waved removal condition", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].removeWhen = "later";
    expect(validateAllowlist(bad, ALLOWLIST_AS_OF).join("\n")).toContain(
      "must state the concrete condition",
    );
  });

  it("rejects a duplicate advisory id", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries.push(structuredClone(bad.entries[0]));
    expect(validateAllowlist(bad, ALLOWLIST_AS_OF).join("\n")).toContain("duplicate entry");
  });

  it("rejects an unknown exception class", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].class = "because-i-said-so";
    expect(validateAllowlist(bad, ALLOWLIST_AS_OF).join("\n")).toContain("unknown class");
  });

  it("accepts the ADK consumer observation as a source and rejects an unknown one (flair#2398)", () => {
    const ok = structuredClone(ALLOWLIST);
    ok.entries[0].sources = ["npm-install-adk"];
    expect(validateAllowlist(ok, ALLOWLIST_AS_OF)).toEqual([]);
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].sources = ["somewhere-else"];
    expect(validateAllowlist(bad, ALLOWLIST_AS_OF).join("\n")).toContain("unknown source");
  });

  it("carries the ADK consumer-install observation (uuid, glob and minimatch; flair#2398)", () => {
    const adk = ALLOWLIST.entries.filter((e) => e.sources.includes("npm-install-adk"));
    // uuid has one entry per copy (the vertexai and gtoken chains).
    expect(adk.map((e) => e.ghsa).sort()).toEqual([
      "GHSA-3g3m-2fjr-6pw4",
      "GHSA-g3hv-75wg-m249",
      "GHSA-w5hq-g745-h8pq",
      "GHSA-w5hq-g745-h8pq",
    ]);
  });

  it("marks harper-pinned npm advisories as npm-install-only (NOT-REPORTED-BY-BUN)", () => {
    // These are the advisories the npm-install observation surfaces that `bun
    // audit` never sees — harper's npm-shrinkwrap pins them. They must declare
    // sources ["npm-install"] so the gate knows bun does not report them.
    const npmOnly = ALLOWLIST.entries.filter((e) => e.package === "fast-uri");
    // Exact IDs catch missing or substituted fast-uri advisories.
    expect(npmOnly.map((e) => e.ghsa).sort()).toEqual([
      "GHSA-333x-w4r6-6crp",
      "GHSA-4c8g-83qw-93j6",
      "GHSA-7p8r-x3mc-p8w7",
      "GHSA-f65p-4m7j-42xc",
      "GHSA-hrr3-gc8f-f4qj",
      "GHSA-jqff-g426-hqxp",
      "GHSA-q3j6-qgpj-74h6",
      "GHSA-qw65-cvwx-89v3",
      "GHSA-v2hh-gcrm-f6hx",
      "GHSA-v39h-62p7-jpjc",
      "GHSA-w74x-v6f9-j3xg",
      "GHSA-wjr9-j795-jxcr",
      "GHSA-xhq7-xmqj-769h",
    ]);
    for (const e of npmOnly) {
      expect(e.sources).toEqual(["npm-install"]);
      expect(e.introducedBy).toMatch(/^harper -> /);
    }
  });

  it("keeps lodash fixed by the root override instead of allowlisted", () => {
    // lodash was reported by `bun audit` only (harper's shrinkwrap already pins
    // 4.18.1 for npm installs). The last vulnerable bun copy was n8n-workflow's
    // nested 4.17.21; the root override moved it to 4.18.x, so the three lodash
    // entries were retired. If the override goes, they come back unlisted.
    expect(ALLOWLIST.entries.filter((e) => e.package === "lodash")).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.overrides.lodash).toBe("^4.18.0");
  });
});

// ─── Advisory parsing ────────────────────────────────────────────────────────

describe("flattenAdvisories", () => {
  it("pulls the GHSA id out of each advisory url", () => {
    const flat = flattenAdvisories({
      "form-data": [
        {
          id: 1,
          url: "https://github.com/advisories/GHSA-fjxv-7rqg-78g4",
          title: "t",
          severity: "critical",
          vulnerable_versions: ">=4.0.0 <4.0.4",
        },
      ],
    });
    expect(flat).toHaveLength(1);
    expect(flat[0].ghsa).toBe("GHSA-fjxv-7rqg-78g4");
    expect(flat[0].package).toBe("form-data");
    expect(flat[0].severity).toBe("critical");
  });

  it("reports a null GHSA rather than silently dropping an advisory", () => {
    // Dropping it would let an un-identifiable advisory pass unnoticed.
    const flat = flattenAdvisories({ pkg: [{ id: 2, url: "", severity: "high" }] });
    expect(flat[0].ghsa).toBeNull();
  });

  it("handles an empty audit result", () => {
    expect(flattenAdvisories({})).toEqual([]);
  });
});

// ─── npm-install observation (flair#1498) ────────────────────────────────────

describe("flattenNpmAdvisories", () => {
  it("extracts GHSA + nodes from npm's v2 report", () => {
    const flat = flattenNpmAdvisories({
      vulnerabilities: {
        fastify: {
          severity: "moderate",
          nodes: ["node_modules/harper/node_modules/fastify"],
          via: [
            {
              id: 1,
              url: "https://github.com/advisories/GHSA-w2qp-rph6-63g4",
              title: "t",
              severity: "moderate",
              range: "<5.12.1",
            },
          ],
        },
      },
    });
    expect(flat).toHaveLength(1);
    expect(flat[0].ghsa).toBe("GHSA-w2qp-rph6-63g4");
    expect(flat[0].package).toBe("fastify");
    expect(flat[0].source).toBe("npm-install");
    expect(flat[0].nodes).toContain("node_modules/harper/node_modules/fastify");
  });

  it("labels the ADK consumer observation with its own source (flair#2398)", () => {
    const node = "node_modules/gaxios/node_modules/uuid";
    const flat = flattenNpmAdvisories({
      vulnerabilities: {
        uuid: { nodes: [node], via: [{
          url: "https://github.com/advisories/GHSA-w5hq-g745-h8pq", severity: "moderate", range: "<11.1.1",
        }] },
      },
    }, "npm-install-adk");
    expect(flat).toHaveLength(1);
    expect(flat[0].source).toBe("npm-install-adk");
  });

  it("returns [] for a clean tree", () => {
    expect(flattenNpmAdvisories({ vulnerabilities: {} })).toEqual([]);
  });

  it("keeps a per-node version when the audit report carries one", () => {
    const node = "node_modules/harper/node_modules/fastify";
    const flat = flattenNpmAdvisories({
      packages: { [node]: { version: "5.12.0" } },
      vulnerabilities: { fastify: { nodes: [node], via: [{
        url: "https://github.com/advisories/GHSA-w2qp-rph6-63g4", severity: "moderate",
      }] } },
    });
    expect(flat[0].nodeVersions[node]).toBe("5.12.0");
  });

  it("preserves an audit package row with no version for fail-closed validation", () => {
    const node = "node_modules/harper/node_modules/fastify";
    const flat = flattenNpmAdvisories({
      packages: { [node]: {} },
      vulnerabilities: { fastify: { nodes: [node], via: [{
        url: "https://github.com/advisories/GHSA-w2qp-rph6-63g4", severity: "moderate",
      }] } },
    });
    expect(flat[0].nodeVersions[node]).toBeNull();
  });

  it("skips transitive container vulnerabilities whose via is a bare name", () => {
    // npm reports a package that is only a container (harper, @tpsdev-ai/flair)
    // with `via` as an array of dependency-name strings, not advisory objects.
    // Those carry no GHSA of their own and must not become allowlist entries.
    const flat = flattenNpmAdvisories({
      vulnerabilities: {
        harper: { severity: "moderate", nodes: ["node_modules/harper"], via: ["@fastify/static"] },
      },
    });
    expect(flat).toEqual([]);
  });
});

describe("parseNpmAuditOutput", () => {
  it("throws when npm output is not valid JSON (never degrades to bun-only)", () => {
    expect(() => parseNpmAuditOutput("this is not json", "/tmp", 1)).toThrow(/not valid JSON/);
  });

  it("throws when npm produces no stdout", () => {
    expect(() => parseNpmAuditOutput("", "/tmp", 0)).toThrow(/produced no output/);
  });

  it("parses a valid JSON report", () => {
    const report = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
    expect(parseNpmAuditOutput(JSON.stringify(report), "/tmp", 0)).toEqual(report);
  });

  // flair#2278: the parser refuses each value below. Before that change it
  // returned them unchanged and flattenNpmAdvisories read each as zero
  // advisories, so with an allowlist that has no entries the gate passed.
  const NON_REPORTS = {
    "an error object": { error: { code: "EAI_AGAIN", summary: "offline", detail: "registry" } },
    "a missing vulnerabilities field": { auditReportVersion: 2, metadata: { vulnerabilities: {} } },
    "an empty object": {},
  };

  for (const [name, value] of Object.entries(NON_REPORTS)) {
    it(`throws on ${name}`, () => {
      expect(() => parseNpmAuditOutput(JSON.stringify(value), "/tmp/prefix", 1)).toThrow(
        /error object instead of a report|not a JSON report object|no "vulnerabilities" object/,
      );
    });
  }

  it("names the stage and the remedy for each non-report refusal", () => {
    for (const value of Object.values(NON_REPORTS)) {
      let err: Error | undefined;
      try {
        parseNpmAuditOutput(JSON.stringify(value), "/tmp/prefix", 1);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err?.message).toContain("npm audit --omit=dev --json");
      expect(err?.message).toContain("/tmp/prefix");
      expect(err?.message).toContain("Re-run the stage; if it keeps failing, check registry access.");
    }
  });

  it("still passes a real zero-advisory report", () => {
    const report = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
    expect(parseNpmAuditOutput(JSON.stringify(report), "/tmp/prefix", 0)).toEqual(report);
  });
});

// ─── Exit status and stderr checks (flair#2278) ──────────────────────────────

describe("audit exit status and stderr checks (flair#2278)", () => {
  // The bun banner, the bun failure lines and the `npm error` line below are
  // copied from runs of the pinned bun (1.3.10) and npm 11.19 against the local
  // registry fixture in audit-gate-real-tools.test.ts. The `npm ERR!` and
  // `npm warn` lines are written for these tests.
  const BUN_BANNER = "\u001b[0m\u001b[1mbun audit \u001b[0m\u001b[2mv1.3.10 (30e609e0)\u001b[0m\n";
  const BUN_REPORT = {
    "audit-fixture-dep": [
      {
        id: 1,
        url: "https://github.com/advisories/GHSA-0000-0000-0001",
        title: "Fixture advisory",
        severity: "high",
        vulnerable_versions: "<1.0.1",
      },
    ],
  };
  const NPM_CLEAN = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
  const NPM_REPORT = {
    auditReportVersion: 2,
    vulnerabilities: {
      "audit-fixture-dep": {
        name: "audit-fixture-dep",
        severity: "high",
        nodes: ["node_modules/audit-fixture-dep"],
        via: [{ url: "https://github.com/advisories/GHSA-0000-0000-0001", severity: "high", range: "<1.0.1" }],
      },
    },
    metadata: {},
  };
  const REMEDY = "Re-run the stage; if it keeps failing, check registry access.";

  it("accepts bun's {} with exit 0 and only the banner on stderr", () => {
    expect(parseBunAuditOutput("{}\n", 0, BUN_BANNER)).toEqual({});
  });

  it("accepts a bun report that lists advisories with exit 1", () => {
    expect(parseBunAuditOutput(JSON.stringify(BUN_REPORT), 1, BUN_BANNER)).toEqual(BUN_REPORT);
  });

  it("refuses bun output that lists no advisories when bun exited non-zero", () => {
    for (const out of ["{}", '{"message":"audit failed"}', '{"audit-fixture-dep":[]}']) {
      expect(() => parseBunAuditOutput(out, 1, BUN_BANNER)).toThrow(
        `\`bun audit\` exited 1 but its report lists no advisories. ${REMEDY}`,
      );
    }
  });

  it("refuses bun output when bun ended without an exit status", () => {
    expect(() => parseBunAuditOutput("{}", null, BUN_BANNER)).toThrow(
      "`bun audit` ended without an exit status but its report lists no advisories.",
    );
  });

  it("refuses bun output when bun's stderr carries a failure line", () => {
    for (const line of [
      "error: audit request failed to parse json. Is the registry down?",
      "ConnectionRefused: audit request failed",
    ]) {
      for (const [out, status] of [["{}", 0], [JSON.stringify(BUN_REPORT), 1]] as const) {
        expect(() => parseBunAuditOutput(out, status, `${BUN_BANNER}${line}\n`)).toThrow(
          `\`bun audit\` wrote an error to stderr (${line}). ${REMEDY}`,
        );
      }
    }
  });

  it("keeps the no-output and invalid-JSON refusals for bun", () => {
    expect(() => parseBunAuditOutput("", 1, `${BUN_BANNER}error: Lockfile not found\n`)).toThrow(
      /produced no output on stdout \(exit 1\)/,
    );
    expect(() => parseBunAuditOutput("{not json", 1, BUN_BANNER)).toThrow(/not valid JSON/);
  });

  it("accepts npm's zero-vulnerability report with exit 0, and a warning on stderr", () => {
    expect(parseNpmAuditOutput(JSON.stringify(NPM_CLEAN), "/tmp/prefix", 0, "npm warn config fixture warning\n")).toEqual(NPM_CLEAN);
  });

  it("accepts an npm report that lists vulnerabilities with exit 1", () => {
    expect(parseNpmAuditOutput(JSON.stringify(NPM_REPORT), "/tmp/prefix", 1, "")).toEqual(NPM_REPORT);
  });

  it("refuses an npm zero-vulnerability report when npm exited non-zero or without a status", () => {
    expect(() => parseNpmAuditOutput(JSON.stringify(NPM_CLEAN), "/tmp/prefix", 1, "")).toThrow(
      `exited 1 but its report lists no vulnerabilities. ${REMEDY}`,
    );
    expect(() => parseNpmAuditOutput(JSON.stringify(NPM_CLEAN), "/tmp/prefix", null, "")).toThrow(
      "ended without an exit status but its report lists no vulnerabilities.",
    );
  });

  it("refuses an npm report when npm's stderr carries an npm error line", () => {
    for (const line of ["npm error audit endpoint returned an error", "npm ERR! code ENOLOCK"]) {
      expect(() => parseNpmAuditOutput(JSON.stringify(NPM_REPORT), "/tmp/prefix", 1, `${line}\n`)).toThrow(
        `wrote an error to stderr (${line}). ${REMEDY}`,
      );
    }
  });
});

// ─── Non-report audit responses (flair#2278) ─────────────────────────────────

describe("audit report refusal", () => {
  it("accepts an npm report with an empty vulnerabilities object", () => {
    expect(npmAuditReportRefusal({ vulnerabilities: {} })).toBeNull();
  });

  it("accepts an empty bun report but refuses a bun error envelope", () => {
    expect(bunAuditReportRefusal({})).toBeNull();
    expect(bunAuditReportRefusal({ error: { code: "EAI_AGAIN" } })).toMatch(/error object/);
  });

  it("refuses a non-object in either stage", () => {
    for (const value of [null, [], "ok", 3]) {
      expect(npmAuditReportRefusal(value)).toMatch(/did not produce a JSON report object/);
      expect(bunAuditReportRefusal(value)).toMatch(/did not produce a JSON report object/);
    }
  });

  it("does not mistake an advisory array on a package named error for an envelope", () => {
    // bun's shape maps a package name to its advisory array; a package literally
    // named "error" is a report, not the error envelope.
    expect(bunAuditReportRefusal({ error: [{ id: 1, url: "" }] })).toBeNull();
  });
});

// ─── The gate itself refuses a non-report response (flair#2278) ──────────────

describe("the gate fails closed on a refused stage answer, stand-in tools (flair#2278)", () => {
  // A minimal fixture: the real gate script, the real allowlist policy with no
  // entries, and stand-in `bun`/`npm` scripts on PATH that print a fixed answer
  // and exit 0. With no entries, a run that gets past both audit stages passes
  // exactly when both report zero advisories, so the stage answer decides the
  // outcome. Before flair#2278 the gate exited 0 on each refused answer below in
  // this fixture. audit-gate-real-tools.test.ts runs the real bun and npm.
  function runGate(bunOut: string, npmOut: string) {
    const root = mkdtempSync(join(tmpdir(), "flair-audit-nonreport-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, ".github"));
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "tmp"));
      writeFileSync(
        join(root, "scripts/audit-gate.mjs"),
        readFileSync(join(REPO_ROOT, "scripts", "audit-gate.mjs")),
      );
      writeFileSync(
        join(root, ".github/audit-allowlist.json"),
        JSON.stringify({ policy: ALLOWLIST.policy, entries: [] }),
      );
      commitAllowlistHistory(root);
      writeFileSync(join(root, "bin/bun"), `#!/bin/sh\nprintf '%s\\n' '${bunOut}'\n`);
      writeFileSync(join(root, "bin/npm"), `#!/bin/sh\nprintf '%s\\n' '${npmOut}'\n`);
      chmodSync(join(root, "bin/bun"), 0o755);
      chmodSync(join(root, "bin/npm"), 0o755);
      const prefixOf = (source: string) => join(root, `prefix-${source}`);
      writeIdentities(root, prefixOf);
      return spawnSync(
        process.execPath,
        [join(root, "scripts", "audit-gate.mjs"), ...prefixArgs(prefixOf)],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            HOME: join(root, "home"),
            TMPDIR: join(root, "tmp"),
            AUDIT_GATE_TODAY: "2026-10-01",
          },
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const CLEAN_BUN = "{}";
  const CLEAN_NPM = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} });

  it("passes on a real zero-advisory report from both stages", () => {
    const res = runGate(CLEAN_BUN, CLEAN_NPM);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PASS —");
  }, 12_000);

  const NPM_NON_REPORTS: Record<string, string> = {
    "an error object": JSON.stringify({ error: { code: "EAI_AGAIN", summary: "offline" } }),
    "a missing vulnerabilities field": JSON.stringify({ auditReportVersion: 2, metadata: {} }),
    "an empty object": "{}",
  };
  for (const [name, out] of Object.entries(NPM_NON_REPORTS)) {
    it(`fails the gate on ${name} from the npm stage`, () => {
      const res = runGate(CLEAN_BUN, out);
      expect(res.error).toBeUndefined();
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("FAILED TO RUN");
      expect(res.stdout).not.toContain("PASS —");
    }, 12_000);
  }

  it("fails the gate on an error object from the bun stage", () => {
    const res = runGate(JSON.stringify({ error: { code: "EAI_AGAIN" } }), CLEAN_NPM);
    expect(res.error).toBeUndefined();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("FAILED TO RUN");
    expect(res.stdout).not.toContain("PASS —");
  }, 12_000);
});

// ─── Registry URL construction ───────────────────────────────────────────────

describe("registryUrlFor", () => {
  const PREFIX = "https://registry.npmjs.org/";

  it("leaves no bare slash in the package segment of a scoped name", () => {
    // The bug this replaced was `pkg.replace("/", "%2F")`, which rewrites only
    // the FIRST match. The assertion is on the resulting segment, not on the
    // call, so it fails for a half-escape as well as for no escape at all.
    const segment = registryUrlFor("@fastify/static").slice(PREFIX.length).replace("/latest", "");
    expect(segment).not.toContain("/");
    expect(segment).toBe("%40fastify%2Fstatic");
  });

  it("escapes every slash, not just the first", () => {
    // A name with two slashes is not valid on npm, but it is exactly the input
    // that distinguishes a complete escape from the original one-shot replace.
    const segment = registryUrlFor("a/b/c").slice(PREFIX.length).replace("/latest", "");
    expect(segment).not.toContain("/");
  });

  it("still builds the expected url for an unscoped name", () => {
    expect(registryUrlFor("lodash")).toBe("https://registry.npmjs.org/lodash/latest");
  });

  it("keeps the /latest suffix as a real path segment", () => {
    expect(registryUrlFor("@scope/pkg").endsWith("/latest")).toBe(true);
  });
});

// ─── Version range logic behind the fixability re-check ──────────────────────

describe("isVulnerable", () => {
  it("handles the comparator sets bun audit actually emits", () => {
    expect(isVulnerable("4.0.3", ">=4.0.0 <4.0.4")).toBe(true);
    expect(isVulnerable("4.0.6", ">=4.0.0 <4.0.4")).toBe(false);
    expect(isVulnerable("7.5.20", "<=7.5.20")).toBe(true);
    expect(isVulnerable("7.5.22", "<=7.5.20")).toBe(false);
    expect(isVulnerable("2.1.9", "<2.2.0")).toBe(true);
    expect(isVulnerable("2.2.2", "<2.2.0")).toBe(false);
    expect(isVulnerable("0.73.1", ">=0.50.0 <=0.73.1")).toBe(true);
    expect(isVulnerable("0.74.0", ">=0.50.0 <=0.73.1")).toBe(false);
    expect(isVulnerable("0.13.1", "<=0.13.1")).toBe(true);
  });

  it("compares numerically, not lexically", () => {
    // "4.17.22" < "4.9.0" as strings; the gate must not believe that.
    expect(isVulnerable("4.18.1", ">=4.0.0 <=4.17.22")).toBe(false);
    expect(isVulnerable("4.9.0", ">=4.0.0 <=4.17.22")).toBe(true);
    expect(isVulnerable("10.1.2", "<=10.1.1")).toBe(false);
    expect(isVulnerable("2.0.12", "<2.0.5")).toBe(false);
  });

  it("sorts a prerelease below its own release", () => {
    expect(isVulnerable("2.2.0-rc.1", "<2.2.0")).toBe(true);
    expect(isVulnerable("2.2.0", "<2.2.0")).toBe(false);
  });

  it("treats an empty range as matching nothing rather than everything", () => {
    // Failing open here would silently allowlist an advisory with no range.
    expect(isVulnerable("1.0.0", "")).toBe(false);
  });
});

// ─── Harper-shipped evidence from a bundle (no shrinkwrap) ───────────────────

describe("vendor-pinned nodes shipped in harper's bundle", () => {
  const fastify = "node_modules/harper/node_modules/fastify";
  const advisory = (pkg: string, node: string, version: string) => ({
    ghsa: "GHSA-w2qp-rph6-63g4",
    package: pkg,
    nodes: [node],
    nodeVersions: { [node]: version },
  });

  type BundleFiles = {
    harper?: Record<string, unknown>;
    lock?: Record<string, unknown>;
    packages?: Record<string, string | Record<string, unknown>>;
    /** Symlinks to create: link path -> target path, both relative to the prefix. */
    links?: Record<string, string>;
    /** Files written verbatim: path relative to the prefix -> contents. */
    raw?: Record<string, string>;
  };

  function withBundlePrefix(files: BundleFiles, run: (prefix: string) => void) {
    const prefix = mkdtempSync(join(tmpdir(), "flair-audit-bundle-"));
    try {
      mkdirSync(join(prefix, "node_modules", "harper"), { recursive: true });
      for (const [path, manifest] of Object.entries(files.packages ?? {})) {
        mkdirSync(join(prefix, path), { recursive: true });
        writeFileSync(
          join(prefix, path, "package.json"),
          JSON.stringify(typeof manifest === "string" ? { version: manifest } : manifest),
        );
      }
      for (const [path, contents] of Object.entries(files.raw ?? {})) {
        mkdirSync(dirname(join(prefix, path)), { recursive: true });
        writeFileSync(join(prefix, path), contents);
      }
      for (const [link, target] of Object.entries(files.links ?? {})) {
        mkdirSync(dirname(join(prefix, link)), { recursive: true });
        symlinkSync(join(prefix, target), join(prefix, link));
      }
      if (files.harper !== undefined) {
        writeFileSync(join(prefix, "node_modules/harper/package.json"), JSON.stringify(files.harper));
      }
      if (files.lock !== undefined) {
        writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({ packages: files.lock }));
      }
      run(prefix);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  }

  it("accepts a node whose package is listed in bundleDependencies", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastify]: { version: "5.12.5", inBundle: true } },
        packages: { [fastify]: "5.12.5" },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix)).toEqual([]),
    );
  });

  it("accepts a scoped package listed by its full name", () => {
    const node = "node_modules/harper/node_modules/@fastify/static";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["@fastify/static"] },
        lock: { [node]: { version: "9.3.0", inBundle: true } },
        packages: { [node]: "9.3.0" },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("@fastify/static", node, "9.3.0"), prefix)).toEqual([]),
    );
  });

  it("accepts a package in harper's dependencies when bundleDependencies is true", () => {
    const node = "node_modules/harper/node_modules/fast-uri";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: true, dependencies: { "fast-uri": "^3.1.0" } },
        lock: { [node]: { version: "3.1.0", inBundle: true } },
        packages: { [node]: "3.1.0" },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("fast-uri", node, "3.1.0"), prefix)).toEqual([]),
    );
  });

  it("refuses a package outside harper's dependencies and their closure when bundleDependencies is true", () => {
    const node = "node_modules/harper/node_modules/left-pad";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: true, dependencies: { fastify: "^5.12.0" } },
        lock: { [node]: { version: "1.3.0", inBundle: true } },
        packages: { [node]: "1.3.0", [fastify]: "5.12.5" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("left-pad", node, "1.3.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain(`"left-pad" is not in harper's dependencies (bundleDependencies is true)`);
      },
    );
  });

  it("accepts a node nested inside a bundled package", () => {
    const node = `${fastify}/node_modules/find-my-way`;
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "9.6.0", inBundle: true } },
        packages: { [node]: "9.6.0", [fastify]: "5.12.5" },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("find-my-way", node, "9.6.0"), prefix)).toEqual([]),
    );
  });

  it("refuses a nested node whose bundled top-level package has no package.json", () => {
    const node = `${fastify}/node_modules/find-my-way`;
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "9.6.0", inBundle: true } },
        packages: { [node]: "9.6.0" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("find-my-way", node, "9.6.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain(`harper's tree has no package.json for "fastify"`);
      },
    );
  });

  it("refuses a nested node whose bundled top-level package.json is not valid JSON", () => {
    const node = `${fastify}/node_modules/find-my-way`;
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "9.6.0", inBundle: true } },
        packages: { [node]: "9.6.0" },
        raw: { [`${fastify}/package.json`]: "{ not json" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("find-my-way", node, "9.6.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain(`harper's package.json for "fastify" cannot be read or parsed`);
      },
    );
  });

  it("refuses a nested node whose bundled top-level package.json is not an object", () => {
    const node = `${fastify}/node_modules/find-my-way`;
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "9.6.0", inBundle: true } },
        packages: { [node]: "9.6.0" },
        raw: { [`${fastify}/package.json`]: "null" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("find-my-way", node, "9.6.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain(`harper's package.json for "fastify" is not a JSON object`);
      },
    );
  });

  it("refuses a nested node whose bundled top-level package.json cannot be read", () => {
    // A directory in the manifest's place (made by writing a file below it): the
    // read fails for every uid, root included.
    const node = `${fastify}/node_modules/find-my-way`;
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "9.6.0", inBundle: true } },
        packages: { [node]: "9.6.0", [`${fastify}/package.json/placeholder`]: "0.0.0" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("find-my-way", node, "9.6.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain(`harper's package.json for "fastify" cannot be read or parsed`);
      },
    );
  });

  it("refuses a top-level copy when the bundled package resolves its own nested copy", () => {
    const node = "node_modules/harper/node_modules/fast-uri";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "3.1.0", inBundle: true } },
        packages: {
          [node]: "3.1.0",
          [fastify]: { name: "fastify", version: "5.12.5", dependencies: { "fast-uri": "^3.0.0" } },
          [`${fastify}/node_modules/fast-uri`]: "3.1.0",
        },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fast-uri", node, "3.1.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain("not listed in harper's bundleDependencies");
      },
    );
  });

  it("refuses a node whose package directory is a symlink out of harper's tree", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastify]: { version: "5.12.5", inBundle: true } },
        packages: { "elsewhere/fastify": "5.12.5" },
        links: { [fastify]: "elsewhere/fastify" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix).join("\n");
        expect(problems).toContain(fastify);
        expect(problems).toContain("node_modules/fastify/package.json resolves outside harper's installed tree");
      },
    );
  });

  it("refuses a node reached only through a bundled package that is a symlink out of harper's tree", () => {
    const node = "node_modules/harper/node_modules/fast-uri";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "3.1.0", inBundle: true } },
        packages: {
          [node]: "3.1.0",
          "elsewhere/fastify": { name: "fastify", version: "5.12.5", dependencies: { "fast-uri": "^3.0.0" } },
        },
        links: { [fastify]: "elsewhere/fastify" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fast-uri", node, "3.1.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain("node_modules/fastify/package.json resolves outside harper's installed tree");
      },
    );
  });

  // In each refusal below, the package.json resolves inside harper's tree and a
  // directory on the way to it resolves outside.
  const findMyWay = `${fastify}/node_modules/find-my-way`;
  const vendored = "node_modules/harper/vendor";

  it("refuses a node whose package directory resolves outside harper's tree", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [findMyWay]: { version: "9.6.0", inBundle: true } },
        packages: { [fastify]: "5.12.5", [`${vendored}/find-my-way`]: "9.6.0" },
        links: {
          "elsewhere/find-my-way/package.json": `${vendored}/find-my-way/package.json`,
          [findMyWay]: "elsewhere/find-my-way",
        },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("find-my-way", findMyWay, "9.6.0"), prefix).join("\n");
        expect(problems).toContain(findMyWay);
        expect(problems).toContain("node_modules/fastify/node_modules/find-my-way resolves outside harper's installed tree");
      },
    );
  });

  it("refuses a node below a node_modules directory that resolves outside harper's tree", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [findMyWay]: { version: "9.6.0", inBundle: true } },
        packages: { [fastify]: "5.12.5", [`${vendored}/find-my-way`]: "9.6.0" },
        links: {
          "elsewhere/node_modules/find-my-way": `${vendored}/find-my-way`,
          [`${fastify}/node_modules`]: "elsewhere/node_modules",
        },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("find-my-way", findMyWay, "9.6.0"), prefix).join("\n");
        expect(problems).toContain(findMyWay);
        expect(problems).toContain("node_modules/fastify/node_modules resolves outside harper's installed tree");
      },
    );
  });

  const fastUri = "node_modules/harper/node_modules/fast-uri";
  const fastifyNeedsAvvio = { name: "fastify", version: "5.12.5", dependencies: { avvio: "^9.0.0" } };
  const avvioNeedsFastUri = { name: "avvio", version: "9.1.0", dependencies: { "fast-uri": "^3.0.0" } };

  it("refuses a node the closure walk reaches through a node_modules directory that resolves outside harper's tree", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastUri]: { version: "3.1.0", inBundle: true } },
        packages: { [fastUri]: "3.1.0", [fastify]: fastifyNeedsAvvio, [`${vendored}/avvio`]: avvioNeedsFastUri },
        links: {
          "elsewhere/node_modules/avvio": `${vendored}/avvio`,
          [`${fastify}/node_modules`]: "elsewhere/node_modules",
        },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fast-uri", fastUri, "3.1.0"), prefix).join("\n");
        expect(problems).toContain(fastUri);
        expect(problems).toContain("node_modules/fastify/node_modules resolves outside harper's installed tree");
      },
    );
  });

  it("refuses a node the closure walk reaches through a package directory that resolves outside harper's tree", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastUri]: { version: "3.1.0", inBundle: true } },
        packages: { [fastUri]: "3.1.0", [fastify]: fastifyNeedsAvvio, [`${vendored}/avvio`]: avvioNeedsFastUri },
        links: {
          "elsewhere/avvio/package.json": `${vendored}/avvio/package.json`,
          [`${fastify}/node_modules/avvio`]: "elsewhere/avvio",
        },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fast-uri", fastUri, "3.1.0"), prefix).join("\n");
        expect(problems).toContain(fastUri);
        expect(problems).toContain("node_modules/fastify/node_modules/avvio resolves outside harper's installed tree");
      },
    );
  });

  it("accepts a node the closure walk reaches through directories inside harper's tree", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastUri]: { version: "3.1.0", inBundle: true } },
        packages: { [fastUri]: "3.1.0", [fastify]: fastifyNeedsAvvio, [`${fastify}/node_modules/avvio`]: avvioNeedsFastUri },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("fast-uri", fastUri, "3.1.0"), prefix)).toEqual([]),
    );
  });

  // The walk selects installed manifests, so closure membership does not depend on what an import can load.
  it("accepts a closure package whose exports expose its manifest but no bare name or imported subpath", () => {
    const node = "node_modules/harper/node_modules/manifest-only";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "1.0.0", inBundle: true } },
        packages: {
          [node]: { name: "manifest-only", version: "1.0.0", exports: { "./package.json": "./package.json" } },
          [fastify]: { name: "fastify", version: "5.12.5", dependencies: { "manifest-only": "*" } },
        },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("manifest-only", node, "1.0.0"), prefix)).toEqual([]),
    );
  });

  it("accepts a subpath-only closure package that the bundled package imports through a subpath", () => {
    const node = "node_modules/harper/node_modules/subpath-only";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "1.0.0", inBundle: true } },
        // fastify's source requires subpath-only/sub; its manifest names the package, which is what the walk reads.
        packages: {
          [node]: { name: "subpath-only", version: "1.0.0", exports: { "./sub": "./sub.js" } },
          [fastify]: { name: "fastify", version: "5.12.5", dependencies: { "subpath-only": "*" } },
        },
        raw: {
          [`${node}/sub.js`]: "module.exports = {};\n",
          [`${fastify}/index.js`]: "module.exports = require('subpath-only/sub');\n",
        },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("subpath-only", node, "1.0.0"), prefix)).toEqual([]),
    );
  });

  it("selects a nested manifest with no loadable entry point over a loadable ancestor, blocking the ancestor's exception", () => {
    const ancestor = "node_modules/harper/node_modules/shadow-pkg";
    const nested = `${fastify}/node_modules/shadow-pkg`;
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [ancestor]: { version: "2.0.0", inBundle: true } },
        packages: {
          [ancestor]: { name: "shadow-pkg", version: "2.0.0", main: "./index.js" },
          [nested]: { name: "shadow-pkg", version: "1.0.0" },
          [fastify]: { name: "fastify", version: "5.12.5", dependencies: { "shadow-pkg": "*" } },
        },
        raw: { [`${ancestor}/index.js`]: "module.exports = {};\n" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("shadow-pkg", ancestor, "2.0.0"), prefix).join("\n");
        expect(problems).toContain(ancestor);
        // The walk never reaches the loadable ancestor, so its vendor-pinned exception is blocked, not granted.
        expect(problems).toContain(
          '"shadow-pkg" is not listed in harper\'s bundleDependencies and is not in a bundled package\'s dependency closure',
        );
      },
    );
  });

  it("refuses when the closure walk passes its lookup limit, counting the bundled packages", () => {
    withBundlePrefix(
      {
        harper: {
          name: "harper",
          version: "5.3.3",
          bundleDependencies: Array.from({ length: 5001 }, (_, i) => `absent-${i}`),
        },
        lock: { [fastify]: { version: "5.12.5", inBundle: true } },
        packages: { [fastify]: "5.12.5" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix).join("\n");
        expect(problems).toContain("exceeded 5000 lookups");
      },
    );
  });

  it("accepts a hoisted dependency of a bundled package", () => {
    const node = "node_modules/harper/node_modules/fast-uri";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "3.1.0", inBundle: true } },
        packages: {
          [node]: "3.1.0",
          [fastify]: { name: "fastify", version: "5.12.5", dependencies: { "fast-uri": "^3.0.0" } },
        },
      },
      (prefix) => expect(vendorPinnedNodeProblems(advisory("fast-uri", node, "3.1.0"), prefix)).toEqual([]),
    );
  });

  it("refuses a node the consumer package-lock does not mark inBundle", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastify]: { version: "5.12.5" } },
        packages: { [fastify]: "5.12.5" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix).join("\n");
        expect(problems).toContain(fastify);
        expect(problems).toContain("does not mark");
        expect(problems).toContain("inBundle");
      },
    );
  });

  it("refuses a node whose top-level package is not named in bundleDependencies", () => {
    const node = "node_modules/harper/node_modules/left-pad";
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [node]: { version: "1.3.0", inBundle: true } },
        packages: {
          [node]: "1.3.0",
          [fastify]: { name: "fastify", version: "5.12.5", dependencies: { "fast-uri": "^3.0.0" } },
        },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("left-pad", node, "1.3.0"), prefix).join("\n");
        expect(problems).toContain(node);
        expect(problems).toContain("not listed in harper's bundleDependencies");
      },
    );
  });

  it("refuses a node whose installed version differs from the package-lock record", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastify]: { version: "5.12.5", inBundle: true } },
        packages: { [fastify]: "5.12.0" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix).join("\n");
        expect(problems).toContain("installed version 5.12.0");
        expect(problems).toContain("consumer package-lock records 5.12.5");
      },
    );
  });

  it("refuses an audit version that differs from the package-lock record", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: { [fastify]: { version: "5.12.5", inBundle: true } },
        packages: { [fastify]: "5.12.5" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.13.0"), prefix).join("\n");
        expect(problems).toContain("audit version 5.13.0");
      },
    );
  });

  it("refuses when harper has neither a shrinkwrap nor a bundle listing", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3" },
        lock: { [fastify]: { version: "5.12.5", inBundle: true } },
        packages: { [fastify]: "5.12.5" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix).join("\n");
        expect(problems).toContain("declares no bundleDependencies");
        expect(problems).toContain("npm-shrinkwrap.json");
      },
    );
  });

  it("refuses a node with no consumer package-lock entry", () => {
    withBundlePrefix(
      {
        harper: { name: "harper", version: "5.3.3", bundleDependencies: ["fastify"] },
        lock: {},
        packages: { [fastify]: "5.12.5" },
      },
      (prefix) => {
        const problems = vendorPinnedNodeProblems(advisory("fastify", fastify, "5.12.5"), prefix).join("\n");
        expect(problems).toContain("has no entry");
      },
    );
  });
});
