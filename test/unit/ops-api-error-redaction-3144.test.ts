/**
 * A non-2xx ops API response can echo the request body. When that body carried
 * a credential, `callOpsApi` must not put the value into its thrown message
 * (issue #3144). A local stub echoes the body back; the message keeps the
 * status and the rest of the body, with the submitted password replaced.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { callOpsApi } from "../../src/cli.js";

const PASSWORD = "stub-echo-pass-3144";

let server: ReturnType<typeof Bun.serve>;
let responseStatus: number;
let responseBody: string;

beforeEach(() => {
  responseStatus = 400;
  responseBody = "";
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "POST") await req.json().catch(() => ({}));
      return new Response(responseBody, { status: responseStatus });
    },
  });
});

afterEach(() => {
  server.stop(true);
});

async function thrownMessage(body: Record<string, unknown>): Promise<string> {
  try {
    await callOpsApi(`http://127.0.0.1:${server.port}`, body, "cluster-admin", "cluster-secret");
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("callOpsApi resolved; expected a non-2xx throw");
}

const addUserBody = {
  operation: "add_user",
  username: "admin",
  password: PASSWORD,
  role: "super_user",
  active: true,
};

describe("callOpsApi error redaction (#3144)", () => {
  test("redacts a password echoed in plain text", async () => {
    responseBody = `add_user rejected: password ${PASSWORD} is too short`;
    const message = await thrownMessage(addUserBody);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("(400)");
    expect(message).toContain("add_user rejected: password [redacted] is too short");
  });

  test("redacts a password echoed inside a JSON string", async () => {
    responseBody = JSON.stringify({
      error: "rejected",
      echo: { operation: "add_user", password: PASSWORD },
    });
    const message = await thrownMessage(addUserBody);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(PASSWORD);
    expect(message).toContain("(400)");
    expect(message).toContain('"error":"rejected"');
  });

  test("keeps a body unchanged when no credential was sent", async () => {
    responseStatus = 401;
    responseBody = '{"error":"denied"}';
    const message = await thrownMessage({ operation: "list_users" });

    expect(message).toBe('Ops API call failed (401): {"error":"denied"}');
  });
});
