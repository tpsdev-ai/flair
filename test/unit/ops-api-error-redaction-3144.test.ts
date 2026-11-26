/**
 * A non-2xx ops API response is classified internally and reported as a fixed,
 * code-defined description; Harper's response text is never echoed (issue
 * #3144). The echo stubs build their answer from the request they actually
 * received, so the echo is the real submitted value; the classification stubs
 * return fixed responses. Every echo case checks the thrown message directly
 * and after decoding attempts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chdir } from "node:process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { buildDeployTarball, callOpsApi, provisionFabric } from "../../src/cli.js";

const USER = "cluster-admin";
const PASS = "cluster-secret-3144";
// A quote, a backslash and a newline: the three shapes a JSON echo escapes.
const PASSWORD = 'pa"ss\\word-3144\nend';
const OPERATION = "add_user";

type Mode =
  | "already-exists"
  | "not-permitted"
  | "authentication-failed"
  | "unclassified"
  | "error-echoes-password"
  | "error-echoes-base64-password"
  | "error-echoes-urlencoded-password"
  | "error-echoes-lowercase-urlencoded-password"
  | "error-echoes-json-escaped-password"
  | "error-echoes-basic-password"
  | "error-echoes-deploy-payload"
  | "error-echoes-body-under-other-field"
  | "already-exists-in-received"
  | "invalid-password-with-already-exists"
  | "not-authorized-401"
  | "already-exists-message-only"
  | "non-json-body";

let server: ReturnType<typeof Bun.serve>;
let mode: Mode;
/** The last credential the stub actually received, for the assertions. */
let received: { password?: string; authorization?: string; payload?: string };

beforeEach(() => {
  mode = "unclassified";
  received = {};
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/FederationPair") {
        return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), { status: 400 });
      }
      const authorization = req.headers.get("authorization") ?? "";
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      received = {
        password: typeof body.password === "string" ? body.password : undefined,
        authorization,
        payload: typeof body.payload === "string" ? body.payload : undefined,
      };
      const password = received.password ?? "";
      const lowercaseEscape = (value: string) =>
        encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
      let payload: unknown;
      let status = 400;
      switch (mode) {
        case "already-exists":
          status = 409;
          payload = { error: `User admin already exists` };
          break;
        case "not-permitted":
          status = 403;
          payload = { error: "This operation is not authorized due to role restrictions and/or invalid database items" };
          break;
        case "authentication-failed":
          status = 401;
          payload = { error: "Login failed" };
          break;
        case "error-echoes-password":
          payload = { error: `invalid password: ${password}` };
          break;
        case "error-echoes-base64-password":
          payload = { error: `invalid password: ${Buffer.from(password).toString("base64")}` };
          break;
        case "error-echoes-urlencoded-password":
          payload = { error: `invalid password: ${encodeURIComponent(password)}` };
          break;
        case "error-echoes-lowercase-urlencoded-password":
          payload = { error: `invalid password: ${lowercaseEscape(password)}` };
          break;
        case "error-echoes-json-escaped-password":
          payload = { error: `invalid password: ${JSON.stringify(password).slice(1, -1)}` };
          break;
        case "error-echoes-basic-password":
          payload = { error: `rejected credential: ${authorization} ${password}` };
          break;
        case "error-echoes-deploy-payload":
          payload = { error: `deploy rejected: ${(received.payload ?? "").slice(0, 120)}` };
          break;
        case "error-echoes-body-under-other-field":
          payload = { error: "refused", received: body };
          break;
        case "already-exists-in-received":
          status = 409;
          payload = { received: { password: "already exists" } };
          break;
        case "invalid-password-with-already-exists":
          status = 409;
          payload = { error: "invalid password: already exists" };
          break;
        case "not-authorized-401":
          status = 401;
          payload = { error: "not authorized" };
          break;
        case "already-exists-message-only":
          status = 409;
          payload = { message: "User admin already exists" };
          break;
        case "non-json-body":
          return new Response(`invalid password: ${password}`, { status: 400 });
        default:
          payload = { error: "some unclassified refusal" };
      }
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
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

