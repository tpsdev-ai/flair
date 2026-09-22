/**
 * wiring-spec.ts — the interim wiring-spec model (flair#1778 slice 2c-i-a1).
 *
 * ONE decoder + ONE partition for "what version does this wiring entry name?",
 * replacing the extractor that reported a range/tag/unsupported source as
 * `null` — i.e. as if the entry were ABSENT. That null is the bug: every guard
 * downstream reads `null` as "no pin to protect" and OVERWRITES the spec (a
 * `@^0.55.0` range, a `@latest` tag, a `file:` source).
 *
 * A LEAF module on purpose: it imports only `semver` and `isStrictSemver`
 * (`./npm-registry.js`), so every consumer — doctor-client.ts (which owns the
 * old extractor), owned-pins.ts, install/clients.ts — can migrate to it with
 * no import cycle now or later.
 *
 * This PR adds the type and migrates consumers. It does NOT add the writers'
 * guards (that is 2c-i-a2). The one behaviour change here is deliberate and
 * named: a range/tag/unsupported/malformed spec is now PRESENT-BUT-
 * NOT-COMPARABLE instead of null-therefore-absent; `version` and `none` tokens
 * keep every caller's current outcome.
 *
 * ─── Partition rule (each step total, evaluated in this order) ─────────────
 *   1. the spec's source is `file:` / `link:` / `git:` / `git+https:` /
 *      `github:` / `http(s):`                              → `unsupported`
 *   2. no token after `@` (or nothing after `npm:`/`workspace:`)  → `none`
 *   3. the token matches /^v\d/                            → `malformed`
 *      (checked BEFORE range recognition: semver's `validRange` ACCEPTS
 *       `v0.55.0`, so a range test first would misclassify it. The leading `v`
 *       is NOT normalised away — it is exactly what makes the token
 *       non-canonical, and normalising it is how `@v0.55.0` used to be read
 *       as the version `0.55.0`.)
 *   4. `isStrictSemver(token)`                             → `version`
 *      (strict `X.Y.Z[-prerelease][+build]`, no leading `v`; a prerelease like
 *       `0.56.0-rc.1` IS a version.)
 *   5. `semver.validRange(token)` or a dist-tag word
 *      (`latest` / `next` / `*`)                           → `range-or-tag`
 *      (this catches `0.55`, `~0.55`, `^0.55.0`, `>=1 <2`.)
 *   6. anything else (a 4-part `1.2.3.4`, garbage)          → `malformed`
 *
 * `raw` is always kept, so a consumer can preserve the exact bytes it read.
 */
import semver from "semver";
import { isStrictSemver } from "./npm-registry.js";

export type WiringTokenKind = "version" | "range-or-tag" | "unsupported" | "none" | "malformed";

export interface WiringToken {
  kind: WiringTokenKind;
  /** The token text for `version`/`range-or-tag`/`unsupported`/`malformed`; null for `none`. */
  value: string | null;
}

export interface WiringSpec {
  /** The exact wiring substring this was decoded from (or the package name for a bare spec). */
  raw: string;
  /** The package this spec is for, or null when the caller passed no package. */
  pkg: string | null;
  token: WiringToken;
}

/** A source spec that is never an installable version pin. */
const UNSUPPORTED_SOURCE_RE = /^(?:file:|link:|git:|git\+https:|git\+ssh:|github:|https?:)/;

/** The dist-tag words npm resolves by name, plus the `*` wildcard. */
const DIST_TAG_WORDS = new Set(["latest", "next", "*"]);

/** Strip the `workspace:` / `npm:` protocol from a dependency-field value. */
function stripSpecProtocol(spec: string): string {
  return spec.replace(/^(?:workspace|npm):/, "");
}

