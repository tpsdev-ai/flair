/**
 * listener-table-2526.test.ts — flair#2526, the OS listener-table reader the
 * HTTP/ops pair check proves its pair from (src/lib/listener-table.ts).
 *
 * The parsers run on output captured from real hosts: macOS `lsof -nP
 * -iTCP:<port> -sTCP:LISTEN -Fp` and Linux `/proc/net/tcp` / `/proc/net/tcp6`
 * (header and rows as a Linux 6.12 host prints them). The readers run against
 * injected I/O standing in for lsof and `/proc`, including a missing tool and
 * an unreadable table, each refused by name. The real tables are read by
 * test/unit/doctor-roster-probed-instance-2483.test.ts and the real-Harper
 * integration tests.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LISTENER_VISIBILITY_REMEDY,
  parseLsofListenerPids,
  parseProcNetTcpListenInodes,
  parsePsLstart,
  readProcessBirth,
  readTcpListenerPids,
  type ListenerTableIo,
} from "../../src/lib/listener-table.js";

// Captured from a spawned Harper on macOS: HTTP port 58448, pid 51067.
const LSOF_ONE = "p51067\nf460\n";

// Captured shapes from a Linux 6.12 host. Port 0x902D = 36909 on
// 127.0.0.1 (LISTEN), 0x9015 = 36885 on [::] (LISTEN); one ESTABLISHED (01)
// row on 36909 and one LISTEN row on another port.
const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TCP = [
  TCP_HEADER,
  "   0: 0100007F:902D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 53147756 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:26C5 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2060 1 0000000000000000 100 0 0 10 0",
  "   2: 0100007F:902D 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 53150001 1 0000000000000000 20 4 30 10 -1",
  "",
].join("\n");
const TCP6_HEADER = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TCP6 = [
  TCP6_HEADER,
  "   0: 00000000000000000000000000000000:9015 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 53146606 1 0000000000000000 100 0 0 10 0",
  "",
].join("\n");

describe("parseLsofListenerPids — macOS `lsof -Fp` output", () => {
  test("the p line names the pid; f lines are ignored", () => {
    expect(parseLsofListenerPids(LSOF_ONE)).toEqual([51067]);
  });

  test("two processes are both reported, sorted; one process with two sockets is reported once", () => {
    expect(parseLsofListenerPids("p2002\nf7\np1001\nf5\n")).toEqual([1001, 2002]);
    expect(parseLsofListenerPids("p1001\nf5\nf9\n")).toEqual([1001]);
  });

  test("no output is no listener", () => {
    expect(parseLsofListenerPids("")).toEqual([]);
  });

  test("a p line that is not a process id makes the output unusable", () => {
    expect(parseLsofListenerPids("pabc\nf5\n")).toBeNull();
    expect(parseLsofListenerPids("p0\n")).toBeNull();
  });
});

describe("parseProcNetTcpListenInodes — Linux /proc/net/tcp and tcp6", () => {
  test("a LISTEN row on the port yields its inode; an ESTABLISHED row on the same port does not", () => {
    expect(parseProcNetTcpListenInodes(TCP, 36909)).toEqual(["53147756"]);
  });

  test("the IPv6 table's port is read the same way", () => {
    expect(parseProcNetTcpListenInodes(TCP6, 36885)).toEqual(["53146606"]);
    expect(parseProcNetTcpListenInodes(TCP6, 36909)).toEqual([]);
  });

  test("a port nothing listens on yields no inode", () => {
    expect(parseProcNetTcpListenInodes(TCP, 4242)).toEqual([]);
  });

  test("a header-only table yields no inode; a truncated row makes the table unusable", () => {
    expect(parseProcNetTcpListenInodes(`${TCP_HEADER}\n`, 36909)).toEqual([]);
    expect(parseProcNetTcpListenInodes(`${TCP_HEADER}\n   0: 0100007F:902D 00000000:0000 0A\n`, 36909)).toBeNull();
  });
});

/** A fake `/proc` with these tables and pid → fd links. */
function fakeProc(opts: {
  tcp?: string | null;
  tcp6?: string | null;
  fds: Record<string, Record<string, string> | "EACCES">;
}): Partial<ListenerTableIo> {
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return {
    platform: "linux",
    readFile: (path) => {
      const text = path === "/proc/net/tcp" ? opts.tcp : path === "/proc/net/tcp6" ? opts.tcp6 : undefined;
      if (text === undefined || text === null) throw enoent(path);
      return text;
    },
    readDir: (path) => {
      if (path === "/proc") return [...Object.keys(opts.fds), "self", "net"];
      const m = /^\/proc\/([0-9]+)\/fd$/.exec(path);
      const entry = m ? opts.fds[m[1]] : undefined;
      if (entry === "EACCES") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      if (!entry) throw enoent(path);
      return Object.keys(entry);
    },
    readLink: (path) => {
      const m = /^\/proc\/([0-9]+)\/fd\/([0-9]+)$/.exec(path);
      const entry = m ? opts.fds[m[1]] : undefined;
      if (!entry || entry === "EACCES" || !(m![2] in entry)) throw enoent(path);
      return entry[m![2]];
    },
    runLsof: () => { throw new Error("the Linux reader must not run lsof"); },
  };
}

