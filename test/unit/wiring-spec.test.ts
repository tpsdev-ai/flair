/**
 * wiring-spec.test.ts — the interim wiring-spec model (flair#1778 slice 2c-i-a1).
 *
 * The partition table: every step of the rule gets a positive and a negative
 * example. Plus the envelope decoders and the one behaviour change
 * (`wiringPinString` turns a range/tag/unsupported/malformed spec into a
 * PRESENT, NOT-COMPARABLE string instead of null).
 */
import { describe, expect, test } from "bun:test";
import {
  decodeWiringSpec,
  decodeWiringSpecs,
  partitionWiringToken,
  wiringPinString,
  isComparableWiringPin,
} from "../../src/lib/wiring-spec.js";

const MCP = "@tpsdev-ai/flair-mcp";
const PI = "@tpsdev-ai/pi-flair";

describe("partitionWiringToken — the six-step table", () => {
  // step 1 — unsupported sources
  test("step 1: file:/link:/git:/git+https:/github:/http(s): → unsupported; a plain range is not", () => {
    expect(partitionWiringToken("file:../x")).toEqual({ kind: "unsupported", value: "file:../x" });
    expect(partitionWiringToken("link:../y")).toEqual({ kind: "unsupported", value: "link:../y" });
    expect(partitionWiringToken("git:github.com/x/y")).toEqual({ kind: "unsupported", value: "git:github.com/x/y" });
    expect(partitionWiringToken("git+https://example.com/x.git")).toEqual({
      kind: "unsupported",
      value: "git+https://example.com/x.git",
    });
    expect(partitionWiringToken("github:owner/repo")).toEqual({ kind: "unsupported", value: "github:owner/repo" });
    expect(partitionWiringToken("https://example.com/x.tgz")).toEqual({
      kind: "unsupported",
      value: "https://example.com/x.tgz",
    });
    expect(partitionWiringToken("^0.55.0").kind).toBe("range-or-tag"); // negative
  });

  // step 2 — no token
  test("step 2: an empty token after @ → none; a bare version is not none", () => {
    expect(partitionWiringToken("")).toEqual({ kind: "none", value: null });
    expect(partitionWiringToken("   ")).toEqual({ kind: "none", value: null });
    expect(partitionWiringToken("0.55.0").kind).toBe("version"); // negative
  });

  // step 3 — leading v (BEFORE range recognition)
  test("step 3: /^v\\d/ → malformed, checked before range recognition; a bare version is not malformed", () => {
    expect(partitionWiringToken("v0.55.0")).toEqual({ kind: "malformed", value: "v0.55.0" });
    expect(partitionWiringToken("v1.2.3.4")).toEqual({ kind: "malformed", value: "v1.2.3.4" });
    // semver.validRange ACCEPTS v0.55.0 — this is why step 3 precedes step 5.
    expect(partitionWiringToken("0.55.0").kind).toBe("version"); // negative
  });

  // step 4 — a concrete version
  test("step 4: strict semver → version (prerelease IS a version); a 4-part version is not", () => {
    expect(partitionWiringToken("0.55.1")).toEqual({ kind: "version", value: "0.55.1" });
    // isStrictSemver = /^X.Y.Z[-prerelease][+build]$/ — a prerelease is a version.
    expect(partitionWiringToken("0.56.0-rc.1")).toEqual({ kind: "version", value: "0.56.0-rc.1" });
    expect(partitionWiringToken("0.56.0+build.7")).toEqual({ kind: "version", value: "0.56.0+build.7" });
    expect(partitionWiringToken("1.2.3.4").kind).toBe("malformed"); // negative
  });

  // step 5 — ranges and dist-tags
  test("step 5: validRange / dist-tag words → range-or-tag; a concrete version is not", () => {
    expect(partitionWiringToken("^0.55.0")).toEqual({ kind: "range-or-tag", value: "^0.55.0" });
    expect(partitionWiringToken("~0.55")).toEqual({ kind: "range-or-tag", value: "~0.55" });
    expect(partitionWiringToken("0.55")).toEqual({ kind: "range-or-tag", value: "0.55" });
    expect(partitionWiringToken(">=1.0.0 <2.0.0")).toEqual({ kind: "range-or-tag", value: ">=1.0.0 <2.0.0" });
    expect(partitionWiringToken("latest")).toEqual({ kind: "range-or-tag", value: "latest" });
    expect(partitionWiringToken("next")).toEqual({ kind: "range-or-tag", value: "next" });
    expect(partitionWiringToken("*")).toEqual({ kind: "range-or-tag", value: "*" });
    expect(partitionWiringToken("0.55.0").kind).toBe("version"); // negative
  });

  // step 6 — everything else
  test("step 6: anything else → malformed; an empty token is none, not malformed", () => {
    expect(partitionWiringToken("1.2.3.4")).toEqual({ kind: "malformed", value: "1.2.3.4" });
    expect(partitionWiringToken("not-a-version")).toEqual({ kind: "malformed", value: "not-a-version" });
    expect(partitionWiringToken("").kind).toBe("none"); // negative
  });

  test("raw token bytes are preserved verbatim (no normalisation)", () => {
    expect(partitionWiringToken("^0.55.0").value).toBe("^0.55.0");
    expect(partitionWiringToken("v0.55.0").value).toBe("v0.55.0"); // NOT normalised to 0.55.0
    expect(partitionWiringToken("latest").value).toBe("latest");
  });
});

