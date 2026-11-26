import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAgentKeyFiles } from "../../src/commands/agent.js";

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
    const backups = ["2031-02-03T04-05-06-007Z", "2031-02-03T04-05-07-008Z"]
      .map(stamp => join(keysDir, `agent-a.key.bak.${stamp}`));
    for (const backup of backups) writeFileSync(backup, "old seed");
    const canonicalBackups = backups.map(path => realpathSync(path));
    const other = join(keysDir, "agent-b.key.bak.2031-02-03T04-05-06-007Z");
    const target = join(dir, "target");
    writeFileSync(other, "other seed");
    writeFileSync(target, "target seed");
    const link = join(keysDir, "agent-a.key.bak.2031-02-03T04-05-08-009Z");
    symlinkSync(target, link);

    const result = removeAgentKeyFiles("agent-a", keysDir);

    expect(result.manual).toBe(false);
    expect(result.removed.sort()).toEqual(canonicalBackups.sort());
    for (const backup of backups) expect(existsSync(backup)).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("other seed");
    expect(readFileSync(target, "utf8")).toBe("target seed");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

});
