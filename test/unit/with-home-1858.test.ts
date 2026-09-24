/**
 * withHome() overrides the home on EVERY platform (flair#1858 round 2).
 *
 * The three private `withHome()` helpers in doctor-client / owned-pins /
 * uninstall-purge swapped only `process.env.HOME`. `resolveHome()` reads
 * `USERPROFILE` on win32, so on Windows the "explicit homeDir" override was
 * silently ignored — doctor, the pin refresh and uninstall's `unwire()` acted on
 * the real profile instead of the directory the caller named. There is now ONE
 * `withHome()` in `src/lib/home.ts`; it sets BOTH variables and restores both
 * exactly.
 *
 * Platform is stubbed, so both branches run on any host. No real home is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolveHome, withHome } from "../../src/lib/home.ts";

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
});

function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("withHome sets the override on BOTH HOME and USERPROFILE (flair#1858 r2)", () => {
  test("win32: withHome(dir, () => resolveHome()) returns dir (red before: HOME-only)", () => {
    const dir = "/tmp/flair-1858-withhome-win";
    process.env.HOME = "/elsewhere/home";
    process.env.USERPROFILE = "/the/real/profile";
    withPlatform("win32", () => {
      expect(withHome(dir, () => resolveHome())).toBe(dir);
    });
    // Both restored exactly.
    expect(process.env.HOME).toBe("/elsewhere/home");
    expect(process.env.USERPROFILE).toBe("/the/real/profile");
  });

  test("posix: withHome(dir, () => resolveHome()) returns dir", () => {
    const dir = "/tmp/flair-1858-withhome-posix";
    process.env.HOME = "/elsewhere/home";
    process.env.USERPROFILE = "/the/real/profile";
    withPlatform("linux", () => {
      expect(withHome(dir, () => resolveHome())).toBe(dir);
    });
    expect(process.env.HOME).toBe("/elsewhere/home");
    expect(process.env.USERPROFILE).toBe("/the/real/profile");
  });

  test("both are restored exactly when both were previously SET", () => {
    process.env.HOME = "/h1";
    process.env.USERPROFILE = "/p1";
    withHome("/other", () => resolveHome());
    expect(process.env.HOME).toBe("/h1");
    expect(process.env.USERPROFILE).toBe("/p1");
  });

  test("both are restored exactly when both were previously UNSET", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    withHome("/other", () => resolveHome());
    expect("HOME" in process.env).toBe(false);
    expect("USERPROFILE" in process.env).toBe(false);
  });

  test("both are restored when fn throws", () => {
    process.env.HOME = "/h2";
    process.env.USERPROFILE = "/p2";
    expect(() =>
      withHome("/other", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.env.HOME).toBe("/h2");
    expect(process.env.USERPROFILE).toBe("/p2");
  });

  test("the type contract rejects a Promise-returning callback", () => {
    // A sync save/restore around async work would restore the environment before
    // the work runs. The `@ts-expect-error` is load-bearing: if the callback type
    // ever accepts a Promise, the strict test-suite typecheck reports the unused
    // directive (TS2578) and the lane goes red. The `if (false)` keeps the call
    // type-checked but never executed, so no real env is touched.
    if (false as boolean) {
      // @ts-expect-error — async callback must not compile.
      withHome("/tmp/flair-1858-async", async () => {});
    }
    expect(typeof withHome).toBe("function");
  });
});
