/**
 * pin-write-guard.ts — the ONE decision a direct version writer makes before
 * overwriting an existing wiring entry (flair#1778 slice 2c-i-a2).
 *
 * Spec I1: no writer LOWERS the version of the artifact it writes to unless
 * the user typed that exact lower version on the command line. "Lowers"
 * includes replacing a pinned spec with an unpinned or lower one.
 *
 * Before this, every direct writer (init.ts's ~/.claude.json; clients.ts's
 * JSON / Codex-TOML / pi writers) asked only "does the entry carry the CURRENT
 * spec?" and, on any mismatch, OVERWROTE it with the running CLI's spec —
 * direction-blind. A CLI older than the entry it found (a downgrade, a config
 * shared between installs, a hand-pinned newer version) silently replaced a
 * higher pin with a lower one, and a `@^0.55.0` range / `@latest` tag / `file:`
 * source was treated as merely stale and rewritten.
 *
 * This module reads the EXISTING entry through the a1 `WiringSpec` model
 * (`./wiring-spec.js`) and compares its version token with the running CLI's
 * version through the ONE comparison idiom (`pinWriteWouldLowerOrIsUnknown`,
 * which wraps `comparePinVersions` — `./upgrade-status.js`). It writes NOTHING
 * itself: it decides, and the caller either writes (with the pin returned) or
 * leaves the bytes untouched and surfaces the returned line.
 *
 * Matrix (provision-wiring — pin to the running CLI):
 *   existing version AHEAD of the running CLI   → HOLD (bytes unchanged)
 *   existing version BEHIND                     → write, repin UP
 *   existing version equal                      → write (shape repair, same pin)
 *   unpinned / absent                           → write, pinned to the running CLI
 *   range-or-tag / unsupported / malformed      → HOLD (present, not comparable)
 *   running CLI version unreadable              → REFUSE (nothing written)
 *
 * The REFUSE row is a NAMED intentional change: it replaces the fallback to
 * the UNPINNED spec (mcpServerSpec's `version unknown` branch) at these
 * writers, which would have turned a pinned entry into a weaker one on a
 * broken install. A writer that cannot read its own version now declines to
 * write rather than quietly unpinning. Note the row has a second,
 * non-defect consequence (review carry-over): the same refusal also declines a
 * legitimate FIRST install on a fresh home — nothing is created — until the
 * version can be read again. The refused line names that.
 */
import { isResolvedVersion } from "./mcp-spec.js";
import { pinWriteWouldLowerOrIsUnknown } from "./upgrade-status.js";
import { decodeWiringSpec, isComparableWiringPin, wiringPinString } from "./wiring-spec.js";

export type PinWriteAction = "write" | "hold" | "refuse";

export interface PinWriteDecision {
  /** "write" → proceed (with `pin`); "hold" → leave bytes unchanged; "refuse" → write nothing. */
  action: PinWriteAction;
  /** For "write": the version the caller must pin to (the running CLI's own). */
  pin: string | null;
  /** For "hold" / "refuse": the one line naming the entry, the pinned spec and the running version. */
  line: string | null;
}

export interface PinWriteInput {
  /** The package the entry names, e.g. `@tpsdev-ai/flair-mcp`. */
  pkg: string;
  /** A user-facing label for the entry (used verbatim in the line). */
  entry: string;
  /** The text of the entry being written, or null when the entry is absent. */
  existingText: string | null;
  /** The running CLI's own version (`flairCliVersion()`). */
  runningVersion: string;
}

/** Decide whether a provision-wiring write would lower the entry (or cannot be proven not to). */
export function decidePinWrite(input: PinWriteInput): PinWriteDecision {
  const { pkg, entry, existingText, runningVersion } = input;

  // Running CLI version unreadable → REFUSE by name; nothing is written.
  // (A broken install must not silently downgrade a pinned entry to unpinned.
  // The same refusal also declines a legitimate FIRST install on a fresh home:
  // nothing is created until the version can be read again — named here so the
  // consequence is visible, not a surprise.)
  if (!isResolvedVersion(runningVersion)) {
    return {
      action: "refuse",
      pin: null,
      line:
        `${entry}: REFUSING to write — this CLI cannot read its own version ` +
        `(got "${runningVersion}"), so it cannot pin ${pkg} and must not overwrite the entry ` +
        `unpinned; nothing written. On a fresh home this also declines a legitimate FIRST install ` +
        `(nothing is created) until the version can be read again.`,
    };
  }

  const spec = decodeWiringSpec(existingText ?? "", pkg);

  if (isComparableWiringPin(spec)) {
    const pinned = wiringPinString(spec)!;
    if (pinWriteWouldLowerOrIsUnknown(pinned, runningVersion)) {
      return {
        action: "hold",
        pin: null,
        line: `${entry}: holding — it is pinned to ${pinned}, AHEAD of this CLI ${runningVersion}; never lowering a pin.`,
      };
    }
    // BEHIND or equal → (re)pin UP to the running CLI.
    return { action: "write", pin: runningVersion, line: null };
  }

  if (!spec || spec.token.kind === "none") {
    // Absent, or wired without a version → pin UP to the running CLI (today's MCP policy).
    return { action: "write", pin: runningVersion, line: null };
  }

  // range-or-tag / unsupported / malformed: PRESENT, and not comparable — a
  // fail-closed HOLD that preserves the exact bytes it read.
  return {
    action: "hold",
    pin: null,
    line:
      `${entry}: holding — it names ${wiringPinString(spec)} (a range, tag or unsupported spec), ` +
      `which this CLI cannot prove is not a lowering; bytes preserved.`,
  };
}
