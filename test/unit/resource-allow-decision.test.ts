import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * CI backstop for the `authorizeLocal` escalation class (flair#614).
 *
 * ── The bug class ────────────────────────────────────────────────────────
 * Harper's `authorizeLocal: true` (config.yaml) forges `request.user` to a
 * super_user identity for ANY credential-less LOOPBACK request (no
 * Authorization header at all). Harper's own `Resource` base class default
 * is `allowRead/allowCreate/allowUpdate/allowDelete(user) { return
 * user?.role.permission.super_user }` (see
 * node_modules/@harperfast/harper/dist/resources/Resource.js) — so ANY
 * Resource that does not override these methods is, by default, WIDE OPEN
 * to that forged loopback super_user. Seven instances of exactly this
 * pattern were independently found and patched in two weeks: Memory/Soul
 * by-id, the admin console, WorkspaceState/OrgEvent, Presence.currentTask,
 * OAuthAuthorize (#609), IssueTokens + Credential (#612). The discipline
 * (careful review, integration tests) caught each one AFTER the fact — this
 * file is the structural backstop so the NEXT resource can't reintroduce it
 * silently. See #601, #604, #609, #610, #612 for the full history.
 *
 * ── What this file checks ───────────────────────────────────────────────
 * 1. Every exported Resource-like class under resources/*.ts must make an
 *    EXPLICIT allow-decision: it defines its own allowRead/allowCreate/
 *    allowUpdate/allowDelete/allowUpsert, OR it inherits one from a sibling
 *    class in the same file (e.g. `class a2a extends A2AAdapter {}`), OR its
 *    name is on one of the two allowlists below — each of which requires a
 *    conscious, cited edit, not a silent default.
 * 2. Nothing mounted on auth-middleware.ts's public early-return allowlist
 *    (resources/auth-middleware.ts ~L78-128 — requests that skip ALL of our
 *    identity annotation and go straight to the resource) reads raw
 *    `context.user` / `request.user` — the exact anti-pattern behind
 *    #601/#604/#609/#612. Each of those endpoints is checked individually
 *    against what it's SUPPOSED to do instead (self-verify a signature, or
 *    be genuinely identity-free).
 *
 * ── Static analysis, not runtime import ─────────────────────────────────
 * Harper injects `Resource` as a runtime global rather than an npm export
 * (see test/unit/resource-allow.test.ts's header comment for the prior art),
 * so resource classes can't be instantiated in a bun unit-test context. This
 * file parses the .ts SOURCE instead: regex-found `export class X extends Y
 * {` headers + brace-counted bodies. That's a real limitation — a method
 * that computes an allow-decision via some other spelling (a helper that
 * itself returns an allow* function, or reads recognizable text) sits
 * outside what this can see. Where a full static check would be too
 * fragile, this file says so in place rather than pretending otherwise (see
 * NEEDS_HUMAN_REVIEW below and the per-endpoint comments in section 2).
 */

const RESOURCES_DIR = join(import.meta.dir, "..", "..", "resources");
const SRC = (f: string) => readFileSync(join(RESOURCES_DIR, f), "utf8");

// ─── Section 1: every Resource declares an allow-decision ──────────────────

/**
 * Resources that self-declare `allowRead()`/`allowCreate()` returning `true`
 * (or equivalent) ALREADY satisfy the check below on their own — they don't
 * need to appear here. This list is ONLY for resources that currently have
 * NO allow* override of their own anywhere in the prototype chain — i.e.
 * fall through to Harper's default `user?.role.permission.super_user`.
 *
 * IMPORTANT — these are NOT a "these are fine, ship it" sign-off. Under
 * Harper's default, each entry here is reachable by the authorizeLocal-forged
 * loopback super_user (same mechanism as #601/#604/#609/#612) but NOT by a
 * genuine remote unauthenticated caller (Harper's default denies
 * non-super_user). Entries require a conscious, cited addition (a citation +
 * a plan to close it) — SPECIFICALLY so the next person reads this comment
 * instead of rediscovering the bug again — and must be removed the moment
 * the resource gets a real allow* gate.
 *
 * 2026-07-07: the four resources first found here (FederationInstance,
 * FederationPeers, HealthDetail, SkillScan) were gated (allowAdmin /
 * allowVerified as fit each resource's sensitivity — see Federation.ts,
 * health.ts, SkillScan.ts) and removed from this list; see the flair#614
 * backstop follow-up PR. This list is currently empty — kept as a named,
 * empty Record (rather than deleted) so the mechanism has an obvious home
 * if a future resource genuinely needs this treatment.
 */
const NEEDS_HUMAN_REVIEW: Record<string, string> = {};

/**
 * True public-by-design resources go here ONLY if they do NOT already
 * self-declare (none currently do — every resource Flint's spec named as
 * "legitimately public" — Health, A2AAdapter (GET), AgentCard,
 * FederationSync, FederationPair, the OAuth public endpoints,
 * ObservationCenter, Presence — already has its own `allowRead()`/
 * `allowCreate() { return true }`, so the check below passes them without
 * needing an allowlist entry). Kept as an empty, named list (rather than
 * omitted) so the NEXT deliberately-public resource has an obvious place to
 * land instead of reaching for NEEDS_HUMAN_REVIEW.
 */
const DELIBERATELY_PUBLIC_NO_SELF_GATE: Record<string, string> = {};

const ALLOW_METHOD_RE = /\ballow(Read|Create|Update|Delete|Upsert|Connect)\s*\(/;

/** Strip block + line comments so comment-only mentions of `allowRead` etc. don't count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

interface ClassDecl {
  name: string;
  extends: string;
  body: string; // comment-stripped body, braces-matched
}

/** Find `export class X extends Y { ... }` declarations with brace-matched bodies. */
function findClasses(rawSrc: string): ClassDecl[] {
  const src = stripComments(rawSrc);
  const headerRe = /export\s+class\s+(\w+)\s+extends\s+([^{]+?)\s*\{/g;
  const out: ClassDecl[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(src))) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push({ name: m[1], extends: m[2].trim(), body: src.slice(bodyStart, i - 1) });
  }
  return out;
}

/** Harper Resource base, or an auto-generated `(databases as any).flair.X` table base. */
function extendsResourceLikeBase(expr: string): boolean {
  return expr === "Resource" || /^\(databases as any\)\.\w+\.\w+$/.test(expr) || /^databases\.\w+\.\w+$/.test(expr);
}

interface ResourceCheck {
  file: string;
  name: string;
  hasOwnAllow: boolean;
  extends: string;
}

function collectResourceClasses(): ResourceCheck[] {
  const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const results: ResourceCheck[] = [];

  for (const file of files) {
    const src = SRC(file);
    const classes = findClasses(src);
    const byName = new Map(classes.map((c) => [c.name, c]));

    for (const c of classes) {
      // Resolve whether this class is actually a Harper Resource: either its
      // extends target IS a Resource-like base, or (transitively, within the
      // same file) it extends another class we've already recognized as one.
      const isResource = extendsResourceLikeBase(c.extends) || (byName.has(c.extends) && isResourceTransitive(c.extends, byName, new Set()));
      if (!isResource) continue;

      const hasOwnAllow = ALLOW_METHOD_RE.test(c.body);
      results.push({ file, name: c.name, hasOwnAllow, extends: c.extends });
    }
  }
  return results;
}

function isResourceTransitive(name: string, byName: Map<string, ClassDecl>, seen: Set<string>): boolean {
  if (seen.has(name)) return false; // cycle guard
  seen.add(name);
  const c = byName.get(name);
  if (!c) return false;
  if (extendsResourceLikeBase(c.extends)) return true;
  return byName.has(c.extends) && isResourceTransitive(c.extends, byName, seen);
}

describe("every Resource under resources/*.ts declares an explicit allow-decision", () => {
  const classes = collectResourceClasses();
  const byName = new Map(classes.map((c) => [c.name, c]));

  it("found a non-trivial number of Resource classes (sanity check on the parser itself)", () => {
    // If this drops near zero, the regex/brace-matcher broke, not the codebase.
    expect(classes.length).toBeGreaterThan(40);
  });

  for (const c of classes) {
    it(`${c.file}: ${c.name} declares (or inherits, or is allowlisted) an allow-decision`, () => {
      if (c.hasOwnAllow) {
        expect(c.hasOwnAllow).toBe(true);
        return;
      }

      // Empty/trivial-body subclass of a sibling Resource in the same file
      // (e.g. `class a2a extends A2AAdapter {}`) — inherit the parent's
      // verdict rather than demanding a redundant re-declaration.
      const parent = byName.get(c.extends);
      if (parent?.hasOwnAllow) return;

      const onAllowlist = c.name in NEEDS_HUMAN_REVIEW || c.name in DELIBERATELY_PUBLIC_NO_SELF_GATE;
      expect(
        onAllowlist,
        `${c.name} (${c.file}) has NO allowRead/allowCreate/allowUpdate/allowDelete anywhere in its ` +
        `chain, and isn't on NEEDS_HUMAN_REVIEW or DELIBERATELY_PUBLIC_NO_SELF_GATE in this test file. ` +
        `Under Harper's default (Resource.js: "return user?.role.permission.super_user"), this resource ` +
        `is reachable by ANY credential-less loopback request via authorizeLocal's forged super_user — ` +
        `the exact class of bug in #601/#604/#609/#612. Add an explicit allow* method, or if this is ` +
        `genuinely meant to be public, add it to DELIBERATELY_PUBLIC_NO_SELF_GATE with a citation.`,
      ).toBe(true);
    });
  }
});

// ─── Section 2: auth-middleware's public early-return allowlist ────────────

/**
 * Mirror of auth-middleware.ts's early-return pathname list (~L78-128 as of
 * 2026-07-07). KEEP IN SYNC — if that list changes, update this one; a
 * mismatch means this section is silently checking the wrong surface.
 * Anything reaching a resource via one of these paths gets NONE of the
 * `tpsAgent`/`tpsAnonymous` annotation the general middleware path provides,
 * so the resource is entirely on its own for identity — it must either
 * self-verify (signature / token) or genuinely not need identity at all.
 */
const EARLY_RETURN_ENDPOINTS: Array<{ path: string; file: string; className: string; note: string }> = [
  { path: "/health, /Health", file: "health.ts", className: "Health", note: "genuinely identity-free — returns only {ok:true}" },
  { path: "GET /a2a, /A2AAdapter*", file: "A2AAdapter.ts", className: "A2AAdapter", note: "public agent-card metadata; POST is NOT early-returned and goes through the general middleware path" },
  { path: "/AgentCard*", file: "AgentCard.ts", className: "AgentCard", note: "public discovery metadata, per A2A spec" },
  { path: "/FederationSync", file: "Federation.ts", className: "FederationSync", note: "self-verifies via verifyBodySignatureFresh (Ed25519 body signature + anti-replay)" },
  { path: "/FederationPair", file: "Federation.ts", className: "FederationPair", note: "self-verifies via verifyBodySignatureFresh + one-time PairingToken" },
  { path: "/OAuthRegister", file: "OAuth.ts", className: "OAuthRegister", note: "OAuth 2.1 dynamic client registration — spec requires no pre-auth" },
  { path: "/OAuthAuthorize", file: "OAuth.ts", className: "OAuthAuthorize", note: "#609 fix: post() requires a real Authorization header present before trusting resolveAgentAuth" },
  { path: "/OAuthToken", file: "OAuth.ts", className: "OAuthToken", note: "authenticates via PKCE verifier / client_secret in the body, not agent identity" },
  { path: "/OAuthRevoke", file: "OAuth.ts", className: "OAuthRevoke", note: "OAuth 2.1 revocation — token itself is the credential" },
  { path: "/.well-known/oauth-authorization-server, /OAuthMetadata", file: "OAuth.ts", className: "OAuthMetadata", note: "static, non-secret discovery document" },
  { path: "/ObservationCenter", file: "ObservationCenter.ts", className: "ObservationCenter", note: "static HTML shell only; its own JS authenticates each subsequent API call" },
  { path: "GET /Presence", file: "Presence.ts", className: "Presence", note: "#592 fix: get()'s currentTask field gates on verifyAgentRequest (a real Ed25519 signature), NOT resolveAgentAuth/context.user — authorizeLocal can forge the latter but not the former" },
];

/**
 * The anti-pattern: reading Harper's raw `request.user` / `context.user`
 * directly for an auth decision. authorizeLocal can forge this on ANY
 * credential-less loopback request; a real Authorization header (Basic or
 * TPS-Ed25519) is the only thing it can't fake. resolveAgentAuth() also
 * ultimately reads `context.user` (agent-auth.ts), but that's the sanctioned
 * SINGLE place allowed to — hence this check runs against the resource
 * files themselves, not the shared auth helpers.
 *
 * LIMITATION (honest, per the issue's own ask): this is a source-text grep,
 * not a real dataflow/taint analysis. It cannot see a raw `.user` read
 * laundered through an intermediate variable or a project-local helper
 * outside agent-auth.ts/ed25519-auth.ts. It catches the literal pattern that
 * caused #601/#604/#609/#612 (a direct `context.user`/`request.user` read in
 * the resource file) and no more than that.
 */
const RAW_USER_ACCESS_RE = /\b(context|ctx|request|req)\.user\b/;

describe("auth-middleware's public early-return allowlist doesn't read raw context.user", () => {
  // De-dupe files (several endpoints share OAuth.ts / Federation.ts) so we
  // don't grep + report the same file N times.
  const files = [...new Set(EARLY_RETURN_ENDPOINTS.map((e) => e.file))];

  for (const file of files) {
    it(`${file} contains no raw context.user / request.user read`, () => {
      const commentFree = stripComments(SRC(file));
      const found = RAW_USER_ACCESS_RE.test(commentFree);
      expect(
        found,
        `${file} reads raw context.user/request.user — this is the exact anti-pattern behind ` +
        `#601/#604/#609/#612. A credential-less loopback request forges this via authorizeLocal. ` +
        `Use resolveAgentAuth()/verifyAgentRequest() (which check for a real header first) instead, ` +
        `or self-verify a signature/token directly.`,
      ).toBe(false);
    });
  }

  // Positive check, per endpoint: each one does what its `note` above says
  // instead of relying on ambient trust. Specific per-endpoint assertions
  // catch drift (e.g. someone swapping verifyAgentRequest for resolveAgentAuth
  // on /Presence, which would silently reopen #592) that a generic
  // "uses SOME auth helper" OR-check would miss.
  it("Health.allowRead/get is unconditionally public (no auth helper needed)", () => {
    const body = stripComments(SRC("health.ts"));
    expect(/allowRead\s*\([^)]*\)\s*\{\s*return true/.test(body)).toBe(true);
  });

  it("A2AAdapter self-declares public GET (allowRead returns true)", () => {
    const body = stripComments(SRC("A2AAdapter.ts"));
    expect(/allowRead\s*\(\s*\)\s*\{\s*return true/.test(body)).toBe(true);
  });

  it("AgentCard self-declares public GET (allowRead returns true)", () => {
    const body = stripComments(SRC("AgentCard.ts"));
    expect(/allowRead\s*\(\s*\)\s*:\s*boolean\s*\{\s*return true/.test(body) || /allowRead\s*\(\s*\)\s*\{\s*return true/.test(body)).toBe(true);
  });

  it("FederationSync + FederationPair self-verify via verifyBodySignatureFresh", () => {
    const body = stripComments(SRC("Federation.ts"));
    expect(body.includes("verifyBodySignatureFresh(")).toBe(true);
  });

  it("OAuthAuthorize requires a real Authorization header before trusting resolveAgentAuth (#609 regression guard)", () => {
    const body = stripComments(SRC("OAuth.ts"));
    // The #609 fix: post() reads the Authorization header itself and 401s
    // if it's absent, BEFORE calling resolveAgentAuth. Losing either half
    // of this reopens the forged-admin-approval hole.
    expect(/authHeader/.test(body)).toBe(true);
    expect(body.includes("resolveAgentAuth(")).toBe(true);
  });

  it("ObservationCenter serves static HTML only (no db/user lookups in get())", () => {
    const body = stripComments(SRC("ObservationCenter.ts"));
    expect(body.includes("readFileSync") || body.includes("HTML")).toBe(true);
    expect(/databases/.test(body)).toBe(false);
  });

  it("Presence.get() gates currentTask on verifyAgentRequest, not resolveAgentAuth (#592 regression guard)", () => {
    const body = stripComments(SRC("Presence.ts"));
    expect(body.includes("verifyAgentRequest(")).toBe(true);
  });
});
