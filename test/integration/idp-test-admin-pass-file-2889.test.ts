import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnCli } from "../helpers/build-cli-once.ts";
import { tempDir } from "../helpers/temp-dir.ts";

for (const status of [200, 401]) {
  test(`idp test receives HTTP ${status} with file credentials on the wire`, async () => {
    const home = tempDir("flair-idp-wire-");
    const passFile = join(home, "admin-pass");
    writeFileSync(passFile, "wire-password\n", { mode: 0o600 });
    const reads: Array<{ method: string; auth: string | null }> = [];
    let jwksAuth: string | null | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/IdpConfig/idp_wire") {
          reads.push({ method: request.method, auth: request.headers.get("Authorization") });
          if (status !== 200) return Response.json({ error: "wire credential refused" }, { status });
          return Response.json({ name: "Wire fixture", issuer: url.origin, jwksUri: `${url.origin}/jwks` });
        }
        if (url.pathname === "/jwks") {
          jwksAuth = request.headers.get("Authorization");
          return Response.json({ keys: [] });
        }
        return new Response("unexpected path", { status: 500 });
      },
    });
    try {
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key) && key !== "ROOTPATH"));
      Object.assign(env, {
        HOME: home, USERPROFILE: home,
        FLAIR_URL: `http://127.0.0.1:${server.port}`,
        FLAIR_TOKEN: "ambient-token", FLAIR_ADMIN_PASS: "ambient-password", FLAIR_ADMIN_USER: "ambient-user",
        FLAIR_AGENT_ID: "ambient-agent",
      });
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawnCli([
          "idp", "test", "idp_wire", "--admin-pass-file", passFile, "--admin-user", "wire-user",
        ], { env, timeout: 20_000, killSignal: "SIGKILL" });
        let output = "";
        child.stdout.on("data", data => { output += data.toString(); });
        child.stderr.on("data", data => { output += data.toString(); });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (signal) reject(new Error(`idp test terminated by ${signal}: ${output}`));
          else resolve({ code, output });
        });
      });
      expect(reads).toEqual([{
        method: "GET", auth: `Basic ${Buffer.from("wire-user:wire-password").toString("base64")}`,
      }]);
      if (status === 200) {
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain("JWKS reachable");
        expect(jwksAuth).toBeNull();
      } else {
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain("HTTP 401");
        expect(result.output).toContain("wire credential refused");
        expect(result.output).not.toContain("not found");
        expect(jwksAuth).toBeUndefined();
      }
    } finally {
      await server.stop(true);
    }
  }, 120_000);
}