/** Partition one decoded spec token. Total; see the module doc for the rule. */
export function partitionWiringToken(rawToken: string): WiringToken {
  const token = (rawToken ?? "").trim();
  if (UNSUPPORTED_SOURCE_RE.test(token)) return { kind: "unsupported", value: token };
  if (token === "") return { kind: "none", value: null };
  if (/^v\d/.test(token)) return { kind: "malformed", value: token };
  if (isStrictSemver(token)) return { kind: "version", value: token };
  if (DIST_TAG_WORDS.has(token) || semver.validRange(token) !== null) {
    return { kind: "range-or-tag", value: token };
  }
  return { kind: "malformed", value: token };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Envelope A — a package spec `pkg@<spec>`, wherever it appears in a wiring
 * string: an `npx -y -p <pkg>@<spec>` command, an MCP client `args` array, a
 * Codex TOML `args = [...]` line, a SessionStart hook command, or pi's
 * `npm:<pkg>@<spec>` source. One total decoder for all of them, because they
 * all reduce to the same `<pkg>@<spec>` substring.
 */
function decodePackageSpec(text: string, pkg: string): WiringSpec | null {
  const at = new RegExp(`${escapeRe(pkg)}@([^\\s"',\\]]*)`).exec(text);
  if (!at) return null;
  return { raw: at[0], pkg, token: partitionWiringToken(at[1] ?? "") };
}

/**
 * Envelope B — a dependency field `"pkg": "<spec>"` (package.json), whose value
 * may carry the `workspace:` / `npm:` protocol (`workspace:^0.55.0` →
 * `^0.55.0`).
 */
function decodeDependencyField(text: string, pkg: string): WiringSpec | null {
  const dep = new RegExp(`"${escapeRe(pkg)}"\\s*:\\s*"([^"]*)"`).exec(text);
  if (!dep) return null;
  return { raw: dep[0], pkg, token: partitionWiringToken(stripSpecProtocol(dep[1] ?? "")) };
}

/**
 * Decode ONE wiring string into a WiringSpec, or null when `pkg` is not wired
 * in it. Total: every envelope reduces to `<pkg>@<spec>` or a bare package.
 * A bare package (no `@`) is `kind: "none"` — wired, no token.
 */
export function decodeWiringSpec(text: string, pkg: string): WiringSpec | null {
  if (typeof text !== "string" || !text.includes(pkg)) return null;
  const byPkg = decodePackageSpec(text, pkg);
  if (byPkg) return byPkg;
  const byDep = decodeDependencyField(text, pkg);
  if (byDep) return byDep;
  return { raw: pkg, pkg, token: { kind: "none", value: null } };
}

/**
 * Decode EVERY `pkg@<spec>` occurrence in `text` (plus a dependency field when
 * present) — one WiringSpec per entry, never collapsing to the first. Useful to
 * a caller that must enumerate all wired artifacts (flair#1778 I6).
 */
export function decodeWiringSpecs(text: string, pkg: string): WiringSpec[] {
  if (typeof text !== "string" || !text.includes(pkg)) return [];
  const out: WiringSpec[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(`${escapeRe(pkg)}@([^\\s"',\\]]*)`, "g"))) {
    const key = m[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: m[0], pkg, token: partitionWiringToken(m[1] ?? "") });
  }
  const dep = decodeDependencyField(text, pkg);
  if (dep && !seen.has(dep.raw)) out.push(dep);
  if (out.length === 0) out.push({ raw: pkg, pkg, token: { kind: "none", value: null } });
  return out;
}

/**
 * The pin string a consumer should treat as "what this wiring names".
 *
 *   version                 → the version (compares as today)
 *   none (unpinned/absent)  → null (today's outcome: nothing to protect)
 *   range-or-tag / unsupported / malformed
 *                           → the token text — PRESENT, and not comparable.
 *
 * The last line is the whole point: feeding that text to
 * `pinWriteWouldLowerOrIsUnknown` makes `comparePinVersions` return null, so the
 * fail-closed guard HOLDS. Before this, those specs yielded null, which the
 * guard reads as "absent — safe to write", and the entry was overwritten.
 */
export function wiringPinString(spec: WiringSpec | null): string | null {
  if (!spec) return null;
  if (spec.token.kind === "none") return null;
  return spec.token.value ?? spec.raw;
}

/** True when the spec names a concrete, comparable version. */
export function isComparableWiringPin(spec: WiringSpec | null): boolean {
  return spec?.token.kind === "version";
}
