/** Socket-free command tests for the remote principal admin control. */
import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/principal.ts";

const EXIT = "__principal_exit__";
interface Call { url: string; init: RequestInit; body: any }

async function invoke(
  verb: "disable" | "enable",
  flags: string[],
  answer: (call: Call, index: number) => Promise<Response> | Response,
  env: Record<string, string> = {},
) {
  const oldFetch = globalThis.fetch;
  const oldExit = process.exit;
  const oldError = console.error;
  const oldLog = console.log;
  const oldEnv = Object.fromEntries(["FLAIR_URL", "FLAIR_TARGET", "FLAIR_OPS_TARGET", "FLAIR_ADMIN_PASS"].map((key) => [key, process.env[key]]));
  const errors: string[] = [];
  const logs: string[] = [];
  const calls: Call[] = [];
  try {
    for (const key of Object.keys(oldEnv)) process.env[key] = env[key] ?? "";
    process.exit = ((code?: number) => { throw new Error(`${EXIT}:${code}`); }) as typeof process.exit;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) };
      calls.push(call);
      return answer(call, calls.length - 1);
    }) as typeof fetch;
    bindCli({ resolveOpsPort: () => 19925 } as any);
    const cmd = new Command();
    register(cmd);
    let exited = false;
    try { await cmd.parseAsync(["principal", verb, "alice", ...flags], { from: "user" }); }
    catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith(EXIT)) throw err;
      exited = true;
    }
    return { exited, errors: errors.join("\n"), logs: logs.join("\n"), calls };
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

const ok = (call: Call) => new Response(JSON.stringify(call.body.operation === "update"
  ? { update_hashes: ["alice"], skipped_hashes: [] }
  : [{ id: "alice", status: "deactivated" }]), { status: 200 });
const remote = ["--instance", "https://flair.example.com", "--admin-pass", "target-pass"];

