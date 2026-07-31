import { describe, test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isProbeMode } from "../src/session-start-hook.ts";

/**
 * flair#1007 — probe mode.
 *
 * `flair doctor` needs to answer "does the command registered in the harness
 * settings still resolve and execute?" without the side effects of a real run
 * (a bootstrap read and a presence write). FLAIR_HOOK_PROBE makes this binary
 * answer that and nothing else: print the inert payload, exit 0, before stdin
 * is read or any client exists.
 *
 * The predicate is unit-tested directly; the short-circuit is tested by
 * SPAWNING the entry point as its own process, because "it returns before
 * constructing a client" is a property of main(), not of an exported function.
 */

const NOOP = "{}";
/** The hook's ENTRY POINT, spawned as its own process. Deliberately the source
 *  and not dist/: this suite's CI lane builds @tpsdev-ai/flair-client (which
 *  the hook imports by its built dist) but never builds this package, and a
 *  test that needs an artifact CI does not produce is a test that fails for
 *  the wrong reason. The property under test lives in main(), which the
 *  --noCheck TypeScript build does not transform. */
const ENTRY = join(import.meta.dir, "..", "src", "session-start-hook.ts");

const ORIGINAL_AGENT_ID = process.env.FLAIR_AGENT_ID;
afterEach(() => {
  if (ORIGINAL_AGENT_ID === undefined) delete process.env.FLAIR_AGENT_ID;
  else process.env.FLAIR_AGENT_ID = ORIGINAL_AGENT_ID;
});

describe("isProbeMode", () => {
  test("any non-empty value other than '0' enables it", () => {
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "1" })).toBe(true);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "true" })).toBe(true);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "yes" })).toBe(true);
  });

  test("unset, empty or '0' leaves the hook in normal mode", () => {
    // An accidentally-empty variable must not silently disable ambient memory.
    expect(isProbeMode({})).toBe(false);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "" })).toBe(false);
    expect(isProbeMode({ FLAIR_HOOK_PROBE: "0" })).toBe(false);
  });
});

describe("probe mode short-circuits the whole hook (spawned entry point)", () => {
  // If the entry point is not where this file thinks it is, FAIL loudly — an
  // unrun check must never look like a pass.
  test("the hook entry point exists to be probed", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  test("FLAIR_HOOK_PROBE with a real identity → inert output, exit 0, and the key file never opened", () => {
    // Asserted through a SIDE EFFECT rather than a timing margin, so this
    // detects the short-circuit being removed rather than merely being slow.
    //
    // FLAIR_KEY_PATH points at a FIFO. Anything that constructs the Flair
    // client and starts a signed request opens that path for reading, which
    // blocks forever because nothing will ever write to it. So:
    //   probe mode  → never opens it → prints {} and exits 0
    //   normal mode → opens it       → never exits
    // The second leg is the positive control: without it, the first would pass
    // just as happily if the hook had stopped doing anything at all.
    const dir = mkdtempSync(join(tmpdir(), "flair-hook-probe-"));
    const fifo = join(dir, "identity.key");
    try {
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf-8" });
      // A missing mkfifo must FAIL, not silently skip the whole assertion.
      expect(made.status).toBe(0);

      const env = {
        ...process.env,
        FLAIR_AGENT_ID: "probe-test-agent",
        FLAIR_URL: "http://127.0.0.1:1",
        FLAIR_KEY_PATH: fifo,
      };

      const probed = spawnSync(process.execPath, [ENTRY], {
        input: "{}",
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...env, FLAIR_HOOK_PROBE: "1" },
      });
      expect(probed.signal).toBeNull();
      expect(probed.status).toBe(0);
      expect(probed.stdout).toBe(NOOP);

      const normal = spawnSync(process.execPath, [ENTRY], {
        input: "{}",
        encoding: "utf-8",
        timeout: 3_000,
        env: { ...env, FLAIR_HOOK_PROBE: "" },
      });
      expect(normal.status).toBeNull(); // killed at the deadline — it did open the key
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without FLAIR_HOOK_PROBE the binary still no-ops safely (regression guard)", () => {
    // The positive control for the two tests above: probe mode is an ADDITION,
    // it must not have become the only path.
    const res = spawnSync(process.execPath, [ENTRY], {
      input: "{}",
      encoding: "utf-8",
      timeout: 20_000,
      env: { ...process.env, FLAIR_HOOK_PROBE: "", FLAIR_AGENT_ID: "" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(NOOP);
  });
});
