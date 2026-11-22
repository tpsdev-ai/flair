import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { program } from "../../src/cli.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

test.each([
  { command: ["federation", "sync", "status", "--json"], method: "GET", path: "/FederationPeers" },
  { command: ["memory", "search", "example", "--agent", "test-agent", "--json"], method: "POST", path: "/SemanticSearch" },
])("$command sends the file password with the explicit username", async ({ command, method, path }) => {
  for (const key of Object.keys(process.env)) {
    if (/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key)) delete process.env[key];
  }
  process.env.FLAIR_ADMIN_PASS = "ambient-password";
  process.env.FLAIR_ADMIN_USER = "ambient-user";
  const passwordFile = join(tempDir("flair-2889-username-"), "password");
  writeFileSync(passwordFile, "file-password\n", { mode: 0o600 });
  const requests: Request[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    requests.push(request);
    const accepted = request.headers.get("authorization") ===
      `Basic ${Buffer.from("someone:file-password").toString("base64")}`;
    return Response.json(accepted ? { peers: [], results: [] } : { error: "wrong credentials" }, {
      status: accepted ? 200 : 401,
    });
  }) as typeof fetch);
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await program.parseAsync([
      ...command, "--target", "http://127.0.0.1:19926",
      "--admin-pass-file", passwordFile, "--admin-user", "someone",
    ], { from: "user" });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe(method);
    expect(new URL(requests[0].url).pathname).toBe(path);
    expect(requests[0].headers.get("authorization")).toBe(
      `Basic ${Buffer.from("someone:file-password").toString("base64")}`,
    );
  } finally {
    output.mockRestore();
    fetchSpy.mockRestore();
  }
});
