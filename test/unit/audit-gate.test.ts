import { describe, it, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import {
  isVulnerable,
  validateAllowlist,
  flattenAdvisories,
  flattenNpmAdvisories,
  parseNpmAuditOutput,
  parseBunAuditOutput,
  npmAuditReportRefusal,
  bunAuditReportRefusal,
  registryUrlFor,
  vendorPinnedNodeProblems,
} from "../../scripts/audit-gate.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ALLOWLIST = JSON.parse(
  readFileSync(join(REPO_ROOT, ".github", "audit-allowlist.json"), "utf8"),
);
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");
/**
 * The six consumer-install inputs: the flag, the allowlist source, the package
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
        policy: { maxLifetimeDaysBySeverity: { moderate: 180 } },
        entries: [adk ? {
          ...ALLOWLIST.entries.find((entry: { package: string }) => entry.package === "uuid"),
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

// ─── Allowlist integrity ─────────────────────────────────────────────────────

describe("the committed allowlist", () => {
  it("passes its own schema validation", () => {
    expect(validateAllowlist(ALLOWLIST, new Date("2026-07-27"))).toEqual([]);
  });

  it("gives every entry a reason, an expiry and a removal condition", () => {
    for (const e of ALLOWLIST.entries) {
      expect(e.reason.length).toBeGreaterThan(40);
      expect(e.removeWhen.length).toBeGreaterThan(20);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("caps how long an exception may live, by severity", () => {
    // An unexpirable exception is how the original defect survived.
    const caps = ALLOWLIST.policy.maxLifetimeDaysBySeverity;
    expect(caps.critical).toBeLessThanOrEqual(30);
    for (const e of ALLOWLIST.entries) {
      const days = (Date.parse(e.expires) - Date.parse(e.added)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(caps[e.severity]);
      expect(days).toBeGreaterThan(0);
    }
  });

  it("rejects an entry parked beyond its severity cap", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].severity = "critical";
    bad.entries[0].added = "2026-07-27";
    bad.entries[0].expires = "2027-07-27";
    const problems = validateAllowlist(bad, new Date("2026-07-27"));
    expect(problems.join("\n")).toContain("exceeds the 30d cap");
  });

  it("rejects an entry missing its justification", () => {
    const bad = structuredClone(ALLOWLIST);
    delete bad.entries[0].reason;
    expect(validateAllowlist(bad, new Date("2026-07-27")).join("\n")).toContain(
      'missing required field "reason"',
    );
  });

  it("rejects an entry missing its removal condition", () => {
    const bad = structuredClone(ALLOWLIST);
    delete bad.entries[0].removeWhen;
    expect(validateAllowlist(bad, new Date("2026-07-27")).join("\n")).toContain(
      'missing required field "removeWhen"',
    );
  });

  it("rejects a hand-waved removal condition", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].removeWhen = "later";
    expect(validateAllowlist(bad, new Date("2026-07-27")).join("\n")).toContain(
      "must state the concrete condition",
    );
  });

  it("rejects a duplicate advisory id", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries.push(structuredClone(bad.entries[0]));
    expect(validateAllowlist(bad, new Date("2026-07-27")).join("\n")).toContain("duplicate entry");
  });

  it("rejects an unknown exception class", () => {
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].class = "because-i-said-so";
    expect(validateAllowlist(bad, new Date("2026-07-27")).join("\n")).toContain("unknown class");
  });

  it("accepts the ADK consumer observation as a source and rejects an unknown one (flair#2398)", () => {
    const ok = structuredClone(ALLOWLIST);
    ok.entries[0].sources = ["npm-install-adk"];
    expect(validateAllowlist(ok, new Date("2026-07-27"))).toEqual([]);
    const bad = structuredClone(ALLOWLIST);
    bad.entries[0].sources = ["somewhere-else"];
    expect(validateAllowlist(bad, new Date("2026-07-27")).join("\n")).toContain("unknown source");
  });

  it("carries the ADK consumer-install observation (uuid, flair#2398)", () => {
    const adk = ALLOWLIST.entries.filter((e) => e.sources.includes("npm-install-adk"));
    expect(adk.map((e) => e.ghsa)).toEqual(["GHSA-w5hq-g745-h8pq"]);
  });

  it("marks harper-pinned npm advisories as npm-install-only (NOT-REPORTED-BY-BUN)", () => {
    // These are the advisories the npm-install observation surfaces that `bun
    // audit` never sees — harper's npm-shrinkwrap pins them. They must declare
    // sources ["npm-install"] so the gate knows bun does not report them.
    const npmOnly = ALLOWLIST.entries.filter((e) => e.package === "fast-uri");
    // Exact IDs catch missing or substituted fast-uri advisories.
    expect(npmOnly.map((e) => e.ghsa).sort()).toEqual([
      "GHSA-4c8g-83qw-93j6",
      "GHSA-7p8r-x3mc-p8w7",
      "GHSA-f65p-4m7j-42xc",
      "GHSA-hrr3-gc8f-f4qj",
      "GHSA-jqff-g426-hqxp",
      "GHSA-q3j6-qgpj-74h6",
      "GHSA-qw65-cvwx-89v3",
      "GHSA-v2hh-gcrm-f6hx",
      "GHSA-v39h-62p7-jpjc",
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
