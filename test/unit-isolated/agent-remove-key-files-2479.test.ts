import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindCli, register, removeAgentKeyFiles, type AgentCli } from "../../src/commands/agent.js";
import { rotationBackupStamp } from "../../src/lib/agent-key-file.js";
import { setInstancePairOsReadsForTests } from "../../src/lib/local-instance-pair.js";

let dir: string;
let keysDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2479-key-files-"));
  keysDir = join(dir, "keys");
  mkdirSync(keysDir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("removeAgentKeyFiles (flair#2479)", () => {
  test("returns only successful unlinks when another candidate cannot be unlinked", () => {
    const key = join(keysDir, "agent-a.key");
    mkdirSync(key);
    const contents = join(key, "contents");
    writeFileSync(contents, "not-a-real-secret");
    const pub = join(keysDir, "agent-a.pub");
    writeFileSync(pub, "not-a-real-secret");
    const canonicalPub = realpathSync(pub);

    expect(removeAgentKeyFiles("agent-a", keysDir)).toEqual({ removed: [canonicalPub], manual: false });
    expect(existsSync(contents)).toBe(true);
    expect(existsSync(pub)).toBe(false);
  });

  test("skips a symlink to another filename inside the keys directory", () => {
    const target = join(keysDir, "agent-b.key");
    writeFileSync(target, "not-a-real-secret");
    const link = join(keysDir, "agent-a.key");
    symlinkSync(target, link);

    expect(removeAgentKeyFiles("agent-a", keysDir)).toEqual({ removed: [], manual: false });
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  test("returns no removals when unlink fails", () => {
    const candidate = join(keysDir, "agent-a.key");
    mkdirSync(candidate);
    const contents = join(candidate, "contents");
    writeFileSync(contents, "not-a-real-secret");

    expect(removeAgentKeyFiles("agent-a", keysDir)).toEqual({ removed: [], manual: false });
    expect(existsSync(contents)).toBe(true);
  });

  test("returns no removals when the keys path cannot be resolved", () => {
    writeFileSync(join(dir, "file"), "not-a-real-secret");

    expect(removeAgentKeyFiles("agent-a", join(dir, "file", "keys"))).toEqual({ removed: [], manual: false });
  });

  test("returns no removals for an unresolvable candidate", () => {
    const link = join(keysDir, "agent-a.key");
    symlinkSync(join(dir, "missing"), link);

    expect(removeAgentKeyFiles("agent-a", keysDir)).toEqual({ removed: [], manual: false });
    expect(() => realpathSync(link)).toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("invalid ids require manual cleanup and leave their files in place", () => {
    const key = join(keysDir, "bad.id.key");
    writeFileSync(key, "not-a-real-secret");

    expect(removeAgentKeyFiles("bad.id", keysDir)).toEqual({ removed: [], manual: true });
    expect(existsSync(key)).toBe(true);
  });
  test("removes timestamped backups and preserves another agent's file and an external symlink target", () => {
    const backups = [new Date("2031-02-03T04:05:06.007Z"), new Date("2031-02-03T04:05:07.008Z")]
      .map(date => rotationBackupStamp(date))
      .map(stamp => join(keysDir, `agent-a.key.bak.${stamp}`));
    for (const backup of backups) writeFileSync(backup, "old seed");
    const canonicalBackups = backups.map(path => realpathSync(path));
    const notes = join(keysDir, "agent-a.key.bak.notes");
    writeFileSync(notes, "keep notes");
    const other = join(keysDir, "agent-b.key.bak.2031-02-03T04-05-06-007Z");
    const target = join(dir, "target");
    writeFileSync(other, "other seed");
    writeFileSync(target, "target seed");
    const link = join(keysDir, "agent-a.key.bak.2031-02-03T04-05-08-009Z");
    symlinkSync(target, link);

    const result = removeAgentKeyFiles("agent-a", keysDir);

    expect(readFileSync(notes, "utf8")).toBe("keep notes");
    expect(result.manual).toBe(false);
    expect(result.removed.sort()).toEqual(canonicalBackups.sort());
    for (const backup of backups) expect(existsSync(backup)).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("other seed");
    expect(readFileSync(target, "utf8")).toBe("target seed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("removes retained staging keys and skips symlinks and other staging names", () => {
    const staged = join(keysDir, ".agent-a.key.tmp-0123456789abcdef");
    writeFileSync(staged, "replacement seed");
    const canonical = realpathSync(staged);
    const target = join(dir, "target");
    writeFileSync(target, "target seed");
    const link = join(keysDir, ".agent-a.key.tmp-fedcba9876543210");
    symlinkSync(target, link);
    const others = [".agent-b.key.tmp-0123456789abcdef", ".agent-a.key.tmp-abc", ".agent-a.key.tmp-0123456789abcdef.extra"];
    for (const name of others) writeFileSync(join(keysDir, name), "keep");

    expect(removeAgentKeyFiles("agent-a", keysDir)).toEqual({ removed: [canonical], manual: false });
    expect(existsSync(staged)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("target seed");
    for (const name of others) expect(readFileSync(join(keysDir, name), "utf8")).toBe("keep");
  });

  for (const keepKeys of [false, true]) {
    test(`agent remove retains staging keys: ${keepKeys}`, async () => {
      const staged = join(keysDir, ".agent-a.key.tmp-0123456789abcdef");
      writeFileSync(staged, "replacement seed");
      const backup = join(keysDir, `agent-a.key.bak.${rotationBackupStamp()}`);
      const notes = join(keysDir, "agent-a.key.bak.notes");
      writeFileSync(backup, "old seed");
      writeFileSync(notes, "keep notes");
      setInstancePairOsReadsForTests({
        listeners: () => ({ kind: "listeners", pids: [2479] }),
        birth: () => ({ kind: "birth", id: "2479@simulated" }),
        commandLine: () => "node\u0000/simulated/node_modules/harper/dist/bin/harper.js\u0000run\u0000.",
      });
      const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.operation === "get_configuration") return Response.json({
          http: { port: "127.0.0.1:19926" }, operationsApi: { network: { port: "127.0.0.1:19925" } },
        });
        if (body.table === "Agent" && body.operation === "search_by_value") {
          return Response.json([{ id: "agent-a", name: "Agent A" }]);
        }
        return Response.json([]);
      }) as typeof globalThis.fetch);
      const log = spyOn(console, "log").mockImplementation(() => {});
      const unused = () => { throw new Error("unexpected CLI helper call"); };
      bindCli({
        resolveOpsPort: () => 19925,
        api: unused,
        b64url: unused,
        privKeyPath: unused,
        pubKeyPath: unused,
        shouldShowInlineSecretWarning: unused,
        resolveHttpPort: unused,
        resolveAgentHomeTarget: unused,
        resolveEffectiveOpsUrl: unused,
        seedAgentViaOpsApi: unused,
        seedAgentWithLocalHome: unused,
        agentRecordIsAdmin: unused,
      } satisfies AgentCli);
      const cmd = new Command();
      register(cmd);
      try {
        await cmd.parseAsync([
          "agent", "remove", "agent-a", "--force", "--admin-user", "admin",
          "--admin-pass", "fixture-password", "--keys-dir", keysDir,
          ...(keepKeys ? ["--keep-keys"] : []),
        ], { from: "user" });
        expect(existsSync(staged)).toBe(keepKeys);
        expect(existsSync(backup)).toBe(keepKeys);
        expect(readFileSync(notes, "utf8")).toBe("keep notes");
        if (keepKeys) expect(readFileSync(backup, "utf8")).toBe("old seed");
        if (keepKeys) expect(readFileSync(staged, "utf8")).toBe("replacement seed");
      } finally {
        setInstancePairOsReadsForTests(null);
        fetch.mockRestore();
        log.mockRestore();
      }
    });
  }

});
