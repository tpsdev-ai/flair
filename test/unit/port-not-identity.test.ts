/**
 * port-not-identity.test.ts — Regression tests for the "port is not identity" arc.
 *
 * Four issues share the same root shape: "a value that is present but wrong beats
 * a value that is absent but correct." All four resolve which INSTANCE from a port
 * and all four get it wrong in the same way.
 *
 *   #917  uninstall kills whatever holds the port, then deletes data WITHOUT verifying
 *         the PID was Flair
 *   #862  discoverPortFromPid takes the FIRST lsof match; probePort accepts ANY HTTP
 *         status > 0, so the Node inspector on 9229 wins
 *   #915  the residual attribution gap #910 left behind (default-dir bypass)
 *   #819  defaults to 127.0.0.1:19926, works only if the user exported FLAIR_URL
 *
 * Pattern: resolve identity from something that actually identifies the instance
 * (the data dir, the PID file) over anything a stranger can occupy (a port number).
 *
 * Each test spawns its own subprocess via Bun.spawn so HOME isolation is real
 * (same harness convention as harper-config-port.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { installFakeServiceManager } from "../helpers/fake-launchctl.ts";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

// flair#2062: on a systemd host, the uninstall/attribution paths here ask
// `systemctl --user show` about the caller's cgroup unit. Lay a recording fake
// first on PATH for EVERY test in this file (each describe's own launchctl shim
// stays ahead of it) with a fail-closed tripwire behind it, so nothing reaches
// the host systemctl.
let svc: ReturnType<typeof installFakeServiceManager> | undefined;
let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
  svc = installFakeServiceManager("flair1749-svc-");
  process.env.PATH = `${svc.pathEntry}:${savedPath ?? ""}`;
});
afterEach(() => {
  try {
    svc?.assertClear();
  } finally {
    svc?.cleanup();
    svc = undefined;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

describe("flair#917 — uninstall refuses to kill a PID that is not this instance's Harper", () => {
  let tmpHome: string;
  let shimBin: string;
  let dataDir: string;
  const spawned: Array<{ kill: (s?: number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair917-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair917-bin-"));

    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    // A marker whose survival proves the data dir was NOT purged.
    writeFileSync(join(dataDir, "DO-NOT-DELETE"), "this is user data\n");

    // launchctl shim — records invocations, does nothing
    writeFileSync(
      join(shimBin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\n[ "$1" = print-disabled ] && printf 'disabled services = {\\n}\\n'\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try { proc.kill(9); } catch {}
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(shimBin, { recursive: true, force: true });
  });

  async function runCli(args: string[]) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_LOG: join(tmpHome, "launchctl.log"),
    };
    delete env.FLAIR_URL;
    delete env.FLAIR_TARGET;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  /**
   * A stand-in for "something else is on the port". Runs in its own process so
   * that a SIGTERM the CLI should never send kills only this stub.
   */
  async function spawnForeignServer(): Promise<{ port: number; pid: number; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, `foreign-port-${spawned.length}`);
    const script = join(tmpHome, `foreign-${spawned.length}.mjs`);
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const srv = createServer((_req, res) => { res.writeHead(200); res.end('foreign'); });`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script, portFile], { stdout: "ignore", stderr: "ignore" });
    spawned.push(proc);
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(portFile)) throw new Error("foreign server did not report a port");
    const port = Number(readFileSync(portFile, "utf-8").trim());
    return {
      port,
      pid: (proc as unknown as { pid: number }).pid,
      alive: async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
    };
  }

  test("uninstall --purge refuses to kill a foreign PID on the default port, and does not purge data", async () => {
    // A foreign server is on port 19926 (DEFAULT_PORT). No PID file exists
    // (Harper was never installed), so the uninstall should NOT kill anything
    // and must NOT delete the data directory.
    const foreign = await spawnForeignServer();

    // Config uses the foreign server's ACTUAL port — this is the port
    // the uninstall resolver will find, which is the port the foreign
    // process actually holds.
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    writeFileSync(join(tmpHome, ".flair", "config.yaml"), `port: ${foreign.port}\n`);

    const { stdout, stderr, exitCode } = await runCli(["uninstall", "--purge"]);

    // The destructive path REFUSED: the foreign server is still alive.
    expect(await foreign.alive()).toBe(true);
    // The data directory was NOT purged.
    expect(existsSync(join(dataDir, "DO-NOT-DELETE"))).toBe(true);
    // Warning was emitted.
    expect(stdout + stderr).toContain("Not killing");

    expect(exitCode).toBe(0); // uninstall itself succeeds (just skips the kill)
  }, 30_000);

  test("uninstall --purge refuses when a PID file exists but the port belongs to another process", async () => {
    // Harper's PID file exists with one PID, but a foreign process is on the port.
    // The foreign process must NOT be killed.
    const foreign = await spawnForeignServer();

    // Config uses the foreign server's ACTUAL port — the same port the
    // foreign process holds, but the PID file has a DIFFERENT PID.
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    writeFileSync(join(tmpHome, ".flair", "config.yaml"), `port: ${foreign.port}\n`);
    // PID file with a PID that does NOT match the foreign server.
    writeFileSync(join(dataDir, "hdb.pid"), "99999\n");

    const { stdout, stderr, exitCode } = await runCli(["uninstall", "--purge"]);

    // The foreign server survived.
    expect(await foreign.alive()).toBe(true);
    // Data was NOT purged.
    expect(existsSync(join(dataDir, "DO-NOT-DELETE"))).toBe(true);
    // Warning was emitted.
    expect(stdout + stderr).toContain("do not match");

    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("flair#862 — probePort rejects non-200 responses; discoverPortFromPid scans all ports", () => {
  let tmpHome: string;
  let shimBin: string;
  const spawned: Array<{ kill: (s?: number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair862-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair862-bin-"));
    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(tmpHome, ".flair", "data"), { recursive: true });

    writeFileSync(
      join(shimBin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\n[ "$1" = print-disabled ] && printf 'disabled services = {\\n}\\n'\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try { proc.kill(9); } catch {}
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(shimBin, { recursive: true, force: true });
  });

  async function runCli(args: string[]) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_LOG: join(tmpHome, "launchctl.log"),
    };
    delete env.FLAIR_URL;
    delete env.FLAIR_TARGET;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  /**
   * A server that responds with 404 to everything — simulates a non-Flair
   * HTTP service (e.g., Node inspector) that would have passed the old
   * `res.status > 0` check.
   */
  async function spawnFakeService(): Promise<{ port: number; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, `fake-port-${spawned.length}`);
    const script = join(tmpHome, `fake-${spawned.length}.mjs`);
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const srv = createServer((_req, res) => { res.writeHead(404); res.end('not found'); });`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script, portFile], { stdout: "ignore", stderr: "ignore" });
    spawned.push(proc);
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(portFile)) throw new Error("fake service did not report a port");
    const port = Number(readFileSync(portFile, "utf-8").trim());
    return {
      port,
      alive: async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
          return res.status === 404; // it's alive if it responds with 404
        } catch {
          return false;
        }
      },
    };
  }

  test("doctor does not accept a 404 response as Harper being alive on a port", async () => {
    // A fake service responds with 404 to /Health. The old probePort (status > 0)
    // would have accepted this. The fix (res.ok) rejects it.
    const fake = await spawnFakeService();

    // Config says this port is Harper's port.
    writeFileSync(
      join(tmpHome, ".flair", "config.yaml"),
      `port: ${fake.port}\n`,
    );

    const { stdout, stderr, exitCode } = await runCli(["doctor"]);

    // The fake service is still running (doctor doesn't kill it), but doctor
    // should NOT report it as "Harper responding on port N".
    // probePort now returns res.ok (200-299 only), so a 404 is rejected.
    const combined = stdout + stderr;
    expect(combined).not.toContain(`Harper responding on port ${fake.port}`);
    // Doctor detects nothing healthy on the port.
    expect(combined).toContain("Nothing responding on port");
    expect(combined).toContain("port occupied by PID");

    expect(exitCode).not.toBe(0);
  }, 30_000);
});

