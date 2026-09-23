/**
 * flair#1853 round 3 — ONE home resolver for the keystore and the config
 * writers, with the platform rule.
 *
 * `HOME || USERPROFILE || homedir()` looked uniform but is wrong on Windows:
 * Node's `os.homedir()` uses `USERPROFILE`, while a POSIX-style shell (Git Bash,
 * MSYS, Cygwin) can set `HOME` to something else. Preferring `HOME` there moved
 * `~/.flair/keys` away from the real key dir, so an existing key read as missing.
 * The rule is now platform-split: Windows uses `USERPROFILE`, everywhere else
 * uses `HOME`, both falling back to `os.homedir()`.
 *
 * These tests stub `process.platform`, so they exercise both branches on any
 * host. They never touch a real home: every home here is a fixture under the OS
 * temp dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHome } from "../../src/lib/home.ts";
import { keysDir, keyPath, keystore } from "../../src/keystore.ts";
import { resolveHome as clientsResolveHome } from "../../src/install/clients.ts";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
afterEach(() => {
  setEnv("HOME", savedHome);
  setEnv("USERPROFILE", savedProfile);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run `body` with `process.platform` stubbed, restored afterwards. */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("resolveHome platform rule (flair#1853)", () => {
  test("win32: USERPROFILE wins over HOME, and an existing keystore key still loads", () => {
    const profile = scratch("flair-home-win-profile-");
    const wrongHome = scratch("flair-home-win-elsewhere-");
    process.env.HOME = wrongHome;
    process.env.USERPROFILE = profile;

    withPlatform("win32", () => {
      expect(resolveHome()).toBe(profile);
      // The config writers share the same resolver (clients.ts has no private copy).
      expect(clientsResolveHome()).toBe(profile);
      expect(keysDir()).toBe(join(profile, ".flair", "keys"));

      const seed = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
      keystore.setPrivateKeySeed("fixture-key", seed);
      expect(existsSync(keyPath("fixture-key"))).toBe(true);
      // The key landed under USERPROFILE, and nothing was written under HOME.
      expect(existsSync(join(wrongHome, ".flair", "keys"))).toBe(false);
      expect(Array.from(keystore.getPrivateKeySeed("fixture-key") ?? [])).toEqual([...seed]);
    });
  });

  test("posix: HOME wins and an in-process HOME change is followed", () => {
    const first = scratch("flair-home-posix-a-");
    const second = scratch("flair-home-posix-b-");
    process.env.USERPROFILE = "/must/be/ignored/on/posix";

    withPlatform("linux", () => {
      process.env.HOME = first;
      expect(resolveHome()).toBe(first);
      expect(clientsResolveHome()).toBe(first);
      expect(keysDir()).toBe(join(first, ".flair", "keys"));

      process.env.HOME = second;
      expect(resolveHome()).toBe(second);
      expect(keysDir()).toBe(join(second, ".flair", "keys"));
    });
  });
});