describe("principal state command, socket-free", () => {
  test("explicit instance and credential beat ambient targets; requests are bounded and manual-redirect", async () => {
    const result = await invoke("disable", remote, ok, {
      FLAIR_URL: "https://wrong.example", FLAIR_TARGET: "https://wrong.example", FLAIR_OPS_TARGET: "https://wrong.example", FLAIR_ADMIN_PASS: "local-pass",
    });
    expect(result.exited).toBe(false);
    expect(result.calls.map((c) => c.url)).toEqual(Array(3).fill("https://flair.example.com:9925/"));
    expect(result.calls[0].init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("admin:target-pass").toString("base64")}` });
    expect(result.calls.every((c) => c.init.redirect === "manual" && c.init.signal instanceof AbortSignal)).toBe(true);
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
    expect(result.calls[2].body.search_value).toBe("alice");
    expect(result.logs).toContain("deactivated");
  });

  test("enable requires a confirmed active read-back", async () => {
    const result = await invoke("enable", remote, (call) => new Response(JSON.stringify(call.body.operation === "update"
      ? { update_hashes: ["alice"] } : [{ id: "alice", status: "active" }])));
    expect(result.exited).toBe(false);
    expect(result.calls[1].body.records[0].status).toBe("active");
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
    expect(result.logs).toContain("activated");
  });

  for (const verb of ["disable", "enable"] as const) {
    for (const status of ["suspended", ""]) {
      test(`${verb}: pre-read status ${JSON.stringify(status)} refuses without an update`, async () => {
        const result = await invoke(verb, remote, (call) => call.body.operation === "update" ? ok(call)
          : new Response(JSON.stringify([{ id: "alice", status }])));
        expect(result.exited).toBe(true);
        expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value"]);
        expect(result.errors).toContain("before the");
        expect(result.logs).toBe("");
      });
    }
    for (const status of [undefined, null]) {
      test(`${verb}: missing pre-read status ${String(status)} permits a confirmed write`, async () => {
        const requested = verb === "enable" ? "active" : "deactivated";
        const result = await invoke(verb, remote, (call, index) => new Response(JSON.stringify(
          call.body.operation === "update" ? { update_hashes: ["alice"] }
            : [{ id: "alice", status: index === 0 ? status : requested }],
        )));
        expect(result.exited).toBe(false);
        expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
        expect(result.calls[1].body.records[0].status).toBe(requested);
        expect(result.logs).toContain(`stored status: ${requested}`);
      });
    }
  }

  for (const status of [undefined, null]) {
    test(`enable: missing read-back status ${String(status)} refuses confirmation`, async () => {
      const result = await invoke("enable", remote, (call, index) => index < 2 ? ok(call)
        : new Response(JSON.stringify([{ id: "alice", status }])));
      expect(result.exited).toBe(true);
      expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
      expect(result.calls[1].body.records[0].status).toBe("active");
      expect(result.errors).toContain("the stored status is not active");
      expect(result.logs).toBe("");
    });
  }

  test("empty explicit instance refuses before ambient target or credential can be used", async () => {
    const result = await invoke("disable", ["--instance", "", "--admin-pass", "pass"], ok, { FLAIR_URL: "https://wrong.example", FLAIR_OPS_TARGET: "https://wrong.example" });
    expect(result.exited).toBe(true);
    expect(result.calls).toHaveLength(0);
    expect(result.errors).toContain("--instance is empty");
  });

  test("ambient local admin password is refused for a remote instance", async () => {
    const result = await invoke("disable", ["--instance", "https://flair.example.com"], ok, { FLAIR_ADMIN_PASS: "local-pass" });
    expect(result.exited).toBe(true);
    expect(result.calls).toHaveLength(0);
    expect(result.errors).toContain("--admin-pass");
  });

  test("redirect refuses before the read-back", async () => {
    const result = await invoke("disable", remote, (call, index) => index === 0 ? ok(call) : new Response(null, { status: 307, headers: { Location: "https://wrong.example" } }));
    expect(result.exited).toBe(true);
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update"]);
    expect(result.errors).toContain("redirected the update");
    expect(result.logs).not.toContain("deactivated");
  });

  test("HTTP denial omits the response body and names the credential remedy", async () => {
    const result = await invoke("disable", remote, (call, index) => index === 0 ? ok(call) : new Response('{"error":"secret-response-token"}', { status: 401 }));
    expect(result.exited).toBe(true);
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update"]);
    expect(result.errors).toContain("refused the update (HTTP 401)");
    expect(result.errors).toContain("--admin-pass");
    expect(result.errors).not.toContain("secret-response-token");
  });

  for (const body of ["", "[]", '{"error":"secret-response-token"}']) {
    test(`empty or error update result ${JSON.stringify(body)} refuses`, async () => {
      const result = await invoke("disable", remote, (call, index) => index === 0 ? ok(call) : new Response(body));
      expect(result.exited).toBe(true);
      expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update"]);
      expect(result.logs).not.toContain("deactivated");
      expect(result.errors).not.toContain("secret-response-token");
      expect(result.errors).toContain("did not confirm the update");
    });
  }

  test("wrong read-back state refuses success", async () => {
    const result = await invoke("disable", remote, (call) => new Response(JSON.stringify(call.body.operation === "update"
      ? { update_hashes: ["alice"] } : [{ id: "alice", status: "active" }])));
    expect(result.exited).toBe(true);
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
    expect(result.errors).toContain("the stored status is not deactivated");
    expect(result.logs).not.toContain("deactivated");
  });

  for (const [verb, status] of [["disable", "deactivated"], ["enable", "active"]] as const) {
    test(`${verb}: an unexpected read-back status never appears in output`, async () => {
      const result = await invoke(verb, remote, (call, index) => index < 2 ? ok(call)
        : new Response(JSON.stringify([{ id: "alice", status: "secret-response-token" }])));
      expect(result.exited).toBe(true);
      expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
      expect(result.calls[1].body.records[0]).toMatchObject({ id: "alice", status });
      expect(result.errors).toContain(`the stored status is not ${status}. Check the principal's status on that instance`);
      expect(result.errors + result.logs).not.toContain("secret-response-token");
      expect(result.logs).toBe("");
    });
  }

  test("a matching state for another principal refuses success", async () => {
    const result = await invoke("disable", remote, (call, index) => index === 0 ? ok(call) : new Response(JSON.stringify(call.body.operation === "update"
      ? { update_hashes: ["alice"] } : [{ id: "mallory", status: "deactivated" }])));
    expect(result.exited).toBe(true);
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value", "update", "search_by_value"]);
    expect(result.errors).toContain("the stored status is not deactivated");
    expect(result.logs).not.toContain("deactivated");
  });

  test("unparseable target prints a fixed placeholder and none of the supplied URL text", async () => {
    const result = await invoke("disable", ["--instance", "http://%bad/path-secret", "--admin-pass", "pass"], ok);
    expect(result.exited).toBe(true);
    expect(result.calls).toHaveLength(0);
    expect(result.errors).toContain("invalid --instance target");
    expect(result.errors).toContain("operations API address");
    expect(result.errors).toContain("<unparseable URL>");
    expect(result.errors).not.toContain("path-secret");
    expect(result.errors).not.toContain("http://%bad/path-secret");
  });

  test.each([
    "user:pass@flair.example.com/?token=topsecret",
    "user:pass@flair.example.com/?token=topsecret&next=a://b",
  ])("scheme-less target with userinfo is refused without printing either secret: %s", async (instance) => {
    const result = await invoke("disable", ["--instance", instance, "--admin-pass", "other"], ok);
    expect(result.exited).toBe(true);
    expect(result.calls).toHaveLength(0);
    expect(result.errors).toContain("invalid --instance target");
    expect(result.errors).not.toContain("pass");
    expect(result.errors).not.toContain("topsecret");
  });

  test("fetch error prints only its code and redacts the target query", async () => {
    const result = await invoke("disable", ["--instance", "https://flair.example.com/?token=topsecret", "--admin-pass", "pass"], () => {
      const err = new Error("raw fetch topsecret user:pass");
      Object.assign(err, { cause: { code: "ECONNREFUSED" } });
      throw err;
    });
    expect(result.exited).toBe(true);
    expect(result.calls.map((c) => c.body.operation)).toEqual(["search_by_value"]);
    expect(result.errors).toContain("could not disable lookup");
    expect(result.errors).toContain("ECONNREFUSED");
    expect(result.errors).not.toContain("topsecret");
    expect(result.errors).not.toContain("user:pass");
    expect(result.logs).not.toContain("deactivated");
  });
});
