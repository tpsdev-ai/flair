/**
 * Remote principal state changes for flair#2114, socket-free.
 *
 * The remote `--instance` path derives the operations API address with
 * `resolveOpsUrl`, which keeps the instance host but forces the hosted ops port
 * (`HOSTED_OPS_PORT`, 9925) for a string target. A real-socket remote test
 * therefore has to bind 9925 — a port a live Flair may hold — so instead these
 * cases run the real `principal` command in-process with an injected fetch, the
 * pattern test/unit/principal-link.test.ts uses. No server is started and no
 * port is bound.
 */
import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/principal.ts";

const REMOTE_HOST = "127.77.21.14";
const REMOTE_OPS = `http://${REMOTE_HOST}:9925/`;
const REMOTE_INSTANCE = `http://${REMOTE_HOST}:19926`;
/** A decoy ambient target the cases assert is not dialed. A distinct host, not a real bind. */
const SINK = "http://127.0.0.1:9/";
/** The port this file's local-fallback case passes to `--ops-port`. */
const LOCAL_PORT = 41234;
const LOCAL_OPS = `http://127.0.0.1:${LOCAL_PORT}/`;

interface Call { url: string; init: RequestInit; body: any }
interface RunResult { exited: boolean; errors: string; logs: string; calls: Call[]; opsPortArgs: any[] }

const EXIT = "__principal_exit__";
/** Env `flair` reads for target/credential selection; scrubbed to "" per case. */
const ENV_KEYS = ["FLAIR_URL", "FLAIR_TARGET", "FLAIR_OPS_TARGET", "FLAIR_OPS_PORT", "FLAIR_ADMIN_PASS", "FLAIR_ADMIN_USER", "FLAIR_AGENT_ID"];

