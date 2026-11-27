import { spawnSync } from "node:child_process";
import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { program } from "../../src/cli.js";
import { setAgentKeyFileTestHooks } from "../../src/lib/agent-key-file.js";
import { AGENT_ROTATION_LOCK_RETRY, setAgentRotationLockTestHook } from "../../src/lib/agent-rotation-lock.js";

const [keysDir, variant] = process.argv.slice(2) as [string, string];
let keyReads = 0;
let requests = 0;
let swaps = 0;
Object.assign(AGENT_ROTATION_LOCK_RETRY, { attempts: 1, delayMs: 0 });
setAgentKeyFileTestHooks({ beforeKeyRead: () => { keyReads++; } });
globalThis.fetch = (async () => {
  requests++;
  throw new Error("unexpected request");
}) as unknown as typeof fetch;
if (variant === "symlink" || variant === "fifo") {
  setAgentRotationLockTestHook((lockPath) => {
    unlinkSync(lockPath);
    if (variant === "symlink") {
      symlinkSync(join(keysDir, "target"), lockPath);
    } else {
      const made = spawnSync("mkfifo", [lockPath], { timeout: 1_000 });
      if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
    }
    swaps++;
  });
}

process.exit = ((code?: number) => { throw new Error(`process.exit(${code ?? 0})`); }) as typeof process.exit;
let code = 0;
try {
  await program.parseAsync([
    "bun", "flair", "agent", "rotate-key", "agent-a",
    "--ops-port", "11911", "--port", "11912",
    "--admin-pass", "throwaway-admin-pass-not-a-secret", "--admin-user", "admin",
    "--keys-dir", keysDir,
  ]);
} catch (err) {
  const match = err instanceof Error && err.message.match(/^process\.exit\((\d+)\)$/);
  if (!match) throw err;
  code = Number(match[1]);
}
console.log(JSON.stringify({ code, keyReads, requests, swaps }));
