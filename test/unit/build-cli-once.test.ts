/**
 * build-cli-once.test.ts — flair#1807 round 2: the build is BOUNDED and TERMINATED.
 *
 * `ensureCliBuild` used to run an untimed build (and, before that, under a lock
 * that slept with Atomics.wait — which bun's hook timer cannot interrupt, so a
 * slow holder ran the full wait and then failed in a hook-timeout shape). The
 * redesign runs ONE build with `killSignal: "SIGKILL"` and a NAMED timeout.
 *
 * These fixtures drive that path through the test-only `FLAIR_TEST_BUILD_CLI_STUB`
 * hook (inert in production):
 *   - a stub that SLEEPS past N, and
 *   - a stub that TRAPS SIGTERM and sleeps past N.
 * Both must produce the NAMED error within the caller's budget, and must finish
 * at ~N (SIGKILL), NOT at the stub's sleep — i.e. the child did not outlive the
 * timeout. Red against 92e600f6's helper, which has no bounded-termination path.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const N = 1_500;
const STUB_SLEEP_S = 30;

beforeEach(() => {
  process.env.FLAIR_TEST_BUILD_CLI_STUB = "true";
});
afterEach(() => {
  delete process.env.FLAIR_TEST_BUILD_CLI_STUB;
});

/** Run ensureCliBuild with a stub and return {error, elapsedMs}. */
function runWithStub(stub: string): { error: Error | null; elapsedMs: number } {
  process.env.FLAIR_TEST_BUILD_CLI_STUB = stub;
  const started = Date.now();
  let error: Error | null = null;
  try {
    ensureCliBuild({ timeoutMs: N });
  } catch (err) {
    error = err as Error;
  }
  return { error, elapsedMs: Date.now() - started };
}

describe("ensureCliBuild — a build is bounded and TERMINATED (flair#1807)", () => {
  it("a build that sleeps past N → the NAMED error, terminated at ~N (not the stub's sleep)", () => {
    const { error, elapsedMs } = runWithStub(`sleep ${STUB_SLEEP_S}`);
    expect(error, "expected a named build-timeout error").not.toBeNull();
    expect(error!.message).toContain(`build:cli exceeded ${N} ms`);
    // SIGKILL at ~N: nowhere near the stub's 30 s sleep (which a bare SIGTERM
    // would leave running — the measured defect the redesign removes).
    expect(elapsedMs).toBeLessThan(STUB_SLEEP_S * 1000 / 2);
  }, 15_000);

  it("a build that TRAPS SIGTERM and sleeps past N → still the NAMED error at ~N (SIGKILL)", () => {
    const { error, elapsedMs } = runWithStub(`trap '' TERM; sleep ${STUB_SLEEP_S}`);
    expect(error, "expected a named build-timeout error").not.toBeNull();
    expect(error!.message).toContain(`build:cli exceeded ${N} ms`);
    // A SIGTERM-only timeout would hang here for the full sleep; SIGKILL does not.
    expect(elapsedMs).toBeLessThan(STUB_SLEEP_S * 1000 / 2);
  }, 15_000);

  it("a build that exits non-zero → a NAMED step failure (never a silent pass)", () => {
    const { error } = runWithStub("exit 3");
    expect(error).not.toBeNull();
    expect(error!.message).toContain("build:cli step failed");
  }, 15_000);
});
