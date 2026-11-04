import { afterEach, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/cli.ts";
import { register } from "../../src/commands/idp.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

async function runIdp(status: number) {
  const dir = tempDir("flair-idp-pass-");
  const passFile = join(dir, "admin-pass");
  writeFileSync(passFile, "file-password\n", { mode: 0o600 });
  process.env.FLAIR_URL = "http://127.0.0.1:19926";
  process.env.FLAIR_ADMIN_PASS = "ambient-password";
  process.env.HDB_ADMIN_PASSWORD = "ambient-hdb-password";
  process.env.FLAIR_ADMIN_USER = "ambient-user";
  process.env.FLAIR_AGENT_ID = "ambient-agent";
  process.env.FLAIR_TOKEN = "ambient-token";
  const requests: Request[] = [];
  const errors: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname === "/IdpConfig/idp_fixture") {
      if (status !== 200) return Response.json({ error: "lookup refused" }, { status });
      return Response.json({ name: "Fixture", issuer: "https://idp.example", jwksUri: "https://idp.example/jwks" });
    }
    if (request.url === "https://idp.example/jwks") return Response.json({ keys: [] });
    throw new Error(`Unexpected request: ${request.url}`);
  }) as typeof fetch);
  const logMock = spyOn(console, "log").mockImplementation(() => {});
  const errorMock = spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
  const exitError = new Error("fixture exit");
  const exitMock = spyOn(process, "exit").mockImplementation(() => { throw exitError; });
  try {
    const program = new Command();
    register(program);
    const action = program.parseAsync([
      "idp", "test", "idp_fixture", "--admin-pass-file", passFile, "--admin-user", "file-user",
    ], { from: "user" });
    if (status === 200) await action;
    else await expect(action).rejects.toBe(exitError);
    return { requests, errors };
  } finally {
    fetchMock.mockRestore();
    logMock.mockRestore();
    errorMock.mockRestore();
    exitMock.mockRestore();
  }
}

test("idp test sends the file password and admin user on the IdpConfig read", async () => {
  const { requests, errors } = await runIdp(200);
  expect(requests.map(r => [r.method, new URL(r.url).pathname])).toEqual([
    ["GET", "/IdpConfig/idp_fixture"], ["GET", "/jwks"],
  ]);
  expect(requests[0].headers.get("Authorization")).toBe(`Basic ${Buffer.from("file-user:file-password").toString("base64")}`);
  expect(requests[1].headers.get("Authorization")).toBeNull();
  expect(errors).toEqual([]);
});

for (const status of [401, 403, 500]) {
  test(`idp test reports HTTP ${status} from the IdpConfig read`, async () => {
    const { requests, errors } = await runIdp(status);
    expect(requests).toHaveLength(1);
    expect(errors.join("\n")).toContain(`HTTP ${status}`);
    expect(errors.join("\n")).toContain("lookup refused");
    expect(errors.join("\n")).not.toContain("not found");
  });
}

test("idp test reports not found for an IdpConfig 404", async () => {
  const { requests, errors } = await runIdp(404);
  expect(requests).toHaveLength(1);
  expect(errors).toEqual(["IdP 'idp_fixture' not found"]);
});
