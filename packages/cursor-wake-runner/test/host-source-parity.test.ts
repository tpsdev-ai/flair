import { describe, expect, test } from "bun:test";
// The server's validator, imported directly: resources/host-source.ts is PURE
// (zero imports), so the test can run it without Harper — the way the
// flair-mcp tests import server modules. The runner itself never imports
// server code; it mirrors the grammar (src/receipt.ts), and this file is what
// keeps the mirror honest.
import { HOST_SOURCE_URL_MAX, validateHostSource } from "../../../resources/host-source.ts";
import { cursorLaunchHostSource, isAcceptableHostSourceId, isAcceptableHostSourceUrl } from "../src/index.ts";

// flair#1944 — for every input, the runner keeps a hostSource value exactly
// when the server's validateHostSource accepts it. A runner that keeps more
// gets its receipt refused (a 400); one that keeps less drops a citation the
// server would have stored. The server NFC-normalises BEFORE it checks, so the
// mirror must too.

const BASE_URL = "https://cursor.example/";

function serverAcceptsId(id: string): boolean {
  return validateHostSource({ v: 1, host: "cursor", kind: "launch", id }).ok;
}

function serverAcceptsUrl(url: string): boolean {
  return validateHostSource({ v: 1, host: "cursor", kind: "launch", id: "bc-1", url }).ok;
}

const ID_CASES: Array<[string, string]> = [
  ["a Cursor bc- id", "bc-0f1e2d3c-4b5a-8978-8675-4433221100aa"],
  ["every grammar punctuation", "a.b_c:d/e@f#g-h"],
  ["256 characters (the cap)", "a".repeat(256)],
  ["257 characters", "a".repeat(257)],
  ["255 ASCII + KELVIN SIGN (256 after NFC)", `${"a".repeat(255)}K`],
  ["256 ASCII + KELVIN SIGN (257 after NFC)", `${"a".repeat(256)}K`],
  ["empty", ""],
  ["a space", "not a valid id"],
  ["a query character", "bc-1?x"],
  ["a percent", "bc-1%20"],
  ["a NUL", "bc-\u0000"],
  ["a C1 control (U+0085)", "bc-\u0085"],
  ["an RLO bidi override", "bc-‮1"],
  ["an LRM", "bc-‎1"],
  ["an isolate (U+2066)", "bc-⁦1"],
  ["a precomposed é", "bc-é"],
  ["a decomposed é", "bc-é"],
  ["the KELVIN SIGN alone (NFC -> ASCII K)", "K"],
  ["an id ending in the KELVIN SIGN", "bc-K"],
  ["the ANGSTROM SIGN (NFC -> Å, still non-ASCII)", "bc-Å"],
  ["a full-width letter", "bc-ａ"],
  ["a lone high surrogate", "bc-\uD800"],
  ["an astral code point", "bc-\u{1F600}"],
];