describe("readTcpListenerPids — Linux reads /proc, no external tool", () => {
  test("the process holding the LISTEN inode is the listener", () => {
    const io = fakeProc({
      tcp: TCP,
      tcp6: TCP6,
      fds: { "3792276": { "71": "socket:[53146606]", "242": "socket:[53147756]" }, "999": { "3": "socket:[2060]", "4": "/dev/null" } },
    });
    expect(readTcpListenerPids(36909, io)).toEqual({ kind: "listeners", pids: [3792276] });
    expect(readTcpListenerPids(36885, io)).toEqual({ kind: "listeners", pids: [3792276] });
  });

  test("a socket inherited by two processes reports both", () => {
    const io = fakeProc({ tcp: TCP, tcp6: TCP6, fds: { "10": { "5": "socket:[53147756]" }, "11": { "5": "socket:[53147756]" } } });
    expect(readTcpListenerPids(36909, io)).toEqual({ kind: "listeners", pids: [10, 11] });
  });

  test("no LISTEN row on the port is no listener", () => {
    expect(readTcpListenerPids(4242, fakeProc({ tcp: TCP, tcp6: TCP6, fds: {} }))).toEqual({ kind: "listeners", pids: [] });
  });

  test("a host with no IPv6 table still reads the IPv4 one", () => {
    const io = fakeProc({ tcp: TCP, tcp6: null, fds: { "77": { "9": "socket:[53147756]" } } });
    expect(readTcpListenerPids(36909, io)).toEqual({ kind: "listeners", pids: [77] });
  });

  test("an unreadable /proc/net/tcp is refused by name", () => {
    const read = readTcpListenerPids(36909, fakeProc({ tcp: null, tcp6: TCP6, fds: {} }));
    expect(read.kind).toBe("unavailable");
    if (read.kind === "unavailable") {
      expect(read.reason).toBe("this check reads the listener table from /proc/net/tcp, which cannot be read (ENOENT)");
      expect(read.remedy).toContain("/proc mounted");
    }
  });

  test("a LISTEN socket whose owner cannot be found or inspected is refused, not reported empty", () => {
    const read = readTcpListenerPids(36909, fakeProc({ tcp: TCP, tcp6: TCP6, fds: { "1": "EACCES" } }));
    expect(read).toEqual({
      kind: "unavailable",
      reason: "TCP port 36909 has a listening socket (inode 53147756) whose owner could not be found or inspected in /proc/<pid>/fd (the process may have exited, or this user may not inspect it)",
      remedy: LISTENER_VISIBILITY_REMEDY,
    });
  });
});

describe("readTcpListenerPids — every other platform runs lsof", () => {
  const darwin = (runLsof: ListenerTableIo["runLsof"]): Partial<ListenerTableIo> => ({ platform: "darwin", runLsof });

  test("it runs `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` and reports its pids", () => {
    let seen: string[] = [];
    const read = readTcpListenerPids(58448, darwin((args) => { seen = args; return LSOF_ONE; }));
    expect(seen).toEqual(["-nP", "-iTCP:58448", "-sTCP:LISTEN", "-Fp"]);
    expect(read).toEqual({ kind: "listeners", pids: [51067] });
  });

  test("lsof exiting 1 with no output is no listener", () => {
    const read = readTcpListenerPids(58448, darwin(() => { throw Object.assign(new Error("exit 1"), { status: 1, stdout: "" }); }));
    expect(read).toEqual({ kind: "listeners", pids: [] });
  });

  test("lsof missing is refused by name, with the command it would run and a remedy", () => {
    const read = readTcpListenerPids(58448, darwin(() => { throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }); }));
    expect(read).toEqual({
      kind: "unavailable",
      reason: "lsof is not installed or not on PATH, and this check reads the listener table with `lsof -nP -iTCP:58448 -sTCP:LISTEN -Fp`",
      remedy: "Install lsof or put it on PATH (macOS ships it as /usr/sbin/lsof), then re-run this command on the host where Harper runs.",
    });
  });

  test("lsof failing any other way is refused, naming how", () => {
    const killed = readTcpListenerPids(58448, darwin(() => { throw Object.assign(new Error("timeout"), { signal: "SIGKILL", status: null }); }));
    expect(killed.kind === "unavailable" && killed.reason).toBe("`lsof -nP -iTCP:58448 -sTCP:LISTEN -Fp` was stopped by SIGKILL");
    const failed = readTcpListenerPids(58448, darwin(() => { throw Object.assign(new Error("exit 2"), { status: 2, stdout: "" }); }));
    expect(failed.kind === "unavailable" && failed.reason).toBe("`lsof -nP -iTCP:58448 -sTCP:LISTEN -Fp` exited 2");
  });

  test("unusable lsof output is refused", () => {
    expect(readTcpListenerPids(58448, darwin(() => "pnope\n")).kind).toBe("unavailable");
  });

  test.skipIf(process.platform === "linux")("the real reader, in a process whose PATH holds no lsof, is refused by name", () => {
    // A child process, because the test runner's own PATH lookup is fixed at
    // its start.
    const script = `import { readTcpListenerPids } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "lib", "listener-table.ts"))};`
      + "console.log(JSON.stringify(readTcpListenerPids(58448)));";
    const run = spawnSync(process.execPath, ["-e", script], { env: { ...({ PATH: "/nonexistent-2526", HOME: tmpdir() }), FLAIR_TEST_ALLOW_BUN_HARPER: "exercise listener-table-2526 process fixture arguments" }, encoding: "utf-8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    const read = JSON.parse(run.stdout.trim());
    expect(read.kind).toBe("unavailable");
    expect(read.reason).toStartWith("lsof is not installed or not on PATH");
  });
});

