/**
 * The user's home directory, resolved at CALL time (flair#1853).
 *
 * `os.homedir()` is cached at process start, so a HOME set later in the same
 * process is invisible to it. Every Flair surface that resolves `~` — the
 * keystore and the client config writers — must land on the SAME home, and it
 * must be the one the calling shell actually uses.
 *
 * Which environment variable names that home differs by platform:
 *
 *   - **Windows** — `USERPROFILE` is authoritative. Node's `os.homedir()` reads
 *     it, but a POSIX-style shell (Git Bash, MSYS, Cygwin) may set `HOME` to a
 *     different path. Preferring `HOME` there would move `~/.flair/keys` away
 *     from where the keys actually live, so an existing key would read as
 *     missing (and a new one would be written somewhere nothing looks).
 *   - **Everywhere else** — `HOME` is authoritative (and is how the test harness
 *     redirects a process), with `os.homedir()` as the fallback.
 */

import { homedir } from "node:os";

/** The home directory for this invocation, resolved at call time. */
export function resolveHome(): string {
  return process.platform === "win32"
    ? process.env.USERPROFILE || homedir()
    : process.env.HOME || homedir();
}

/**
 * Run `fn` with BOTH `HOME` and `USERPROFILE` pointed at `homeDir`, then restore
 * both to exactly what they were — including the previously-UNSET case, and even
 * when `fn` throws. Returns `fn`'s value.
 *
 * `resolveHome()` reads `USERPROFILE` on win32 and `HOME` elsewhere, so setting
 * only `HOME` silently ignored the override on Windows: doctor, the pin refresh
 * and uninstall's `unwire()` then acted on the real profile instead of the
 * directory the caller named. Both are set here, so the override holds on every
 * platform.
 *
 * `fn` MUST be synchronous. The parameter type REJECTS a Promise-returning
 * callback at compile time (a Promise is not assignable to the `never` branch),
 * because a sync save/restore around async work would restore the environment
 * before the work runs.
 */
export function withHome<T>(homeDir: string, fn: () => T extends Promise<unknown> ? never : T): T {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}