describe("decodeWiringSpec — envelopes reduce to <pkg>@<spec>", () => {
  test("npx -y -p <pkg>@<spec>", () => {
    expect(decodeWiringSpec(`some-env npx -y -p ${MCP}@0.55.0 hook-marker`, MCP)).toMatchObject({
      pkg: MCP,
      token: { kind: "version", value: "0.55.0" },
    });
  });

  test("TOML / JSON args arrays", () => {
    expect(decodeWiringSpec(`args = ["-y", "${MCP}@0.55.0"]`, MCP)?.token).toEqual({
      kind: "version",
      value: "0.55.0",
    });
    expect(decodeWiringSpec(JSON.stringify({ mcpServers: { flair: { args: ["-y", `${MCP}@^0.55.0`] } } }), MCP)?.token).toEqual(
      { kind: "range-or-tag", value: "^0.55.0" },
    );
  });

  test("pi's npm:<pkg>@<spec>", () => {
    expect(decodeWiringSpec(`npm:${PI}@0.55.0`, PI)?.token).toEqual({ kind: "version", value: "0.55.0" });
    expect(decodeWiringSpec(`npm:${PI}`, PI)?.token).toEqual({ kind: "none", value: null });
  });

  test("a bare package with no @ is wired-but-unpinned", () => {
    expect(decodeWiringSpec(`npx -y ${MCP} flare-sessionstart`, MCP)).toMatchObject({
      token: { kind: "none", value: null },
    });
  });

  test("the workspace: protocol in a dependency field", () => {
    expect(decodeWiringSpec(`"${MCP}": "workspace:^0.55.0"`, MCP)?.token).toEqual({
      kind: "range-or-tag",
      value: "^0.55.0",
    });
    expect(decodeWiringSpec(`"${MCP}": "0.55.0"`, MCP)?.token).toEqual({ kind: "version", value: "0.55.0" });
  });

  test("boundary: a longer sibling package name is NOT read as this package's spec", () => {
    // `@tpsdev-ai/flair-mcp` inside `@tpsdev-ai/flair-mcp-extra@1.0.0` must NOT
    // match — otherwise a sibling package's pin would be read as ours.
    const sibling = `-p @tpsdev-ai/flair-mcp-extra@1.0.0`;
    expect(wiringPinString(decodeWiringSpec(sibling, MCP))).toBeNull(); // NOT "1.0.0"
    expect(decodeWiringSpecs(sibling, MCP).map((s) => s.token.kind)).toEqual(["none"]);
    // A name that merely ENDS with it, preceded by an identifier character.
    expect(wiringPinString(decodeWiringSpec(`-p x${MCP}@1.0.0`, MCP))).toBeNull();
    // POSITIVE: the real package still matches at a token boundary.
    expect(wiringPinString(decodeWiringSpec(`-p ${MCP}@1.0.0`, MCP))).toBe("1.0.0");
  });

  test("null when the package is not wired at all", () => {
    expect(decodeWiringSpec("nothing about flair here", MCP)).toBeNull();
    expect(decodeWiringSpec("", MCP)).toBeNull();
  });

  test("decodeWiringSpecs enumerates every entry, never collapsing to the first", () => {
    const text = `["-y", "${MCP}@0.55.0"], "${MCP}@0.56.0"`;
    const specs = decodeWiringSpecs(text, MCP);
    expect(specs.map((s) => s.token.value)).toEqual(["0.55.0", "0.56.0"]);
  });
});

