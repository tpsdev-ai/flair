import { expect, test } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/memory.ts";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
const root = realpathSync(join(import.meta.dir, "../.."));
test("task references are optional, generic, and backwards compatible", async () => {
  for (const [extra, ref] of [[[], "unreferenced"], [["--ref", "issue-a"], "issue-a"], [["--beads", "old"], "old"], [["--ref", "new", "--beads", "old"], "new"]] as const) {
    const writes: unknown[][] = [];
    const unused = (): never => { throw new Error("unexpected helper"); };
    bindCli({
      api: async (...args: unknown[]) => { writes.push(args); return {}; },
      resolveSigningAgentId: () => ({ agentId: "fixture", source: "flag" }),
      addSharedCredentialOptions: (c) => c, addSharedIdentityOption: (c) => c,
      resolveBaseUrl: unused, applyAdminPassFile: unused, resolveOpsPort: unused, resolveHttpPort: unused,
      parseEntitiesOptionOrExit: unused, ENTITIES_OPTION_DESCRIPTION: "fixture",
    });
    const program = new Command().exitOverride(); register(program);
    await expect(program.parseAsync(["memory", "write-task-summary", "--agent", "fixture", "--outcome", "merged", "--summary", "done", ...extra], { from: "user" })).resolves.toBe(program);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[2]).toMatchObject({ subject: "task:" + ref, content: "task: " + ref + "\noutcome: merged\n\nsummary:\ndone", summary: "done" });
    expect(program.commands[0]?.commands.find((c) => c.name() === "write-task-summary")?.helpInformation()).not.toContain("--beads");
  }
});
test("documented tools equal tools/list from the built stdio server", async () => {
  for (const pkg of ["flair-client", "flair-mcp"]) {
    execFileSync("bun", ["run", "build"], { cwd: realpathSync(join(root, "packages", pkg)), timeout: 60000 });
  }
  const child = spawn("node", [join(root, "packages/flair-mcp/dist/index.js")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, FLAIR_AGENT_ID: "docs-fixture", FLAIR_URL: "http://127.0.0.1:1" } });
  const names = await new Promise<string[]>((resolve, reject) => {
    let buffer = "";
    const fail = (error: Error) => { clearTimeout(timer); child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error("tools/list timed out")), 20000);
    child.on("error", fail); child.stdin.on("error", fail);
    child.on("exit", () => fail(new Error("stdio server exited before tools/list")));
    child.stderr.resume();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        const reply = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
        if (reply.id === 2) { clearTimeout(timer); resolve(reply.result?.tools?.map((tool) => tool.name) ?? []); child.stdin.end(); }
      }
    });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"docs","version":"1"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  });
  const doc = readFileSync(join(root, "docs/mcp-clients.md"), "utf8").split("## What the MCP server exposes\n")[1]?.split("### Reading the")[0] ?? "";
  const documented = [...doc.matchAll(/^\| \x60([^\x60]+)\x60 \|/gm)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(0); expect(documented).toEqual(names);
}, 150000);
