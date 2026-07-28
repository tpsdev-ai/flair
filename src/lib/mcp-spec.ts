// ─── The `@tpsdev-ai/flair-mcp` spec written into client MCP configs ────────
//
// ONE definition of "which flair-mcp does a wired client run", shared by every
// writer. It used to live in src/cli.ts and be applied at exactly ONE of the
// five places that write a spec — src/install/clients.ts hardcoded the bare
// unpinned string in `flairMcpEntry()` (Claude Code fallback / Gemini / Cursor)
// and `tomlSnippet()` (Codex), so every client except the inline Claude Code
// branch was wired unpinned no matter what the CLI's own version resolved to
// (flair#907). A pin that lives next to one call site is a pin the next call
// site forgets; it lives here now so a writer has to go out of its way to be
// unpinned.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The npm package a wired client runs via `npx`. */
export const FLAIR_MCP_PACKAGE = "@tpsdev-ai/flair-mcp";

/** The CLI package whose version is the correct pin (lockstep with flair-mcp). */
const FLAIR_PACKAGE = "@tpsdev-ai/flair";

/** What every version-resolution path reports when it cannot read package.json. */
export const UNKNOWN_VERSION = "unknown";

/**
 * Walk up from `startDir` looking for `@tpsdev-ai/flair`'s own package.json.
 *
 * Deliberately a NAMED search rather than a fixed number of `..` hops: this
 * module is compiled to `dist/lib/mcp-spec.js` while its previous home
 * (src/cli.ts) compiled to `dist/cli.js`, so a hardcoded depth is one
 * refactor away from silently resolving "unknown" — and "unknown" is not a
 * loud failure, it is a downgraded security property (see mcpServerSpec).
 * Checking `name` also means a stray package.json in an intermediate
 * directory can't be mistaken for ours.
 *
 * Exported for tests, which need to exercise the not-found path without
 * corrupting a real install.
 */
export function resolveFlairCliVersion(startDir: string): string {
  let dir = startDir;
  // 8 levels is far more than any real layout needs (dist/lib → package root
  // is 2) while still terminating on a pathological symlink loop.
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg?.name === FLAIR_PACKAGE && typeof pkg.version === "string" && pkg.version) {
        return pkg.version;
      }
    } catch {
      // No package.json here, or unreadable/malformed — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return UNKNOWN_VERSION;
}

let cachedVersion: string | undefined;

/**
 * This CLI's own version — the single source for `--version`, the CLI↔server
 * handshake, `upgrade --check`, and the MCP pin. Cached: the answer cannot
 * change within a process, and several commands ask repeatedly.
 */
export function flairCliVersion(): string {
  if (cachedVersion === undefined) {
    cachedVersion = resolveFlairCliVersion(import.meta.dirname ?? __dirname);
  }
  return cachedVersion;
}

/** True when `version` is usable as a pin. */
export function isResolvedVersion(version: string): boolean {
  return !!version && version !== UNKNOWN_VERSION;
}

/**
 * The `@tpsdev-ai/flair-mcp` spec written into a client's MCP config.
 *
 * PINNED, deliberately. A bare `npx -y @tpsdev-ai/flair-mcp` re-resolves to
 * whatever is currently published on EVERY agent session — so a single bad
 * publish (stolen credentials, a malicious commit that clears review, or a
 * compromised dependency of the MCP package) reaches every wired user
 * silently, with no lockfile and no review step in the path. The postmark-mcp
 * incident was exactly this shape: a legitimate publish by the legitimate
 * owner, propagating for 16 days before anyone noticed. Worse, a yank does
 * not help — unpinned clients keep resolving latest.
 *
 * Our publish side is already hardened (OIDC staged publish, human 2FA at the
 * release gate), but that defends against credential theft, not against a bad
 * version being published legitimately. The consumer side is where that gap
 * closes, and pinning is what closes it: a wired client keeps running the
 * exact version that was current when it was wired, and moving forward
 * becomes a deliberate act.
 *
 * flair and flair-mcp ship in version lockstep from this monorepo, so the
 * running CLI's own version is the correct pin. `flair init` re-run rewires
 * to the then-current version.
 *
 * Falls back to the unpinned spec when the version can't be read — the same
 * condition under which `--version` reports "unknown", i.e. a broken install.
 * That fallback is NOT silent: callers that write a config must surface
 * unpinnedSpecWarning() (flair#907). Quietly substituting a weaker guarantee
 * for a documented one is how a user ends up believing they are pinned.
 */
export function mcpServerSpec(version: string = flairCliVersion()): string {
  return isResolvedVersion(version)
    ? `${FLAIR_MCP_PACKAGE}@${version}`
    : FLAIR_MCP_PACKAGE;
}

/**
 * The warning a config-writing command MUST print when the spec it is about
 * to write cannot be pinned. Returns null in the normal case, so a caller is
 * `const w = unpinnedSpecWarning(); if (w) ...`.
 *
 * Warn rather than refuse: an unresolvable version means a damaged install,
 * and hard-failing `init` there turns "MCP works, but unpinned" into "the
 * user has nothing" — while leaving them no better able to diagnose it. The
 * wiring still has value; the false belief in a pin is what has to go. So the
 * consequence is named explicitly, and the caller is expected to repeat this
 * where the user will still see it once the command finishes.
 */
export function unpinnedSpecWarning(version: string = flairCliVersion()): string | null {
  if (isResolvedVersion(version)) return null;
  return [
    `Could not read Flair's own version, so ${FLAIR_MCP_PACKAGE} is being wired UNPINNED.`,
    `Consequence: every agent session re-resolves it to the latest published version,`,
    `so a future publish reaches this machine with no review step. Normally the spec is`,
    `pinned to the CLI version that wired it.`,
    `Fix: reinstall the CLI (npm i -g ${FLAIR_PACKAGE}) and re-run this command, or edit`,
    `the client config by hand to read "${FLAIR_MCP_PACKAGE}@<version>".`,
  ].join("\n");
}
