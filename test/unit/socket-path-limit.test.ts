import { describe, it, expect } from "bun:test";
import {
  checkSocketPathLength,
  socketPathLimit,
  socketPathTooLongMessage,
  OPS_SOCKET_SUFFIX,
} from "../../src/lib/socket-path-limit.ts";

/**
 * flair#916 — `flair init --data-dir <long>` dies with a bare `listen EINVAL`
 * because the ops socket (`<data-dir>/operations-server`) is a Unix domain
 * socket whose path is capped by `sun_path`. These are the pure predicates an
 * operator-facing preflight must make BEFORE anything is written to disk.
 *
 * The cap is fixed per OS and INCLUDES the trailing NUL, so the USABLE length
 * is one byte less: darwin and freebsd sun_path 104 → 103 usable; linux sun_path 108 → 107
 * usable. Unknown platforms fall back to the Linux value (107).
 */

describe("socketPathLimit (flair#916 — sun_path, NUL-excluded)", () => {
  it("darwin and freebsd are 103 usable bytes; linux is 107", () => {
    expect(socketPathLimit("darwin")).toBe(103);
    expect(socketPathLimit("freebsd")).toBe(103);
    expect(socketPathLimit("linux")).toBe(107);
  });

  it("an unknown platform falls back to the Linux limit (107)", () => {
    // A wrong cap is a false refusal, so the conservative fallback must be the
    // one real platforms report — and none are looser than linux.
    expect(socketPathLimit("win32")).toBe(107);
    expect(socketPathLimit("")).toBe(107);
    expect(socketPathLimit("some-future-os")).toBe(107);
  });

  it("the ops-socket suffix is the literal '/operations-server' (18 bytes)", () => {
    expect(OPS_SOCKET_SUFFIX).toBe("/operations-server");
    expect(Buffer.byteLength(OPS_SOCKET_SUFFIX, "utf8")).toBe(18);
  });
});

describe("checkSocketPathLength (flair#916)", () => {
  it("exactly at the Linux limit is ok; one byte over refuses with correct numbers", () => {
    const at = checkSocketPathLength("a".repeat(107), "linux");
    expect(at.ok).toBe(true);
    if (at.ok) {
      expect(at.bytes).toBe(107);
      expect(at.limit).toBe(107);
    }
    const over = checkSocketPathLength("a".repeat(108), "linux");
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.bytes).toBe(108);
      expect(over.limit).toBe(107);
      expect(over.over).toBe(1);
    }
  });

  it("exactly at the darwin limit is ok; one byte over refuses with correct numbers", () => {
    const at = checkSocketPathLength("a".repeat(103), "darwin");
    expect(at.ok).toBe(true);
    if (at.ok) {
      expect(at.bytes).toBe(103);
      expect(at.limit).toBe(103);
    }
    const over = checkSocketPathLength("a".repeat(104), "darwin");
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.bytes).toBe(104);
      expect(over.limit).toBe(103);
      expect(over.over).toBe(1);
    }
  });

  it("exactly at the FreeBSD limit is ok; one byte over refuses with correct numbers", () => {
    const at = checkSocketPathLength("a".repeat(103), "freebsd");
    expect(at.ok).toBe(true);
    if (at.ok) {
      expect(at.bytes).toBe(103);
      expect(at.limit).toBe(103);
      }
    const over = checkSocketPathLength("a".repeat(104), "freebsd");
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.bytes).toBe(104);
      expect(over.limit).toBe(103);
      expect(over.over).toBe(1);
      }
    });

  it("counts multibyte paths in BYTES, not characters", () => {
    // U+20AC (€) is 3 bytes in UTF-8. 40 of them is 40 chars but 120 bytes —
    // short on a char count, long on a byte count. The cap is on bytes.
    const s = "€".repeat(40);
    expect(s.length).toBe(40);
    expect(Buffer.byteLength(s, "utf8")).toBe(120);

    // 40 one-byte chars (120 bytes if they were multibyte) stays under both
    // limits — proving the comparison is byte-based, not char-based.
    expect(checkSocketPathLength("a".repeat(40), "linux").ok).toBe(true);
    expect(checkSocketPathLength("a".repeat(40), "darwin").ok).toBe(true);

    // The same 40 chars, multibyte (120 bytes), refuses on BOTH platforms and
    // reports the byte length, not the char count.
    const onLinux = checkSocketPathLength(s, "linux");
    expect(onLinux.ok).toBe(false);
    if (!onLinux.ok) {
      expect(onLinux.bytes).toBe(120);
      expect(onLinux.over).toBe(13); // 120 - 107
    }
    const onDarwin = checkSocketPathLength(s, "darwin");
    expect(onDarwin.ok).toBe(false);
    if (!onDarwin.ok) {
      expect(onDarwin.bytes).toBe(120);
      expect(onDarwin.over).toBe(17); // 120 - 103
    }
  });

  it("reports the over-count as bytes past the limit (not the char count)", () => {
    // 110-byte path vs the 107-byte Linux limit → 3 bytes over.
    const r = checkSocketPathLength("a".repeat(110), "linux");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.over).toBe(3);
  });
});

describe("socketPathTooLongMessage (flair#916)", () => {
  it("names the socket path, the byte length, the limit, and how many bytes shorter", () => {
    const dataDir = "/tmp/flair-916-init-abc/".padEnd(96, "x"); // > 90, pushes the socket over 107
    const socketPath = dataDir + OPS_SOCKET_SUFFIX;
    const check = checkSocketPathLength(socketPath, "linux");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("fixture: expected a refusal");

    const msg = socketPathTooLongMessage(socketPath, dataDir, check);

    // What it is.
    expect(msg).toContain(socketPath);
    expect(msg).toContain("operations-server");
    // Its byte length and the limit.
    expect(msg).toContain(`${check.bytes}`);
    expect(msg).toContain(`${check.limit}`);
    // The remedy names how many bytes shorter.
    expect(msg).toContain(`${check.over}`);
    expect(msg).toContain("--data-dir");
    // It is a refusal, not a success.
    expect(/too long/i.test(msg)).toBe(true);
  });
});