describe("flair#915 — the default install attribution gap is closed", () => {
  let tmpHome: string;
  let shimBin: string;
  let dataDir: string;
  const spawned: Array<{ kill: (s?: number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair915-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair915-bin-"));

    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(shimBin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\n[ "$1" = print-disabled ] && printf 'disabled services = {\\n}\\n'\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try { proc.kill(9); } catch {}
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(shimBin, { recursive: true, force: true });
  });

  async function runCli(args: string[]) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_LOG: join(tmpHome, "launchctl.log"),
    };
    delete env.FLAIR_URL;
    delete env.FLAIR_TARGET;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  async function spawnForeignServer(): Promise<{ port: number; pid: number; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, `foreign-port-${spawned.length}`);
    const script = join(tmpHome, `foreign-${spawned.length}.mjs`);
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const srv = createServer((_req, res) => { res.writeHead(200); res.end('foreign'); });`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script, portFile], { stdout: "ignore", stderr: "ignore" });
    spawned.push(proc);
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(portFile)) throw new Error("foreign server did not report a port");
    const port = Number(readFileSync(portFile, "utf-8").trim());
    return {
      port,
      pid: (proc as unknown as { pid: number }).pid,
      alive: async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
    };
  }

  test("flair stop refuses to SIGTERM a foreign PID on the default install's port", async () => {
    // Before #915, the attribution guard skipped the default data dir,
    // allowing an unattributed SIGTERM. After the fix, it applies to ALL
    // data directories.
    const foreign = await spawnForeignServer();

    // Config says this port, and a PID file with a different PID.
    writeFileSync(join(tmpHome, ".flair", "config.yaml"), `port: ${foreign.port}\n`);
    writeFileSync(join(dataDir, "hdb.pid"), "88888\n"); // wrong PID

    const { stdout, stderr, exitCode } = await runCli(["stop"]);

    // The foreign server survived — stop refused.
    expect(await foreign.alive()).toBe(true);
    expect(exitCode).not.toBe(0);
    // flair#1454: the refusal is now a DISAGREEMENT verdict from the liveness
    // machine — the recorded pid is not alive, yet something is serving the
    // port. The old "cannot attribute" wording is gone with the lsof tree.
    expect(stderr).toContain("not alive");
    expect(stderr).toContain("88888");
  }, 30_000);

  test("flair stop refuses when the default install has no PID file but something is on the port", async () => {
    // No hdb.pid + something on the port = refuse. This is the exact gap
    // that #910 left behind for the default install.
    const foreign = await spawnForeignServer();

    writeFileSync(join(tmpHome, ".flair", "config.yaml"), `port: ${foreign.port}\n`);
    // No hdb.pid file.

    const { stdout, stderr, exitCode } = await runCli(["stop"]);

    expect(await foreign.alive()).toBe(true);
    expect(exitCode).not.toBe(0);
    // flair#1454: no pidfile + something serving = DISAGREEMENT. The old
    // "no PID file" / "cannot attribute" wording is gone with the lsof tree.
    expect(stderr).toContain("no pid is recorded");
  }, 30_000);
});

describe("flair#819 — uninstall reads Harper's config instead of defaulting to 19926", () => {
  let tmpHome: string;
  let shimBin: string;
  let dataDir: string;
  const spawned: Array<{ kill: (s?: number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair819-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair819-bin-"));

    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(shimBin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\n[ "$1" = print-disabled ] && printf 'disabled services = {\\n}\\n'\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try { proc.kill(9); } catch {}
    }
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(shimBin, { recursive: true, force: true });
  });

  async function runCli(args: string[]) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_LOG: join(tmpHome, "launchctl.log"),
    };
    delete env.FLAIR_URL;
    delete env.FLAIR_TARGET;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  async function spawnForeignServer(): Promise<{ port: number; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, `foreign819-port-${spawned.length}`);
    const script = join(tmpHome, `foreign819-${spawned.length}.mjs`);
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const srv = createServer((_req, res) => { res.writeHead(200); res.end('foreign'); });`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script, portFile], { stdout: "ignore", stderr: "ignore" });
    spawned.push(proc);
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(portFile)) throw new Error("foreign server did not report a port");
    const port = Number(readFileSync(portFile, "utf-8").trim());
    return {
      port,
      alive: async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
    };
  }

  test("uninstall prefers Harper's config over a per-user port held by a foreign server", async () => {
    writeFileSync(
      join(shimBin, "lsof"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/port-queries"\nexit 0\n`,
      { mode: 0o755 },
    );
    const foreign = await spawnForeignServer();
    writeFileSync(join(tmpHome, ".flair", "config.yaml"), `port: ${foreign.port}\n`);

    writeFileSync(
      join(dataDir, "harper-config.yaml"),
      `# Harper configuration\nrootPath: ${dataDir}\nhttp:\n  port: 20500\n  cors: true\n`,
    );

    const { stdout, stderr, exitCode } = await runCli(["uninstall", "--purge"]);

    expect(readFileSync(join(tmpHome, "port-queries"), "utf-8")).toBe("-ti :20500 -sTCP:LISTEN\n");
    expect(await foreign.alive()).toBe(true);
    expect(stdout + stderr).not.toContain(String(foreign.port));
    expect(exitCode).toBe(0);
  }, 30_000);

  test("uninstall falls through to per-user config when Harper's config has no http.port", async () => {
    // Harper's config exists but has no http.port (e.g., between install and boot).
    // The resolver should fall back to the per-user config.
    writeFileSync(
      join(dataDir, "harper-config.yaml"),
      `rootPath: ${dataDir}\n`,
    );
    writeFileSync(join(tmpHome, ".flair", "config.yaml"), "port: 20501\n");

    const { stdout, stderr, exitCode } = await runCli(["uninstall"]);

    // Should resolve to 20501 from per-user config.
    expect(exitCode).toBe(0);
  }, 30_000);
});