async function thrownError(body: Record<string, unknown>, user = USER, pass = PASS): Promise<Error> {
  try {
    await callOpsApi(`http://127.0.0.1:${server.port}`, body, user, pass);
  } catch (err: unknown) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("callOpsApi resolved; expected a non-2xx throw");
}

/** Can `secret` be read out of `message`, directly or through a decode? */
function leaked(message: string, secret: string): boolean {
  const uppercaseEscape = encodeURIComponent(secret);
  const forms = [
    secret,
    JSON.stringify(secret).slice(1, -1),
    uppercaseEscape,
    uppercaseEscape.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
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

function expectStatusAndOperation(message: string, status = 400, operation = OPERATION): void {
  expect(message).toContain(`(${status})`);
  expect(message).toContain(operation);
}

describe("callOpsApi fixed error descriptions (#3144)", () => {
  test("maps an existing user to the fixed already-exists description", async () => {
    mode = "already-exists";
    const message = (await thrownError({ operation: "add_user", username: "admin", password: "x" })).message;

    expectStatusAndOperation(message, 409);
    expect(message).toContain("the user already exists");
    expect(message).not.toContain("User admin");
    expect(message).not.toContain("withheld");
  });

  test("maps a role refusal to the fixed not-permitted description", async () => {
    mode = "not-permitted";
    const message = (await thrownError({ operation: "deploy_component", project: "flair" })).message;

    expect(message).toContain("(403)");
    expect(message).toContain("the operation is not permitted for this role");
    expect(message).toContain("deploy_component");
    expect(message).not.toContain("withheld");
  });

  test("maps a login refusal to the fixed authentication-failed description", async () => {
    mode = "authentication-failed";
    const message = (await thrownError({ operation: "list_users" })).message;

    expect(message).toContain("(401)");
    expect(message).toContain("authentication failed");
    expect(message).toContain("list_users");
    expect(message).not.toContain("withheld");
  });

  test("reports an unclassified refusal with the withheld description", async () => {
    mode = "unclassified";
    const message = (await thrownError(addUserBody())).message;

    expectStatusAndOperation(message);
    expect(message).toContain("the ops API refused the request (details withheld)");
    expect(message).not.toContain("some unclassified refusal");
  });

  test("never echoes a password sent raw", async () => {
    mode = "error-echoes-password";
    const message = (await thrownError(addUserBody())).message;

    expect(received.password).toBe(PASSWORD);
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("never echoes a password sent as base64", async () => {
    mode = "error-echoes-base64-password";
    const message = (await thrownError(addUserBody())).message;

    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("never echoes a password sent as an uppercase URL escape", async () => {
    mode = "error-echoes-urlencoded-password";
    const message = (await thrownError(addUserBody())).message;

    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("never echoes a password sent as a lowercase URL escape", async () => {
    mode = "error-echoes-lowercase-urlencoded-password";
    const message = (await thrownError(addUserBody())).message;

    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("never echoes a password sent as a JSON escape", async () => {
    mode = "error-echoes-json-escaped-password";
    const message = (await thrownError(addUserBody())).message;

    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("never echoes the Basic password alone or its header", async () => {
    mode = "error-echoes-basic-password";
    const message = (await thrownError({ operation: "list_users" })).message;

    expect(received.authorization).toBe(`Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`);
    expect(leaked(message, PASS)).toBe(false);
    expect(leaked(message, `${USER}:${PASS}`)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("never echoes a deploy tarball built from a real operator .env", async () => {
    mode = "error-echoes-deploy-payload";
    const envCredential = "deploy-env-credential-3144";
    const root = mkdtempSync(join(tmpdir(), "flair-unit-3144-env-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "config.yaml"), "restart: rolling\n");
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "schemas"));
      for (const name of ["LICENSE", "README.md", "SECURITY.md"]) writeFileSync(join(root, name), "fixture\n");
      writeFileSync(join(root, ".env"), `FLAIR_AGENT_SECRET=${envCredential}\n`);
      const { tarballB64 } = await buildDeployTarball(root, "http://127.0.0.1:9926");
      // The operator's credential is really inside the tarball the server gets.
      expect(gunzipSync(Buffer.from(tarballB64, "base64")).toString("utf8")).toContain(envCredential);
      const message = (await thrownError({ operation: "deploy_component", project: "flair", payload: tarballB64, restart: "rolling" })).message;

      expect(received.payload).toBe(tarballB64);
      expect(message).not.toContain(tarballB64);
      expect(leaked(message, tarballB64)).toBe(false);
      expect(leaked(message, envCredential)).toBe(false);
      expect(message).toContain("withheld");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never echoes a non-JSON body", async () => {
    mode = "non-json-body";
    const message = (await thrownError(addUserBody())).message;

    expect(leaked(message, PASSWORD)).toBe(false);
    expect(message).toContain("withheld");
  });

  test("ignores an echoed body under another field", async () => {
    mode = "error-echoes-body-under-other-field";
    const message = (await thrownError(addUserBody())).message;

    expect(message).toContain("withheld");
    expect(leaked(message, PASSWORD)).toBe(false);
    expect(leaked(message, PASS)).toBe(false);
  });

  test("does not classify the phrase 'already exists' from another field", async () => {
    mode = "already-exists-in-received";
    const message = (await thrownError(addUserBody())).message;

    expect(message).toContain("withheld");
    expect(message).not.toContain("the user already exists");
  });

  test("does not classify an error string that merely contains 'already exists'", async () => {
    mode = "invalid-password-with-already-exists";
    const message = (await thrownError(addUserBody())).message;

    expect(message).toContain("withheld");
    expect(message).not.toContain("the user already exists");
  });

  test("does not classify a 401 refusal as a role refusal", async () => {
    mode = "not-authorized-401";
    const message = (await thrownError(addUserBody())).message;

    expect(message).toContain("(401)");
    expect(message).toContain("withheld");
    expect(message).not.toContain("the operation is not permitted for this role");
  });

  test("classifies an already-exists message when the error field is absent", async () => {
    mode = "already-exists-message-only";
    const message = (await thrownError(addUserBody())).message;

    expectStatusAndOperation(message, 409);
    expect(message).toContain("the user already exists");
    expect(message).not.toContain("withheld");
  });

  test("drives the alter_user fallback from the classification, not the message text", async () => {
    const root = mkdtempSync(join(tmpdir(), "flair-unit-3144-"));
    const originalCwd = process.cwd();
    const calls: string[] = [];
    server.stop(true);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/FederationPair") {
          return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), { status: 400 });
        }
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        calls.push(String(body.operation));
        switch (body.operation) {
          case "list_users":
            return new Response(JSON.stringify([
              { username: USER, role: { permission: { super_user: false } } },
            ]), { status: 200 });
          case "deploy_component":
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          case "add_user":
            return new Response(JSON.stringify({ error: "User admin already exists" }), { status: 409 });
          case "alter_user":
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          default:
            return new Response(JSON.stringify({ error: "unknown" }), { status: 400 });
        }
      },
    });
    try {
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "config.yaml"), "restart: rolling\n");
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "schemas"));
      for (const name of ["LICENSE", "README.md", "SECURITY.md"]) writeFileSync(join(root, name), "fixture\n");
      chdir(root);
      const origin = `http://127.0.0.1:${server.port}`;
      const principal = await provisionFabric(origin, origin, USER, PASS, "flair-admin-3144");
      expect(principal).toEqual({ username: "admin", password: "flair-admin-3144", created: true });
      expect(calls).toEqual(["list_users", "deploy_component", "add_user", "alter_user"]);
    } finally {
      chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
