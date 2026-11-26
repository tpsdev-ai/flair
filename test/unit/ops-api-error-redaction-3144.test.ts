/**
 * A non-2xx ops API response is used as an error message only from a parsed JSON
 * body's `error`/`message` string, and only when that string carries no value the
 * call submitted as a credential (issue #3144). Each stub below BUILDS its answer
 * from the request it actually received, so the echo is the real submitted value.
 * Every echo case also checks the thrown message against decoding attempts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { callOpsApi } from "../../src/cli.js";

const USER = "cluster-admin";
const PASS = "cluster-secret-3144";
// A quote, a backslash and a newline: the three shapes a JSON echo escapes.
const PASSWORD = 'pa"ss\\word-3144\nend';
const OPERATION = "add_user";

type Mode =
  | "error-echoes-password"
  | "error-echoes-base64-password"
  | "error-echoes-urlencoded-password"
  | "error-echoes-auth-header"
  | "error-echoes-deploy-payload"
  | "error-echoes-body-under-other-field"
  | "safe-harper-error"
  | "non-json-body";

let server: ReturnType<typeof Bun.serve>;
let mode: Mode;
/** The last credential the stub actually received, for the assertions. */
let received: { password?: string; authorization?: string; payload?: string };

beforeEach(() => {
  mode = "safe-harper-error";
  received = {};
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const authorization = req.headers.get("authorization") ?? "";
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      received = {
        password: typeof body.password === "string" ? body.password : undefined,
        authorization,
        payload: typeof body.payload === "string" ? body.payload : undefined,
      };
      let payload: Record<string, unknown>;
      switch (mode) {
        case "error-echoes-password":
          payload = { error: `invalid password: ${received.password}` };
          break;
        case "error-echoes-base64-password":
          payload = { error: `invalid password: ${Buffer.from(received.password ?? "").toString("base64")}` };
          break;
        case "error-echoes-urlencoded-password":
          payload = { error: `invalid password: ${encodeURIComponent(received.password ?? "")}` };
          break;
        case "error-echoes-auth-header":
          payload = { error: `bad credentials: ${authorization}` };
          break;
        case "error-echoes-deploy-payload":
          payload = { error: `deploy rejected: ${(received.payload ?? "").slice(0, 80)}` };
          break;
        case "error-echoes-body-under-other-field":
          payload = { error: "rejected", received: body };
          break;
        case "non-json-body":
          return new Response(`invalid password: ${received.password}`, { status: 400 });
        default:
          payload = { error: "Unknown operation: frobnicate" };
      }
      return new Response(JSON.stringify(payload), { status: 400, headers: { "content-type": "application/json" } });
    },
  });
});

afterEach(() => {
  server.stop(true);
});

const addUserBody = () => ({
  operation: OPERATION,
  username: "admin",
  password: PASSWORD,
  role: "super_user",
  active: true,
});

async function thrownMessage(body: Record<string, unknown>, user = USER, pass = PASS): Promise<string> {
  try {
    await callOpsApi(`http://127.0.0.1:${server.port}`, body, user, pass);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("callOpsApi resolved; expected a non-2xx throw");
}

/** Can `secret` be read out of `message`, directly or through a decode? */
function leaked(message: string, secret: string): boolean {
  const forms = [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ];
  if (forms.some((form) => form.length > 0 && message.includes(form))) return true;
  for (const token of message.match(/[A-Za-z0-9+/=]{8,}/g) ?? []) {
    if (Buffer.from(token, "base64").toString("utf8").includes(secret)) return true;
  }
  try {
    if (decodeURIComponent(message).includes(secret)) return true;
  } catch {
    /* a stray % is not a submission */
  }
  return false;
}

function expectStatusAndOperation(message: string, operation = OPERATION): void {
  expect(message).toContain("(400)");
  expect(message).toContain(operation);
}

describe("callOpsApi error allowlist (#3144)", () => {
  test("withholds a password echoed raw (quote, backslash, newline)", async () => {
    mode = "error-echoes-password";
    const message = await thrownMessage(addUserBody());

    expect(received.password).toBe(PASSWORD);
    expectStatusAndOperation(message);
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("withholds a password echoed as base64", async () => {
    mode = "error-echoes-base64-password";
    const message = await thrownMessage(addUserBody());

    expectStatusAndOperation(message);
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("withholds a password echoed URL-encoded", async () => {
    mode = "error-echoes-urlencoded-password";
    const message = await thrownMessage(addUserBody());

    expectStatusAndOperation(message);
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("withholds an echo of the Authorization header", async () => {
    mode = "error-echoes-auth-header";
    const message = await thrownMessage({ operation: "list_users" });

    expect(received.authorization).toBe(`Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`);
    expectStatusAndOperation(message, "list_users");
    expect(leaked(message, PASS)).toBe(false);
    expect(leaked(message, `${USER}:${PASS}`)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("keeps an echo of the deploy payload, which submits no credential field", async () => {
    mode = "error-echoes-deploy-payload";
    const payload = Buffer.from("tarball-bytes-3144").toString("base64");
    const message = await thrownMessage({ operation: "deploy_component", project: "flair", payload, restart: "rolling" });

    expect(received.payload).toBe(payload);
    expectStatusAndOperation(message, "deploy_component");
    expect(leaked(message, PASS)).toBe(false);
    expect(leaked(message, `${USER}:${PASS}`)).toBe(false);
    expect(message).toContain("deploy rejected");
  });

  test("keeps a safe Harper error string", async () => {
    mode = "safe-harper-error";
    const message = await thrownMessage(addUserBody());

    expectStatusAndOperation(message);
    expect(message).toContain("Unknown operation: frobnicate");
  });

  test("withholds a non-JSON body", async () => {
    mode = "non-json-body";
    const message = await thrownMessage(addUserBody());

    expectStatusAndOperation(message);
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("includes only the error field, never the echoed body under another field", async () => {
    mode = "error-echoes-body-under-other-field";
    const message = await thrownMessage(addUserBody());

    expectStatusAndOperation(message);
    expect(message).toContain("rejected");
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(leaked(message, PASS)).toBe(false);
  });
});
