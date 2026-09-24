import { join } from "node:path";

/**
 * socket-path-limit.ts — the OS cap on a Unix domain socket's path.
 *
 * A Unix domain socket (the Harper operations API's `operations-server` socket)
 * is bind()ed at a filesystem path, and that path is stored in a
 * `struct sockaddr_un` whose `sun_path` field is a fixed-size buffer. The
 * kernel counts the trailing NUL terminator, so the USABLE path length is one
 * byte shorter than the field size:
 *
 *    - macOS (darwin):  `sun_path` is 104 bytes  -> 103 usable
 *    - Linux:          `sun_path` is 108 bytes  -> 107 usable
 *
 * (darwin and freebsd: <sys/un.h>'s `SUNPATH_MAX`; linux: un(7) / the 108-byte
 * `sa_data` minus the NUL. See also the macOS `listen()  EINVAL` behaviour
 * for a path that overflows the buffer.)
 *
 * Harper's operations API socket lives at `<data-dir>/operations-server`, so a
 * long `flair init --data-dir <dir>` can push it past the cap, and `listen`
 * dies with a bare `EINVAL` that names neither the socket nor the limit
 * (flair#916). These pure predicates let callers refuse a too-long data dir
 * BEFORE anything is written to disk, and say exactly what is wrong and how to
 * fix it.
 */

/**
 * The suffix appended to a data dir to form the operations-socket path,
 * INCLUDING the leading separator. A single 18-byte constant — the part of the
 * socket path that no amount of shortening the data dir can remove.
 */
export const OPS_SOCKET_SUFFIX = "/operations-server";

/**
 * The usable (NUL-excluded) maximum length of a Unix socket path, in BYTES,
 * for a platform. macOS (darwin) and FreeBSD both have a 104-byte sun_path,
 * so 103 usable; Linux has a 108-byte sun_path, so 107 usable. Any unknown
 * platform takes the Linux limit of 107.
 * Unknown platforms fall back to 107 because no real platform is looser than
 * Linux's — falling back lower would refuse a path that is actually legal.
 */
export function socketPathLimit(platform: string): number {
  return platform === "darwin" || platform === "freebsd" ? 103 : 107;
}

/**
 * The result of checking a socket path against its platform's limit.
 *
 * - OK: the path fits (`bytes <= limit`).
 * - refusal: the path overflows, carrying the measured byte length, the limit,
 *   and `over` — how many bytes past the limit it is (and therefore how many
 *   bytes shorter the data dir must become).
 */
export type SocketPathLengthCheck =
  | { ok: true; bytes: number; limit: number }
  | { ok: false; bytes: number; limit: number; over: number };

/**
 * Measure a socket path in BYTES (not characters — a multibyte path counts each
 * byte of its UTF-8 encoding) against its platform's `sun_path`-derived limit.
 * Returns OK when `bytes <= limit`; otherwise a refusal.
 */
export function checkSocketPathLength(
  path: string,
  platform: string,
): SocketPathLengthCheck {
  const limit = socketPathLimit(platform);
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= limit) return { ok: true, bytes, limit };
  return { ok: false, bytes, limit, over: bytes - limit };
}

/**
 * Type guard: true when a socket-path check is a refusal (the path overflowed
 * its platform's limit). An explicit type predicate — not control-flow
 * narrowing — so it narrows the refusal branch even under `strict: false`
 * (tsconfig.cli.json turns off strictNullChecks, which disables discriminated
 * union narrowing).
 */
export function isSocketPathRefusal(
  check: SocketPathLengthCheck,
): check is Extract<SocketPathLengthCheck, { ok: false }> {
  return !check.ok;
}

/**
 * An actionable refusal message for a socket path that exceeds its platform's
 * `sun_path` limit. Names the actual constraint — the socket path itself, its
 * byte length, the platform limit — and the remedy: how many bytes shorter the
 * `--data-dir` must be (the `/operations-server` suffix is fixed, so the data
 * dir is the only part that can move).
 *
 * Pure: it only formats. The caller decides whether to print and exit.
 */
export function socketPathTooLongMessage(
  socketPath: string,
  dataDir: string,
  check: Extract<SocketPathLengthCheck, { ok: false }>,
): string {
  const [head, ...tail] = [
    "Error: the Harper operations socket path is too long for this OS — Harper",
    "would die with a bare `listen EINVAL` instead. Refusing before touching disk.",
    "",
    `  Operations socket: ${socketPath}`,
    `  Path length:      ${check.bytes} bytes`,
    `  OS limit:         ${check.limit} bytes (Unix-domain-socket sun_path, counting the trailing NUL)`,
    `  Data directory:   ${dataDir}`,
    "",
    "The socket is always <data-dir>/operations-server, so that suffix is fixed.",
    "Choose a --data-dir that is at least " +
      `${check.over} byte${check.over === 1 ? "" : "s"} shorter, so the socket path` +
      " fits within " +
      `${check.limit} bytes.`,
  ];
  return head + "\n" + tail.join("\n");
}

/**
 * CLI preflight for the operations socket. Builds the socket path from a data
 * directory exactly as Harper binds it (`<data-dir>/operations-server`) and,
 * unless it fits the platform's `sun_path` limit, returns the actionable refusal
 * message. Returns `null` when the path fits.
 *
 * This is the single gate every command that could bind the socket runs —
 * `flair init` (which accepts `--data-dir` and is the only command whose data
 * dir a user can make long today), and `flair start` / `flair restart` (whose
 * `defaultDataDir()` is always the short `~/.flair/data`, so this is defensive
 * there: a future `--data-dir` or a lengthened default would be caught too).
 * Pure — it only builds and formats; the caller decides whether to print and
 * exit, so it is unit-testable without `process.exit`.
 */
export function opsSocketPathRefusal(
  dataDir: string,
  platform: string,
): string | null {
  const socketPath = join(dataDir, "operations-server");
  const check = checkSocketPathLength(socketPath, platform);
  if (isSocketPathRefusal(check)) {
      return socketPathTooLongMessage(socketPath, dataDir, check);
      }
   return null;
}