// A real /proc/<pid>/stat line (Linux 6.12); field 22 (starttime) is 53146213.
// The comm contains a space and a ")" to pin the last-")" split.
const PROC_STAT = "3792276 (node (x) y) S 3792187 3792187 3792187 0 -1 4194560 113921 0 0 0 1180 222 0 0 20 0 11 0 53146213 13278784000 130764 18446744073709551615 1 1 0 0 0 0 0 4096 134234626 0 0 0 17 3 0 0 0 0 0";

describe("readProcessBirth — a listener's birth identity (pid plus start time)", () => {
  test("Linux reads field 22 of /proc/<pid>/stat", () => {
    const read = readProcessBirth(3792276, {
      platform: "linux",
      readFile: (path) => { if (path !== "/proc/3792276/stat") throw new Error(path); return PROC_STAT; },
      runPs: () => { throw new Error("the Linux reader must not run ps"); },
    });
    expect(read).toEqual({ kind: "birth", id: "3792276@53146213" });
  });

  test("Linux: a stat file that is gone (the process exited) is refused by name", () => {
    const read = readProcessBirth(42, { platform: "linux", readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    expect(read.kind === "unavailable" && read.reason).toBe("the start time of process 42 cannot be read from /proc/42/stat (ENOENT); it may have exited");
  });

  test("elsewhere it runs `ps -o lstart= -p <pid>` and keeps the start to the second", () => {
    let seen: string[] = [];
    const read = readProcessBirth(51067, { platform: "darwin", runPs: (args) => { seen = args; return "Tue Oct 13 02:26:23 2026\n"; } });
    expect(seen).toEqual(["-o", "lstart=", "-p", "51067"]);
    expect(read).toEqual({ kind: "birth", id: "51067@Tue Oct 13 02:26:23 2026" });
  });

  test("parsePsLstart accepts the C-locale form, with a space-padded day, and nothing else", () => {
    expect(parsePsLstart("Fri Oct  9 20:40:34 2026   \n")).toBe("Fri Oct  9 20:40:34 2026");
    expect(parsePsLstart("")).toBeNull();
    expect(parsePsLstart("vendredi 9 octobre 2026")).toBeNull();
  });

  test("ps missing, ps finding no process, and unreadable ps output are each refused by name", () => {
    const missing = readProcessBirth(7, { platform: "darwin", runPs: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    expect(missing.kind === "unavailable" && missing.reason).toBe("ps is not installed or not on PATH, and this check reads a process's start time with `ps -o lstart= -p 7`");
    const gone = readProcessBirth(7, { platform: "darwin", runPs: () => { throw Object.assign(new Error("exit 1"), { status: 1 }); } });
    expect(gone.kind === "unavailable" && gone.reason).toBe("`ps -o lstart= -p 7` found no start time (exit 1); process 7 may have exited");
    const garbled = readProcessBirth(7, { platform: "darwin", runPs: () => "soon" });
    expect(garbled.kind).toBe("unavailable");
  });

  test("the real reader names this test process's own birth", () => {
    const read = readProcessBirth(process.pid);
    expect(read.kind).toBe("birth");
    if (read.kind === "birth") expect(read.id).toStartWith(`${process.pid}@`);
  });
});
