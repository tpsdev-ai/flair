import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import {
  isVulnerable,
  validateAllowlist,
  flattenAdvisories,
  flattenNpmAdvisories,
  parseNpmAuditOutput,
  registryUrlFor,
} from "../../scripts/audit-gate.mjs";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ALLOWLIST = JSON.parse(
  readFileSync(join(REPO_ROOT, ".github", "audit-allowlist.json"), "utf8"),
);
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

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

  it("marks harper-pinned npm advisories as npm-install-only (FIXED-FOR-BUN-ONLY)", () => {
    // These are the advisories the npm-install observation surfaces that `bun
    // audit` never sees — harper's npm-shrinkwrap pins them. They must declare
    // sources ["npm-install"] so the gate knows they are fixed for bun only.
    const npmOnly = ALLOWLIST.entries.filter((e) => e.package === "fastify");
    expect(npmOnly.length).toBeGreaterThan(0);
    for (const e of npmOnly) {
      expect(e.sources).toEqual(["npm-install"]);
      expect(e.introducedBy).toMatch(/^harper -> /);
    }
  });

  it("keeps bun-only advisories (lodash) out of the npm-install source", () => {
    // lodash is reported by `bun audit` only; declaring it npm-install would
    // make the gate expect an npm observation that never arrives.
    const lodash = ALLOWLIST.entries.filter((e) => e.package === "lodash");
    expect(lodash.length).toBeGreaterThan(0);
    for (const e of lodash) {
      expect(e.sources).toEqual(["bun"]);
    }
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

  it("returns [] for a clean tree", () => {
    expect(flattenNpmAdvisories({ vulnerabilities: {} })).toEqual([]);
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
    expect(parseNpmAuditOutput('{"vulnerabilities":{}}', "/tmp", 0)).toEqual({ vulnerabilities: {} });
  });
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
