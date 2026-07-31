/**
 * doctor-key-decode-classification.test.ts — flair#1023.
 *
 * One unparseable key file used to surface in `flair doctor` twice, under two
 * different explanations, neither of which was the cause:
 *
 *     ⚠️ Embeddings: not verified (probe error: error:1E08010C:DECODER routines::unsupported)
 *        Pass --agent <id> (or set FLAIR_AGENT_ID) so doctor can run a real semantic round-trip.
 *     ⚠️ could not verify agent 'X' registration
 *        (instance unreachable: error:1E08010C:DECODER routines::unsupported)
 *
 * — the second printed six lines under doctor's own "✓ Harper responding".
 *
 * The root cause was structural, not a bad string: authFetch signs and then
 * sends inside one function, so every caller's single `catch` attributed a
 * signing failure to the network. Signing strictly precedes the request, so
 * the phase is knowable at the point of failure; authFetch now raises
 * KeyLoadError for the signing half only.
 *
 * These tests hold the four properties the issue asks for:
 *   1. no cause is attached to an unclassified error;
 *   2. the key-decode class is named, WITH the file that failed;
 *   3. "unreachable" is never claimed after this run saw the instance answer;
 *   4. a remedy is only printed when it could change the outcome.
 *
 * Plus a POSITIVE CONTROL: a healthy key still takes the normal successful
 * path. Without it, every assertion here would also pass with signing
 * unconditionally broken.
 *
 * The malformed fixture is 60 synthetic, deterministic, NON-SECRET bytes —
 * generated from an arithmetic sequence, never a real key — so nothing
 * sensitive can reach this test's failure output. Its shape mirrors the
 * real-world file that produced the report, and it drives the loader down
 * the same last-resort branch: under Node it raises the report's exact
 * `error:1E08010C:DECODER routines::unsupported`; under bun (BoringSSL, which
 * runs this suite) the same branch raises
 * `error:0900006e:PEM routines:...:NO_START_LINE`. Both were probed directly.
 * Assertions here are therefore on the CLASSIFICATION, which is identical
 * across backends — the backend-specific strings are exercised separately
 * from constructed errors.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import {
  authFetch,
  classifyKeyLoadFailure,
  describeKeyLoadFailure,
  KeyLoadError,
} from "../../src/lib/auth-resolve.ts";
import { checkAgentRegistered, verifySemanticSearch } from "../../src/cli.ts";
import { describeAgentGateFinding, embeddingsSkipRemedy } from "../../src/doctor-client.ts";

// The literal string from the issue report — what Node's OpenSSL raises.
// Bun links BoringSSL and words the SAME failure differently, so anything
// asserting on backend-specific text below constructs the error itself.
const DECODER_ERROR = "error:1E08010C:DECODER routines::unsupported";

// Deliberately distinctive ids so resolveKeyPath's real-home lookups
// (~/.flair/keys, ~/.tps/secrets/flair) can never shadow the temp fixture —
// this test must never read or write a real key directory.
const BAD_AGENT = "flair1023-undecodable-agent";
const GOOD_AGENT = "flair1023-healthy-agent";
const BASE_URL = "http://127.0.0.1:19926";

let keysDir: string;
let badKeyPath: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-1023-keys-"));

  // Non-secret, deterministic, and NOT an Ed25519 key in any accepted format.
  badKeyPath = join(keysDir, `${BAD_AGENT}.key`);
  writeFileSync(badKeyPath, Buffer.from(Array.from({ length: 60 }, (_, i) => (i * 37 + 11) & 0xff)));

  // Positive control: a genuinely valid 32-byte seed.
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${GOOD_AGENT}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
});

afterAll(() => {
  rmSync(keysDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── The fixture actually reproduces the reported failure ────────────────────

describe("fixture", () => {
  test("the malformed key reproduces the exact OpenSSL error from the report", async () => {
    // Any fetch at all would mean the failure was NOT purely local.
    globalThis.fetch = (() => {
      throw new Error("network must not be touched when the key cannot load");
    }) as unknown as typeof fetch;

    const err = await authFetch(BASE_URL, BAD_AGENT, badKeyPath, "GET", "/Agent/x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(KeyLoadError);
    const keyErr = err as KeyLoadError;
    // Classified as a key-decode failure under whichever crypto backend is
    // running, and never mistaken for the network.
    expect(keyErr.kind).toBe("decode");
    expect(keyErr.keyPath).toBe(badKeyPath);
    // The backend's own words are passed through verbatim, not paraphrased.
    expect(keyErr.underlying.length).toBeGreaterThan(0);
    expect(keyErr.message).toContain(keyErr.underlying);
  });

  test("both crypto backends' wording for this failure classifies identically", () => {
    // Guards the split that made the test suite (bun) and the shipped CLI
    // (node) disagree: same defect, four different strings.
    const shapes = [
      { code: "ERR_OSSL_UNSUPPORTED", message: DECODER_ERROR },
      { code: "ERR_OSSL_ASN1_WRONG_TAG", message: "error:068000A8:asn1 encoding routines::wrong tag" },
      { code: "ERR_OSSL_NO_START_LINE", message: "error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE" },
      { code: "ERR_OSSL_WRONG_TAG", message: "error:0c0000be:ASN.1 encoding routines:OPENSSL_internal:WRONG_TAG" },
    ];
    for (const s of shapes) {
      expect(classifyKeyLoadFailure(Object.assign(new Error(s.message), { code: s.code }))).toBe("decode");
      // ...and on message alone, for a backend that supplies no code.
      expect(classifyKeyLoadFailure(new Error(s.message))).toBe("decode");
    }
  });
});

// ── 1 + 2: classify, or say nothing — and name the file either way ─────────

describe("classifyKeyLoadFailure", () => {
  test("OpenSSL's DECODER rejection is the decode class (structured code, not message text)", () => {
    const e = Object.assign(new Error(DECODER_ERROR), { code: "ERR_OSSL_UNSUPPORTED" });
    expect(classifyKeyLoadFailure(e)).toBe("decode");
  });

  test("a mis-shaped DER body is also the decode class", () => {
    const e = Object.assign(new Error("error:068000A8:asn1 encoding routines::wrong tag"), {
      code: "ERR_OSSL_ASN1_WRONG_TAG",
    });
    expect(classifyKeyLoadFailure(e)).toBe("decode");
  });

  test("an OpenSSL build that reports no code we know still classifies on the message", () => {
    expect(classifyKeyLoadFailure(new Error(DECODER_ERROR))).toBe("decode");
  });

  test("a missing file is not-found, an unreadable one is unreadable", () => {
    expect(classifyKeyLoadFailure(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("not-found");
    expect(classifyKeyLoadFailure(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("unreadable");
  });

  test("anything unrecognised stays UNKNOWN — the point of the issue", () => {
    // The defect was attaching a confident cause to whatever error arrived.
    // An unrecognised failure must remain unrecognised.
    expect(classifyKeyLoadFailure(new Error("something nobody has seen before"))).toBe("unknown");
    expect(classifyKeyLoadFailure("a bare string")).toBe("unknown");
  });
});

describe("describeKeyLoadFailure", () => {
  test("the decode class names the file AND the expected key type", () => {
    const msg = describeKeyLoadFailure("/keys/agent.key", "decode", DECODER_ERROR);
    expect(msg).toContain("/keys/agent.key");
    expect(msg).toContain("Ed25519");
    expect(msg).toContain(DECODER_ERROR);
  });

  test("the unknown class asserts NO cause — it names the operation and shows the error", () => {
    const msg = describeKeyLoadFailure("/keys/agent.key", "unknown", "some novel failure");
    expect(msg).toContain("/keys/agent.key");
    expect(msg).toContain("some novel failure");
    // No guess about why, and specifically not either of the two wrong ones.
    expect(msg).not.toContain("unreachable");
    expect(msg).not.toContain("--agent");
  });

  test("KeyLoadError.from keeps the path the code already had and used to discard", () => {
    const err = KeyLoadError.from("/keys/agent.key", Object.assign(new Error(DECODER_ERROR), {
      code: "ERR_OSSL_UNSUPPORTED",
    }));
    expect(err.keyPath).toBe("/keys/agent.key");
    expect(err.kind).toBe("decode");
    expect(err.message).toContain("/keys/agent.key");
  });
});

// ── 3: never claim unreachable for a key that would not load ───────────────

describe("checkAgentRegistered with an undecodable key", () => {
  test("reports key-unreadable, names the file, and never says 'unreachable'", async () => {
    globalThis.fetch = (() => {
      throw new Error("network must not be touched when the key cannot load");
    }) as unknown as typeof fetch;

    const reg = await checkAgentRegistered(BASE_URL, BAD_AGENT, keysDir);
    expect(reg.state).toBe("key-unreadable");
    // Requirement 2 — name the file that failed and the key type expected.
    expect(reg.detail).toContain(badKeyPath);
    expect(reg.detail).toContain("Ed25519");
    // The two wrong causes from the report.
    expect(reg.detail).not.toContain("unreachable");
    expect(reg.detail).not.toContain("--agent");
  });

  test("the rendered finding names the file and offers no remedy it cannot deliver", () => {
    const f = describeAgentGateFinding(
      BAD_AGENT,
      "key-unreadable",
      describeKeyLoadFailure(badKeyPath, "decode", DECODER_ERROR),
      { instanceReachable: true },
    );
    expect(f).not.toBeNull();
    expect(f!.icon).toBe("warn");
    expect(f!.isIssue).toBe(false);
    expect(f!.message).toContain(badKeyPath);
    expect(f!.message).not.toContain("unreachable");
    // Requirement 4 — no remedy is better than one that cannot work.
    expect(f!.fixHint).toBeUndefined();
  });
});

// ── 3 (general): the self-inconsistency guard ──────────────────────────────

describe("describeAgentGateFinding reachability guard", () => {
  test("'unreachable' is never asserted once this run already saw the instance answer", () => {
    const f = describeAgentGateFinding("local", "unreachable", "instance unreachable: fetch failed", {
      instanceReachable: true,
    });
    expect(f).not.toBeNull();
    // The old output contradicted doctor's own "✓ Harper responding" tick.
    expect(f!.message).toContain("the instance responded");
    expect(f!.message).toContain("not a connectivity problem");
    expect(f!.isIssue).toBe(false);
  });

  test("without an established reachability fact, 'unreachable' is still reportable", () => {
    // The state is legitimate (a bare 500, a timeout) — the guard suppresses
    // the CONTRADICTION, not the state.
    const f = describeAgentGateFinding("local", "unreachable", "HTTP 500");
    expect(f!.message).toContain("could not verify");
    expect(f!.message).not.toContain("the instance responded");
  });

  test("key-unreadable never counts as an issue; only not-registered does", () => {
    const cases: Array<[Parameters<typeof describeAgentGateFinding>[1], boolean]> = [
      ["registered", false],
      ["no-key", false],
      ["not-registered", true],
      ["unreachable", false],
      ["key-unreadable", false],
    ];
    for (const [state, expectIssue] of cases) {
      expect(describeAgentGateFinding("x", state)?.isIssue ?? false).toBe(expectIssue);
    }
  });
});

// ── 4: a remedy must be able to fix the error it is printed under ──────────

describe("verifySemanticSearch with an undecodable key", () => {
  test("skips with reason 'key-load', names the file, and suppresses the --agent advice", async () => {
    globalThis.fetch = (() => {
      throw new Error("network must not be touched when the key cannot load");
    }) as unknown as typeof fetch;

    const res = await verifySemanticSearch(BASE_URL, BAD_AGENT, keysDir);
    expect(res.state).toBe("skipped");
    const skipped = res as Extract<typeof res, { state: "skipped" }>;
    expect(skipped.reason).toBe("key-load");
    expect(skipped.detail).toContain(badKeyPath);
    expect(skipped.detail).not.toContain("unreachable");
    // The remedy the operator was given for this exact failure. Following it
    // produces the identical error, so it must not be printed.
    expect(embeddingsSkipRemedy(skipped.reason)).toBeNull();
  });
});

describe("embeddingsSkipRemedy", () => {
  test("'--agent' is offered only where it can actually resolve an identity", () => {
    expect(embeddingsSkipRemedy("no-agent")).toContain("--agent");
    expect(embeddingsSkipRemedy("no-key")).toContain("--agent");
  });

  test("no remedy is printed for failures --agent cannot change", () => {
    expect(embeddingsSkipRemedy("key-load")).toBeNull();
    expect(embeddingsSkipRemedy("probe-failed")).toBeNull();
  });
});

// ── POSITIVE CONTROL ───────────────────────────────────────────────────────
//
// Everything above asserts on error branches. If signing were broken outright,
// or if authFetch raised KeyLoadError unconditionally, every one of those
// tests would still pass. These fail in that case.

describe("positive control — a healthy key still takes the normal path", () => {
  test("a valid seed signs and reaches the network, and a 200 reads as registered", async () => {
    let sentAuth: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ id: GOOD_AGENT }), { status: 200 });
    }) as unknown as typeof fetch;

    const reg = await checkAgentRegistered(BASE_URL, GOOD_AGENT, keysDir);
    expect(reg.state).toBe("registered");
    // Proof the request was actually signed and dispatched, not short-circuited.
    expect(sentAuth).toBeDefined();
    expect(sentAuth!.startsWith("TPS-Ed25519 ")).toBe(true);
    expect(describeAgentGateFinding(GOOD_AGENT, reg.state, reg.detail, { instanceReachable: true })).toBeNull();
  });

  test("a genuine transport failure is still reported as unreachable, not as a key problem", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const reg = await checkAgentRegistered(BASE_URL, GOOD_AGENT, keysDir);
    expect(reg.state).toBe("unreachable");
    expect(reg.detail).toContain("instance unreachable");
  });

  test("a healthy key with no agent resolvable still gets the --agent remedy", () => {
    // The advice the issue calls wrong for a decode failure is RIGHT here, and
    // must not have been removed wholesale.
    expect(embeddingsSkipRemedy("no-agent")).toContain("FLAIR_AGENT_ID");
  });
});
