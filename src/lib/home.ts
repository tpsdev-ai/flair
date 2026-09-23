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