async function invoke(
  verb: "disable" | "enable",
  flags: string[],
  answer: (call: Call, index: number) => Promise<Response> | Response,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const oldFetch = globalThis.fetch;
  const oldExit = process.exit;
  const oldError = console.error;
  const oldLog = console.log;
  const oldEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const errors: string[] = [];
  const logs: string[] = [];
  const calls: Call[] = [];
  const opsPortArgs: any[] = [];
  try {
    for (const key of ENV_KEYS) process.env[key] = env[key] ?? "";
    process.exit = ((code?: number) => { throw new Error(`${EXIT}:${code}`); }) as typeof process.exit;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      calls.push(call);
      return answer(call, calls.length - 1);
    }) as typeof fetch;
    // The local path asks this resolver for the ops port; record the call and
    // return the port it was given, so the destination is observable.
    bindCli({ resolveOpsPort: (opts: any) => { opsPortArgs.push(opts); return Number(opts?.opsPort); } } as any);
    const cmd = new Command();
    register(cmd);
    let exited = false;
    try { await cmd.parseAsync(["principal", verb, "alice", ...flags], { from: "user" }); }
    catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith(EXIT)) throw err;
      exited = true;
    }
    return { exited, errors: errors.join("\n"), logs: logs.join("\n"), calls, opsPortArgs };
  } finally {
    globalThis.fetch = oldFetch;
    process.exit = oldExit;
    console.error = oldError;
    console.log = oldLog;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** Answers the read/update/read-back sequence with `status`. */
const okFor = (status: string) => (call: Call) => new Response(JSON.stringify(
  call.body.operation === "update"
    ? { update_hashes: [call.body.records[0].id], skipped_hashes: [] }
    : [{ id: call.body.search_value, status }]), { status: 200 });

const args = (verb: "disable" | "enable") => ["--instance", REMOTE_INSTANCE, "--admin-pass", "target-pass-2114"];

describe("principal disable/enable remote instance (#2114)", () => {
  for (const [verb, status, word] of [["disable", "deactivated", "deactivated"], ["enable", "active", "activated"]] as const) {
    test(`${verb}: explicit --instance wins over all ambient targets and confirms ${status}`, async () => {
      const result = await invoke(verb, args(verb), okFor(status), {
        FLAIR_URL: "https://wrong.example", FLAIR_TARGET: SINK, FLAIR_OPS_TARGET: SINK, FLAIR_ADMIN_PASS: "local-secret",
      });
      expect(result.exited).toBe(false);
      expect(result.errors).toBe("");
      expect(result.logs).toContain(`Principal 'alice' ${word}`);
      expect(result.calls.map((c) => c.url)).toEqual(Array(3).fill(REMOTE_OPS));
      expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
      expect(result.calls[1].body.records[0]).toMatchObject({ id: "alice", status });
      expect(result.calls[2].body.search_value).toBe("alice");
      expect(result.calls[0].init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("admin:target-pass-2114").toString("base64")}` });
      expect(result.calls.every((c) => c.init.redirect === "manual" && c.init.signal instanceof AbortSignal)).toBe(true);
    });
  }

  test("FLAIR_URL supplies the instance when --instance is absent", async () => {
    const result = await invoke("disable", ["--admin-pass", "target-pass-2114"], okFor("deactivated"), { FLAIR_URL: REMOTE_INSTANCE, FLAIR_OPS_TARGET: SINK });
    expect(result.exited).toBe(false);
    expect(result.calls.map((c) => c.url)).toEqual(Array(3).fill(REMOTE_OPS));
  });

  test("local fallback uses --ops-port only when no instance is set", async () => {
    const result = await invoke("enable", ["--ops-port", String(LOCAL_PORT), "--admin-pass", "local-pass"], okFor("active"));
    expect(result.exited).toBe(false);
    expect(result.opsPortArgs[0]?.opsPort).toBe(String(LOCAL_PORT));
    expect(result.calls.map((c) => c.url)).toEqual(Array(3).fill(LOCAL_OPS));
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
    expect(result.logs).toContain("Principal 'alice' activated");
  });

  test("empty explicit --instance refuses even when FLAIR_URL and FLAIR_OPS_TARGET are set", async () => {
    const result = await invoke("disable", ["--instance", "", "--admin-pass", "pass"], okFor("deactivated"), { FLAIR_URL: REMOTE_INSTANCE, FLAIR_OPS_TARGET: SINK });
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("--instance is empty");
    expect(result.calls).toHaveLength(0);
  });

  test("remote credential must be explicit even with local env password", async () => {
    const result = await invoke("enable", ["--instance", REMOTE_INSTANCE], okFor("active"), { FLAIR_ADMIN_PASS: "local-secret", FLAIR_OPS_TARGET: SINK });
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("--admin-pass");
    expect(result.calls).toHaveLength(0);
  });

  test("empty explicit remote password never falls back to the local env password", async () => {
    const result = await invoke("disable", ["--instance", REMOTE_INSTANCE, "--admin-pass", ""], okFor("deactivated"), { FLAIR_ADMIN_PASS: "local-secret" });
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("--admin-pass");
    expect(result.calls).toHaveLength(0);
  });

  /** Modes whose read-back disagrees with the requested status (3 requests, not 2). */
  const readBackModes = new Set(["wrong-state", "read-empty", "read-error", "read-other-id"]);
  function modeResponder(mode: string, expected: string) {
    let reads = 0;
    return (call: Call) => {
      if (call.body.operation === "update") {
        const body = mode === "empty-body" ? ""
          : mode === "empty-result" ? "[]"
          : mode === "error-payload" ? '{"error":"secret-response-token"}'
          : JSON.stringify({ update_hashes: [call.body.records[0].id], skipped_hashes: [] });
        return new Response(body, { status: 200 });
      }
      reads++;
      const body = reads === 1 ? JSON.stringify([{ id: call.body.search_value, status: expected }])
        : mode === "read-empty" ? "[]"
        : mode === "read-error" ? '{"error":"secret-response-token"}'
        : JSON.stringify([{ id: mode === "read-other-id" ? "mallory" : call.body.search_value, status: mode === "wrong-state" ? "active" : expected }]);
      return new Response(body, { status: 200 });
    };
  }

  for (const mode of ["empty-body", "empty-result", "error-payload", "wrong-state", "read-empty", "read-error", "read-other-id"] as const) {
    test(`2xx ${mode} never reports success`, async () => {
      const result = await invoke("disable", args("disable"), modeResponder(mode, "deactivated"));
      expect(result.exited).toBe(true);
      expect(result.logs).not.toContain("deactivated");
      expect(result.errors).toContain("Check");
      expect(result.errors).not.toContain("secret-response-token");
      const readBack = readBackModes.has(mode);
      expect(result.calls.map((c) => c.body.operation)).toEqual(readBack
        ? ["search_by_value", "update", "search_by_value"]
        : ["search_by_value", "update"]);
      expect(result.errors).toContain(readBack ? "the stored status is not" : "did not confirm the update");
    });
  }

  test("401 and its response body refuse without disclosing body text", async () => {
    const result = await invoke("disable", args("disable"), () => new Response('{"error":"secret-response-token"}', { status: 401 }));
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("HTTP 401");
    expect(result.errors).toContain("--admin-pass");
    expect(result.errors).not.toContain("secret-response-token");
  });

  test("redirect is refused and the admin credential never reaches its destination", async () => {
    const result = await invoke("disable", args("disable"), (call, index) =>
      index === 0 ? okFor("deactivated")(call) : new Response(null, { status: 307, headers: { Location: SINK } }));
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("redirected");
    expect(result.calls.every((c) => c.url === REMOTE_OPS)).toBe(true);
  });

  test("unparseable target reports a target-specific remedy without printing supplied URL text", async () => {
    const result = await invoke("disable", ["--instance", "http://%bad/path-secret", "--admin-pass", "pass"], okFor("deactivated"));
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("invalid --instance target");
    expect(result.errors).toContain("operations API address");
    expect(result.errors).toContain("<unparseable URL>");
    expect(result.errors).not.toContain("path-secret");
    expect(result.errors).not.toContain("http://%bad/path-secret");
    expect(result.calls).toHaveLength(0);
  });

  test("a parseable URL containing userinfo is refused without printing either secret", async () => {
    const result = await invoke("disable", ["--instance", `http://user:pass@${REMOTE_HOST}:19926/?token=topsecret`, "--admin-pass", "pass"], okFor("deactivated"));
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("invalid --instance target");
    expect(result.errors).not.toContain("user:pass");
    expect(result.errors).not.toContain("topsecret");
    expect(result.calls).toHaveLength(0);
  });

  test.each([
    `user:pass@${REMOTE_HOST}:19926/?token=topsecret`,
    `user:pass@${REMOTE_HOST}:19926/?token=topsecret&next=a://b`,
  ])("a scheme-less target with userinfo is refused without printing either secret: %s", async (instance) => {
    const result = await invoke("disable", ["--instance", instance, "--admin-pass", "other"], okFor("deactivated"));
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("invalid --instance target");
    expect(result.errors).not.toContain("pass");
    expect(result.errors).not.toContain("topsecret");
  });

  test("unreachable target never prints the raw fetch error or query token", async () => {
    const result = await invoke("disable", ["--instance", "http://127.77.21.13/?token=topsecret", "--admin-pass", "pass"], () => {
      const err = new Error("raw fetch topsecret user:pass");
      Object.assign(err, { cause: { code: "ECONNREFUSED" } });
      throw err;
    });
    expect(result.exited).toBe(true);
    expect(result.errors).toContain("could not disable lookup");
    expect(result.errors).not.toContain("topsecret");
    expect(result.errors).toContain("Check --instance");
  });

  test("target that never answers times out with a remedy", async () => {
    const started = Date.now();
    const result = await invoke("disable", args("disable"), (call) => new Promise<Response>((_resolve, reject) => {
      const signal = call.init.signal as AbortSignal | undefined;
      if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    expect(result.exited).toBe(true);
    expect(Date.now() - started).toBeLessThan(18_000);
    expect(result.errors).toContain("Check --instance");
    expect(result.logs).not.toContain("deactivated");
  }, 25_000);
});
