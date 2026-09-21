/**
 * upgrade-status.ts — the single definition of `flair upgrade`'s per-package
 * status: the state set, the direction-aware classifier that produces it, and
 * the renderers that print it (flair#1778 slice 1).
 *
 * Why this module exists: the status set and its rendering were duplicated
 * between src/cli.ts and src/commands/upgrade.ts. src/commands/upgrade.ts may
 * not import src/cli.ts (its header says so), so the shared set lives here and
 * both import it — one definition, no drift.
 *
 * Direction matters now. Before #1778 the classifier was a bare equality test
 * (`installed === latest ? "current" : "outdated"`), so an install AHEAD of the
 * registry's `latest` tag (a staged / never-promoted version, e.g. 0.55.0 while
 * `latest` is still 0.54.2) was classified "outdated" and rendered with an
 * upgrade arrow to a LOWER version — and a plain `flair upgrade` would then
 * install it. "ahead" is that fourth direction and it never carries a remedy.
 */
import semver from "semver";
import { FLAIR_MCP_PACKAGE } from "./mcp-spec.js";

export type UpgradeStatus =
  | "current"   // installed version equals registry latest
  | "ahead"     // installed version is NEWER than registry latest (no upgrade, no remedy)
  | "outdated"  // installed version is older than latest
  | "unknown"   // installed version could not be parsed (render the raw string, never "outdated")
  | "missing"   // not detected; default packages -> install advised
  | "optional"; // openclaw plugin; openclaw isn't installed (don't nag)

/** The direction-only outcome for a KNOWN (non-null) installed version. */
export type KnownVersionStatus = "current" | "ahead" | "outdated" | "unknown";

/**
 * Classify an installed version against registry `latest`, direction-aware.
 *
 *   installed >  latest  -> "ahead"    (staged / pre-release; never an upgrade target)
 *   installed === latest -> "current"
 *   installed <  latest  -> "outdated"
 *   unparseable          -> "unknown"  (never "outdated", never dropped)
 *
 * Never throws: a throw here would be swallowed by the listing's broad
 * `catch {}` and drop the package silently. Non-semver input is a returned
 * "unknown", not an exception.
 */
export function classifyInstalledVersion(installed: string, latest: string): KnownVersionStatus {
  if (!semver.valid(installed) || !semver.valid(latest)) return "unknown";
  if (semver.gt(installed, latest)) return "ahead";
  if (semver.eq(installed, latest)) return "current";
  return "outdated";
}

/**
 * Icon for a status line. "ahead" uses the affirmative (✅) class, NOT the ⬆️
 * upgrade arrow — an install ahead of latest is not an upgrade.
 */
export function upgradeStatusIcon(status: UpgradeStatus): string {
  switch (status) {
    case "current":
    case "ahead":
      return "✅";
    case "outdated":
      return "⬆️";
    case "optional":
      return "○";
    case "unknown":
    case "missing":
      return "❔";
  }
}

/**
 * Whether a package's status line should be printed in the default `flair
 * upgrade` listing. Suppresses optional-because-openclaw-is-absent lines — pure
 * noise on machines without openclaw — unless `--all` (showAll) is set. All
 * other statuses always print.
 */
export function shouldPrintUpgradeLine(status: UpgradeStatus, showAll: boolean): boolean {
  if (status === "optional" && !showAll) return false;
  return true;
}

/**
 * The human-readable suffix for a package status line in `flair upgrade` /
 * `flair upgrade --check` output.
 *
 * "ahead" and "unknown" carry NO remedy: an install ahead of latest is not
 * nudged anywhere (flair#1778), and an unparseable version renders inline.
 *
 * flair-mcp is zero-install via npx — its suffix must never suggest a global
 * install (flair#1168).
 */
export function upgradeStatusSuffix(name: string, status: UpgradeStatus): string {
  if (status === "current") return " (current)";
  if (status === "ahead" || status === "unknown") return "";
  if (status === "missing") {
    return name === FLAIR_MCP_PACKAGE
      ? " (zero-install via npx — run: flair doctor --fix)"
      : " (run: npm install -g)";
  }
  if (status === "optional") return " (install via: openclaw plugins install @tpsdev-ai/openclaw-flair)";
  // flair-mcp is refreshed by re-pinning its wiring, never `npm install -g` —
  // a global bin does nothing for an `npx -y -p @tpsdev-ai/flair-mcp`
  // invocation (flair#1208). The re-pin is `flair upgrade`'s own job (the
  // #1135/#1167 pin refresh) — never advise `doctor --fix` for it
  // (flair#1324).
  if (status === "outdated" && name === FLAIR_MCP_PACKAGE) {
    return " (npx-wired — flair upgrade refreshes the pin)";
  }
  return "";
}

export interface UpgradeStatusLine {
  name: string;
  /** Raw installed version string, or null when the package is not detected. */
  installed: string | null;
  latest: string;
  status: UpgradeStatus;
  /** Pre-computed remedy suffix (upgradeStatusSuffix); ignored for ahead/unknown. */
  suffix?: string;
}

/**
 * The full listing line for one package. "ahead" renders with NO arrow and NO
 * remedy: `<installed> (ahead of latest <latest>)`. "unknown" renders the raw
 * string with no arrow and no remedy.
 */
export function formatUpgradeStatusLine(line: UpgradeStatusLine): string {
  const icon = upgradeStatusIcon(line.status);
  if (line.status === "ahead") {
    return `  ${icon} ${line.name}: ${line.installed ?? "unknown"} (ahead of latest ${line.latest})`;
  }
  if (line.status === "unknown") {
    return `  ${icon} ${line.name}: ${line.installed ?? "unknown"} (unknown)`;
  }
  const label = line.installed
    ?? (line.status === "optional" ? "not installed (openclaw not detected)" : "not detected");
  return `  ${icon} ${line.name}: ${label} → ${line.latest}${line.suffix ?? ""}`;
}

/**
 * True when writing `next` over `existing` would LOWER the value (a downgrade).
 * False when either side is absent or not strict semver — a comparison we
 * cannot make is not a downgrade, so a pin is only ever held on a proven drop.
 *
 * Used by the post-install pin refresh (flair#1778 D4): the refresh must never
 * rewrite an owned pin to a LOWER version, even when an unrelated package did
 * upgrade.
 */
export function isPinDowngrade(existing: string | null | undefined, next: string | null | undefined): boolean {
  if (!existing || !next) return false;
  if (!semver.valid(existing) || !semver.valid(next)) return false;
  return semver.lt(next, existing);
}
