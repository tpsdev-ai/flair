/**
 * wiring-consumers.test.ts — flair#1778 slice 2c-i-a1.
 *
 * Every migrated consumer: a range/tag/unsupported/malformed spec is now
 * PRESENT-BUT-NOT-COMPARABLE (its raw token) instead of null-therefore-absent,
 * while a concrete `version` and an unpinned `none` keep today's outcome
 * byte-for-byte. The last case is the invariant that matters: feeding the
 * consumer's pin to the existing fail-closed guard makes it HOLD.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectWiredFlairMcp, extractFlairMcpPin } from "../../src/doctor-client.js";
import { extractPiFlairPin } from "../../src/install/clients.js";
import { listOwnedPinTargets, readOwnedPin } from "../../src/lib/owned-pins.js";
import { pinWriteWouldLowerOrIsUnknown } from "../../src/lib/upgrade-status.js";

const MCP = "@tpsdev-ai/flair-mcp";
const PI = "@tpsdev-ai/pi-flair";

let homes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "flair-wiring-consumer-"));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

/** Write a cursor MCP config whose flair entry runs `spec` verbatim. */
function wireCursor(homeDir: string, spec: string): void {
  mkdirSync(join(homeDir, ".cursor"), { recursive: true });
  writeFileSync(
    join(homeDir, ".cursor", "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          flair: {
            command: "npx",
            args: ["-y", spec],
            // `present` requires an agent id (readJsonFlairBlock).
            env: { FLAIR_AGENT_ID: "wiring-consumer-agent", FLAIR_URL: "http://127.0.0.1:9926" },
          },
        },
      },
      null,
      2,
    ),
  );
}

function cursorTarget(homeDir: string) {
  return listOwnedPinTargets(homeDir).find((t) => t.kind === "mcp-client" && t.id === "cursor");
}

describe("consumer: doctor-client extractFlairMcpPin", () => {
  test("version and none keep today's outcome", () => {
    expect(extractFlairMcpPin(`args: ["-y", "${MCP}@0.55.0"]`)).toBe("0.55.0");
    expect(extractFlairMcpPin(`npx -y ${MCP}`)).toBeNull(); // unpinned
  });

  test("range / tag / unsupported / malformed are PRESENT, not null", () => {
    expect(extractFlairMcpPin(`${MCP}@^0.55.0`)).toBe("^0.55.0");
    expect(extractFlairMcpPin(`${MCP}@~0.55`)).toBe("~0.55");
    expect(extractFlairMcpPin(`${MCP}@latest`)).toBe("latest");
    expect(extractFlairMcpPin(`${MCP}@v0.55.0`)).toBe("v0.55.0"); // not normalised
    expect(extractFlairMcpPin(`${MCP}@1.2.3.4`)).toBe("1.2.3.4");
    expect(extractFlairMcpPin(`${MCP}@file:../x`)).toBe("file:../x");
  });
});

describe("consumer: doctor-client detectWiredFlairMcp", () => {
  test("a range wiring reports the raw token, not null", () => {
    const h = freshHome();
    wireCursor(h, `${MCP}@^0.55.0`);
    expect(detectWiredFlairMcp(h)).toEqual({ wired: true, pinnedVersion: "^0.55.0" });
  });
  test("a concrete pin is unchanged; a bare wiring is wired-but-unpinned", () => {
    const h1 = freshHome();
    wireCursor(h1, `${MCP}@0.55.0`);
    expect(detectWiredFlairMcp(h1)).toEqual({ wired: true, pinnedVersion: "0.55.0" });
    const h2 = freshHome();
    wireCursor(h2, MCP);
    expect(detectWiredFlairMcp(h2)).toEqual({ wired: true, pinnedVersion: null });
  });
});

describe("consumer: owned-pins readOwnedPin", () => {
  test("a range wiring reads as its raw token (present), a version as itself, a bare entry as null", () => {
    const h1 = freshHome();
    wireCursor(h1, `${MCP}@^0.55.0`);
    const t1 = cursorTarget(h1)!;
    expect(t1).toBeDefined();
    expect(readOwnedPin(t1, h1).pin).toBe("^0.55.0");

    const h2 = freshHome();
    wireCursor(h2, `${MCP}@0.55.0`);
    expect(readOwnedPin(cursorTarget(h2)!, h2).pin).toBe("0.55.0");

    const h3 = freshHome();
    wireCursor(h3, MCP);
    expect(readOwnedPin(cursorTarget(h3)!, h3).pin).toBeNull();
  });

  test("THE INVARIANT: the consumer's pin makes the existing fail-closed guard HOLD on a range", () => {
    const h = freshHome();
    wireCursor(h, `${MCP}@^0.55.0`);
    const pin = readOwnedPin(cursorTarget(h)!, h).pin;
    // Before this migration `pin` was null, and the guard reads null as
    // "nothing to protect" → the refresh OVERWRITES the range. Now it holds.
    expect(pin).toBe("^0.55.0");
    expect(pinWriteWouldLowerOrIsUnknown(pin, "0.56.0")).toBe(true);
    // …and a concrete behind pin is still refreshed UP (positive control).
    expect(pinWriteWouldLowerOrIsUnknown("0.55.0", "0.56.0")).toBe(false);
  });
});

describe("consumer: clients extractPiFlairPin", () => {
  test("version and none unchanged; a range is present, not null", () => {
    expect(extractPiFlairPin(`npm:${PI}@0.55.0`)).toBe("0.55.0");
    expect(extractPiFlairPin(`npm:${PI}`)).toBeNull();
    expect(extractPiFlairPin(`npm:${PI}@^0.55.0`)).toBe("^0.55.0");
    expect(extractPiFlairPin(`npm:${PI}@latest`)).toBe("latest");
  });
});
