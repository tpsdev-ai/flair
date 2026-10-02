import { expect, mock, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { tempDir } from "../helpers/temp-dir.ts";
import { NON_CANONICAL_TARGETS, UNSPECIFIED_TARGETS } from "../helpers/mcp-enable-target-shapes.ts";

let prompts = 0;
mock.module("node:readline", () => ({
  createInterface: () => ({
    question: (_question: string, answer: (value: string) => void) => { prompts++; answer("fixture"); },
    close: () => {},
  }),
}));
const { register } = await import("../../src/commands/mcp.ts");

for (const [instance, issuer, fabric, refusal] of [
  ["http://127.0.0.1:9926", "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"],
  ["http://localhost:9926", "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"],
  ["http://[::1]:9926", "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"],
  ["http://localhost.:9926", "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"],
  ["http://LOCALHOST.:9926", "https://mcp.example.com", true, "Use http://localhost.:9926"],
  ["http://sub.localhost.:9926", "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"],
  ["http://[::ffff:127.0.0.1]:9926", "https://mcp.example.com", true, "Use http://[::ffff:7f00:1]:9926"],
  ["http://[::ffff:7f00:1]:9926", "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"],
  ["http://[0:0:0:0:0:ffff:127.1.2.3]:9926", "https://mcp.example.com", true, "Use http://[::ffff:7f01:203]:9926"],
  ["http://LOCALHOST.:9926", undefined, false, "Use http://localhost.:9926"],
  ...UNSPECIFIED_TARGETS.map(instance => [instance, "https://mcp.example.com", true, "--fabric cannot be used with a loopback or unspecified target"] as const),
  ...NON_CANONICAL_TARGETS.map(([instance, canonical]) => [instance, "https://mcp.example.com", false, `Use ${canonical}`] as const),
  ["https://acme.harperfabric.com", "https://[fd00::1]", false, "Issuer refused:"],
  ["https://acme.harperfabric.com", "https://[fe80::1]", false, "Issuer refused:"],
  ["https://acme.harperfabric.com", "https://[::ffff:192.168.1.1]", false, "Issuer refused:"],
  ["https://acme.harperfabric.com", "not a url", false, "Issuer refused: invalid URL"],
] as const) {
  test.each([false, true])(`CLI refuses ${instance}, issuer=${issuer}, fabric=${fabric} before prompts or writes (dryRun=%s)`, async (dryRun) => {
    const dir = tempDir("flair-enable-refusal-");
    const config = readFileSync(join(import.meta.dir, "../../config.yaml"), "utf8");
    writeFileSync(join(dir, "config.yaml"), config);
    const cwd = process.cwd();
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const exit = process.exit;
    const fetch = globalThis.fetch;
    const log = console.log;
    const error = console.error;
    const output: string[] = [];
    let calls = 0;
    prompts = 0;
    try {
      process.chdir(dir);
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      process.exit = ((code: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
      globalThis.fetch = (async () => { calls++; throw new Error("unexpected fetch"); }) as unknown as typeof globalThis.fetch;
      console.log = console.error = (...args) => { output.push(args.join(" ")); };
      const program = new Command();
      register(program);
      await expect(program.parseAsync([
        "node", "flair", "mcp", "enable", "--instance", instance,
        ...(issuer === undefined ? [] : ["--issuer", issuer]),
        "--admin-pass", "fixture", "--signing-key-file", join(dir, "key.pem"),
        "--secrets-path", join(dir, "secrets.env"),
        ...(fabric ? ["--fabric"] : []), ...(dryRun ? ["--dry-run"] : []),
      ])).rejects.toThrow("exit 1");
      expect(readdirSync(dir)).toEqual(["config.yaml"]);
      expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(config);
      expect(output.join("\n")).toContain(refusal);
      if (issuer === "not a url") expect(output.join("\n")).not.toContain("local");
      expect(prompts).toBe(0);
      expect(calls).toBe(0);
    } finally {
      process.chdir(cwd);
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      process.exit = exit;
      globalThis.fetch = fetch;
      console.log = log;
      console.error = error;
    }
  });
}