describe("wiringPinString — the one behaviour change", () => {
  test("version → the version (today's outcome); none → null (today's outcome)", () => {
    expect(wiringPinString(decodeWiringSpec(`${MCP}@0.55.0`, MCP))).toBe("0.55.0");
    expect(wiringPinString(decodeWiringSpec(`npx -y ${MCP}`, MCP))).toBeNull();
    expect(wiringPinString(null)).toBeNull();
  });

  test("range-or-tag / unsupported / malformed → the RAW token, NOT null (no longer 'absent')", () => {
    expect(wiringPinString(decodeWiringSpec(`${MCP}@^0.55.0`, MCP))).toBe("^0.55.0");
    expect(wiringPinString(decodeWiringSpec(`${MCP}@latest`, MCP))).toBe("latest");
    expect(wiringPinString(decodeWiringSpec(`${MCP}@v0.55.0`, MCP))).toBe("v0.55.0");
    expect(wiringPinString(decodeWiringSpec(`${MCP}@1.2.3.4`, MCP))).toBe("1.2.3.4");
    expect(wiringPinString(decodeWiringSpec(`${MCP}@file:../x`, MCP))).toBe("file:../x");
  });

  test("isComparableWiringPin is true only for a concrete version", () => {
    expect(isComparableWiringPin(decodeWiringSpec(`${MCP}@0.55.0`, MCP))).toBe(true);
    expect(isComparableWiringPin(decodeWiringSpec(`${MCP}@^0.55.0`, MCP))).toBe(false);
    expect(isComparableWiringPin(decodeWiringSpec(`${MCP}@v0.55.0`, MCP))).toBe(false);
    expect(isComparableWiringPin(decodeWiringSpec(`npx -y ${MCP}`, MCP))).toBe(false);
  });
});

describe("flair#1809 review carry-overs", () => {
  test("a scoped SIBLING's pinned tail is not read as an unscoped package's spec", () => {
    // `flair-mcp@` matches inside `@tpsdev-ai/flair-mcp@`, whose preceding
    // char is the scope's "/". Before the isTokenStart "/" rejection this
    // read the sibling's 1.0.0 pin as pkg "flair-mcp"'s own.
    const spec = decodeWiringSpec("npm:@other/@tpsdev-ai/flair-mcp@1.0.0", "flair-mcp");
    expect(spec?.token.kind).toBe("none");
    expect(wiringPinString(spec)).toBeNull();
  });

  test("npm-conventional dist-tags classify as range-or-tag, not malformed", () => {
    for (const tag of ["beta", "alpha", "rc", "canary", "stable", "dev", "experimental"]) {
      expect(partitionWiringToken(tag).kind).toBe("range-or-tag");
    }
    // present-but-not-comparable either way — only the label changed
    expect(wiringPinString(decodeWiringSpec(`${MCP}@beta`, MCP))).toBe("beta");
  });
});
