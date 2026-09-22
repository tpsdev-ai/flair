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

/**
 * The token terminators for a `<pkg>@<token>` spec: whitespace, `"`, `'`, `,`,
 * `]` (the delimiters an args array / hook command / TOML line can use).
 */
function isTokenTerminator(ch: string | undefined): boolean {
  return ch === undefined || ch === "" || /\s/.test(ch) || ch === '"' || ch === "'" || ch === "," || ch === "]";
}

/**
 * True when the match at `idx` starts at a token boundary — the start of the
 * text, or a non-identifier character before it. This keeps `<pkg>@` from
 * matching inside a LONGER sibling package name (e.g. `@tpsdev-ai/flair-mcp`
 * inside `@tpsdev-ai/flair-mcp-extra@1.0`), or a name that merely ends with it.
 */
function isTokenStart(s: string, idx: number): boolean {
  if (idx <= 0) return true;
  return !/[A-Za-z0-9_\-.]/.test(s[idx - 1]!);
}

/** Read from `from` up to the first token terminator. */
function readSpecToken(s: string, from: number): string {
  let i = from;
  while (i < s.length && !isTokenTerminator(s[i])) i++;
  return s.slice(from, i);
}

/**
 * Envelope A — every `<pkg>@<token>` occurrence, found by a plain `indexOf`
 * scan (NO dynamic RegExp). One decoder for all of them: an
 * `npx -y -p <pkg>@<spec>` command, an MCP client `args` array, a Codex TOML
 * `args = [...]` line, a SessionStart hook command, or pi's
 * `npm:<pkg>@<spec>` source all reduce to the same `<pkg>@<spec>` substring.
 */
function findPackageSpecs(text: string, pkg: string): Array<{ raw: string; token: string }> {
  const needle = `${pkg}@`;
  const out: Array<{ raw: string; token: string }> = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    if (isTokenStart(text, idx)) {
      const token = readSpecToken(text, idx + needle.length);
      out.push({ raw: needle + token, token });
    }
    from = idx + needle.length;
  }
  return out;
}

/**
 * Envelope B — a dependency field `"pkg": "<spec>"` (package.json), whose
 * value may carry the `workspace:` / `npm:` protocol (`workspace:^0.55.0` →
 * `^0.55.0`). Found by string operations: the quoted key, optional whitespace,
 * `:`, optional whitespace, a `"`, then the value up to the next `"`.
 */
function decodeDependencyField(text: string, pkg: string): WiringSpec | null {
  const key = `"${pkg}"`;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(key, from);
    if (idx === -1) return null;
    if (isTokenStart(text, idx)) {
      let i = idx + key.length;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] === ":") {
        i++;
        while (i < text.length && /\s/.test(text[i]!)) i++;
        if (text[i] === '"') {
          const valueStart = i + 1;
          const end = text.indexOf('"', valueStart);
          if (end === -1) return null;
          return {
            raw: text.slice(idx, end + 1),
            pkg,
            token: partitionWiringToken(stripSpecProtocol(text.slice(valueStart, end))),
          };
        }
      }
    }
    from = idx + key.length;
  }
}

/**
 * Decode ONE wiring string into a WiringSpec, or null when `pkg` is not wired
 * in it. Total: every envelope reduces to `<pkg>@<spec>` or a bare package.
 * A bare package (no `@`) is `kind: "none"` — wired, no token.
 */
export function decodeWiringSpec(text: string, pkg: string): WiringSpec | null {
  if (typeof text !== "string" || !text.includes(pkg)) return null;
  const first = findPackageSpecs(text, pkg)[0];
  if (first) return { raw: first.raw, pkg, token: partitionWiringToken(first.token) };
  const byDep = decodeDependencyField(text, pkg);
  if (byDep) return byDep;
  return { raw: pkg, pkg, token: { kind: "none", value: null } };
}

/**
 * Decode EVERY `<pkg>@<spec>` occurrence in `text` (plus a dependency field
 * when present) — one WiringSpec per entry, never collapsing to the first, in
 * TEXT ORDER. Useful to a caller that must enumerate all wired artifacts
 * (flair#1778 I6).
 */
export function decodeWiringSpecs(text: string, pkg: string): WiringSpec[] {
  if (typeof text !== "string" || !text.includes(pkg)) return [];
  const out: WiringSpec[] = [];
  const seen = new Set<string>();
  for (const spec of findPackageSpecs(text, pkg)) {
    if (seen.has(spec.raw)) continue;
    seen.add(spec.raw);
    out.push({ raw: spec.raw, pkg, token: partitionWiringToken(spec.token) });
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