const URL_CASES: Array<[string, string]> = [
  ["a plain https url", `${BASE_URL}agents/bc-1`],
  ["upper-case scheme", "HTTPS://cursor.example/x"],
  ["a query and fragment", `${BASE_URL}x?a=1#f`],
  ["a port", "https://cursor.example:8443/x"],
  ["http", "http://cursor.example/x"],
  ["a javascript: url", "javascript:alert(1)"],
  ["userinfo", "https://u:p@cursor.example/x"],
  ["user only", "https://u@cursor.example/x"],
  ["EMPTY userinfo", "https://@cursor.example/x"],
  ["an @ in the path (not userinfo)", `${BASE_URL}a@b`],
  ["an @ in the query", `${BASE_URL}x?a=@b`],
  ["at the cap", BASE_URL + "a".repeat(HOST_SOURCE_URL_MAX - BASE_URL.length)],
  ["one over the cap", BASE_URL + "a".repeat(HOST_SOURCE_URL_MAX - BASE_URL.length + 1)],
  ["far over the cap", BASE_URL + "a".repeat(2100)],
  // U+0958 is a composition exclusion: NFC turns each into TWO code units, so a
  // url under the cap before normalisation is over it after.
  ["under the cap raw, over it after NFC (U+0958)", BASE_URL + "क़".repeat(1100)],
  ["at the cap after NFC (decomposed é shortens it)", BASE_URL + "a".repeat(HOST_SOURCE_URL_MAX - BASE_URL.length - 1) + "é"],
  ["not a url", "not a url"],
  ["empty", ""],
  ["a NUL", `${BASE_URL}\u0000`],
  ["an RLO", `${BASE_URL}‮x`],
  ["an LRM in the host", "https://cursor‎.example/x"],
  ["a non-ASCII host (IDN)", "https://cürsor.example/x"],
  ["a punycode host", "https://xn--crsor-kva.example/x"],
  ["a full-width host", "https://ｃｕｒｓｏｒ.example/x"],
  ["the KELVIN SIGN in the host", "https://Kursor.example/x"],
  ["a decomposed é in the host", "https://cúrsor.example/x"],
  ["a full-width @ in the authority", "https://u＠cursor.example/x"],
  ["a precomposed é in the path", `${BASE_URL}é`],
  ["a decomposed é in the path", `${BASE_URL}é`],
  ["the KELVIN SIGN in the path", `${BASE_URL}K`],
  ["an astral code point in the path", `${BASE_URL}\u{1F600}`],
  ["a lone surrogate in the path", `${BASE_URL}\uDC00`],
  ["a space", `${BASE_URL}a b`],
  ["a backslash authority", "https:\\\\cursor.example\\x"],
];

describe("flair#1944 — the runner's host-source mirror agrees with the server's validateHostSource", () => {
  for (const [name, id] of ID_CASES) {
    test(`id: ${name}`, () => {
      expect(isAcceptableHostSourceId(id)).toBe(serverAcceptsId(id));
    });
  }

  for (const [name, url] of URL_CASES) {
    test(`url: ${name}`, () => {
      expect(isAcceptableHostSourceUrl(url)).toBe(serverAcceptsUrl(url));
    });
  }

  test("every code point U+0000-U+10FFFF (lone surrogates included), in an id and in a url, is judged the same way", () => {
    const disagreements: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      // fromCharCode keeps a lone surrogate lone; fromCodePoint builds a pair.
      const ch = cp <= 0xffff ? String.fromCharCode(cp) : String.fromCodePoint(cp);
      const id = `bc-${ch}`;
      if (isAcceptableHostSourceId(id) !== serverAcceptsId(id)) disagreements.push(`id U+${cp.toString(16)}`);
      const url = `${BASE_URL}${ch}`;
      if (isAcceptableHostSourceUrl(url) !== serverAcceptsUrl(url)) disagreements.push(`url U+${cp.toString(16)}`);
      if (disagreements.length > 20) break;
    }
    expect(disagreements).toEqual([]);
  }, 60_000);

  test("whatever hostSource the runner builds, the server accepts it and stores its NFC form", () => {
    let built = 0;
    for (const [, id] of ID_CASES) {
      for (const [, url] of URL_CASES) {
        const { hostSource } = cursorLaunchHostSource(id, url);
        if (!hostSource) continue;
        built += 1;
        const r = validateHostSource({ v: 1, ...hostSource });
        expect(r.ok, `server refused ${JSON.stringify(hostSource).slice(0, 80)}`).toBe(true);
        if (r.ok) {
          expect(r.value).toEqual({
            v: 1,
            host: "cursor",
            kind: "launch",
            id: hostSource.id.normalize("NFC"),
            ...(hostSource.url !== undefined ? { url: hostSource.url.normalize("NFC") } : {}),
          });
        }
      }
    }
    expect(built, "the cross product exercised real sources").toBeGreaterThan(0);
  });
});
