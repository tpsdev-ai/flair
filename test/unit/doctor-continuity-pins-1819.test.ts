import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildContinuityCaptureHookCommand, CONTINUITY_POST_TOOL_USE_MATCHER } from "../../src/doctor-client.ts";

const cli = join(import.meta.dir, "../../src/cli.ts");
const cases = [[null, null], ["1.2.3", null], ["1.2.3-rc.1+build", null],
  ["latest", "range-or-tag"], ["^1.2.3", "range-or-tag"],
  ["file:adapter", "unsupported"], ["v1.2.3", "malformed"]] as const;
for (const event of ["PostToolUse", "Stop"]) {
  for (const [pin, kind] of cases) {
    test("doctor continuity " + event + " " + pin, () => {
      const home = realpathSync(tempDir("flair-doctor-1819-"));
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      mkdirSync(join(home, ".claude"));
      const command = (name: string) => buildContinuityCaptureHookCommand("fixture", undefined, name === event ? pin : "1.2.3");
      const settings = join(home, ".claude/settings.json");
      const bytes = JSON.stringify({ hooks: {
        PostToolUse: [{ matcher: CONTINUITY_POST_TOOL_USE_MATCHER, hooks: [{ type: "command", command: command("PostToolUse") }] }],
        Stop: [{ hooks: [{ type: "command", command: command("Stop") }] }],
      } });
      writeFileSync(settings, bytes);
      const offline = join(home, "offline.cjs");
      writeFileSync(offline, "globalThis.fetch = async () => { throw new Error('offline fixture'); };\n");
      const result = spawnSync(process.execPath, ["--preload", offline, cli, "doctor", "--port", "9", "--agent", "fixture"], {
        cwd: home, encoding: "utf8", timeout: 20_000,
        env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home,
          PATH: bin + ":" + (process.env.PATH ?? ""), NO_COLOR: "1" },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect([0, 1, null]).toContain(result.status);
      const line = result.stdout.split("\n").find(s => s.includes("Continuity capture hooks:")) ?? "";
      expect(line).toContain(kind ? "Continuity capture hooks: stale" : "Continuity capture hooks: PostToolUse + Stop wired");
      if (kind) expect(line).toContain(event + " pin " + kind + ": " + pin);
      expect(readFileSync(settings, "utf8")).toBe(bytes);
    }, 25_000);
  }
}
