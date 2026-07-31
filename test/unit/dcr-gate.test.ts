// dcr-gate.test.ts — resources/dcr-gate.ts.
//
// The property that matters most here is not "a wrong token is refused" but
// "there is no configuration in which registration is on AND open". Enabling
// registration and supplying its credential are the same act, so the failure
// mode this replaces — an endpoint anyone on the internet may write rows
// through — cannot be reached by forgetting a setting. The cases below assert
// that as a shape, by enumerating what each configuration does.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  dcrEnabled,
  decideRegistration,
  initialAccessToken,
  initialAccessTokenMatches,
  presentedInitialAccessToken,
  INITIAL_ACCESS_TOKEN_HEADER,
  MIN_INITIAL_ACCESS_TOKEN_LEN,
  MAX_INITIAL_ACCESS_TOKEN_LEN,
  __resetDcrWarningForTest,
} from "../../resources/dcr-gate.ts";

const GOOD = "a".repeat(MIN_INITIAL_ACCESS_TOKEN_LEN);
const ALSO_GOOD = "b".repeat(MIN_INITIAL_ACCESS_TOKEN_LEN + 8);

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FLAIR_OAUTH_DCR_TOKEN;
  delete process.env.FLAIR_OAUTH_DCR_TOKEN;
  __resetDcrWarningForTest();
});
afterEach(() => {
  if (saved === undefined) delete process.env.FLAIR_OAUTH_DCR_TOKEN;
  else process.env.FLAIR_OAUTH_DCR_TOKEN = saved;
});

function req(headers: Record<string, string> = {}): any {
  return { headers: { get: (n: string) => headers[n.toLowerCase()] ?? null, asObject: headers } };
}

describe("registration is off unless an operator turns it on", () => {
  test("DEFAULT: no variable set → disabled", () => {
    expect(dcrEnabled()).toBe(false);
    expect(decideRegistration(req())).toEqual({ allowed: false, reason: "disabled" });
  });

  test("an empty or whitespace value is still disabled", () => {
    for (const v of ["", "   ", "\t"]) {
      process.env.FLAIR_OAUTH_DCR_TOKEN = v;
      expect(dcrEnabled()).toBe(false);
    }
  });

  test("a token too short to be a credential DISABLES registration rather than enabling it weakly", () => {
    // A short shared secret on an unauthenticated public endpoint is nearer to
    // open than to closed. Degrading to almost-off would be worse than off,
    // because only one of the two is visible to the operator.
    process.env.FLAIR_OAUTH_DCR_TOKEN = "short";
    expect(initialAccessToken()).toBeUndefined();
    expect(dcrEnabled()).toBe(false);
    expect(decideRegistration(req({ [INITIAL_ACCESS_TOKEN_HEADER]: "short" })))
      .toEqual({ allowed: false, reason: "disabled" });
  });

  test("exactly the minimum length is accepted; one character less is not", () => {
    process.env.FLAIR_OAUTH_DCR_TOKEN = "x".repeat(MIN_INITIAL_ACCESS_TOKEN_LEN);
    expect(dcrEnabled()).toBe(true);
    process.env.FLAIR_OAUTH_DCR_TOKEN = "x".repeat(MIN_INITIAL_ACCESS_TOKEN_LEN - 1);
    expect(dcrEnabled()).toBe(false);
  });

  test("exactly the maximum length is accepted; one byte more is not", () => {
    // The upper bound exists because the comparison is over fixed-width
    // buffers. Out of range must DISABLE registration with a message, never
    // silently fail every comparison for a reason no operator could deduce.
    process.env.FLAIR_OAUTH_DCR_TOKEN = "x".repeat(MAX_INITIAL_ACCESS_TOKEN_LEN);
    expect(dcrEnabled()).toBe(true);
    __resetDcrWarningForTest();
    process.env.FLAIR_OAUTH_DCR_TOKEN = "x".repeat(MAX_INITIAL_ACCESS_TOKEN_LEN + 1);
    expect(dcrEnabled()).toBe(false);
  });

  test("the bound is on BYTES, not characters — a multi-byte token cannot slip past it", () => {
    // "é" is two UTF-8 bytes, so this is under the limit by character count and
    // over it by byte count. The buffer the comparison uses is sized in bytes.
    process.env.FLAIR_OAUTH_DCR_TOKEN = "é".repeat(MAX_INITIAL_ACCESS_TOKEN_LEN - 10);
    expect(dcrEnabled()).toBe(false);
  });

  test("THE SHAPE: there is no value of the variable that enables registration WITHOUT a credential", () => {
    // Anything that switches registration on is, by construction, also the token
    // a caller has to present. Enumerating the interesting spellings that might
    // be mistaken for "on, no credential" on some other design.
    for (const v of ["1", "true", "on", "yes", "open", "enabled"]) {
      process.env.FLAIR_OAUTH_DCR_TOKEN = v;
      __resetDcrWarningForTest();
      const enabled = dcrEnabled();
      if (enabled) {
        // If such a value ever DID enable it, an empty presentation must still fail.
        expect(decideRegistration(req())).not.toEqual({ allowed: true });
      } else {
        expect(decideRegistration(req())).toEqual({ allowed: false, reason: "disabled" });
      }
    }
  });
});

describe("when registration is enabled", () => {
  beforeEach(() => { process.env.FLAIR_OAUTH_DCR_TOKEN = GOOD; });

  test("POSITIVE CONTROL: the right token is allowed", () => {
    expect(decideRegistration(req({ [INITIAL_ACCESS_TOKEN_HEADER]: GOOD }))).toEqual({ allowed: true });
  });

  test("no token at all is refused as invalid_token, not as disabled", () => {
    // The distinction matters to the operator reading the response: 'disabled'
    // means change the server, 'invalid_token' means change the client.
    expect(decideRegistration(req())).toEqual({ allowed: false, reason: "invalid_token" });
  });

  test("a wrong token is refused", () => {
    expect(decideRegistration(req({ [INITIAL_ACCESS_TOKEN_HEADER]: ALSO_GOOD })))
      .toEqual({ allowed: false, reason: "invalid_token" });
  });

  test("a correct PREFIX of the token is refused", () => {
    expect(initialAccessTokenMatches(GOOD.slice(0, GOOD.length - 1))).toBe(false);
  });

  test("the token with anything appended is refused", () => {
    expect(initialAccessTokenMatches(GOOD + "x")).toBe(false);
  });

  test("PADDING COLLISION: the token with trailing NULs appended is refused", () => {
    // The comparison widens both sides into a zero-padded fixed-size buffer. A
    // length prefix is what stops "tok" and "tok\0" from producing identical
    // buffers; without it this case would be accepted.
    expect(initialAccessTokenMatches(GOOD + "\0")).toBe(false);
    expect(initialAccessTokenMatches(GOOD + "\0\0\0")).toBe(false);
  });

  test("an over-long presentation is refused rather than throwing", () => {
    expect(initialAccessTokenMatches("y".repeat(MAX_INITIAL_ACCESS_TOKEN_LEN + 100))).toBe(false);
  });

  test("non-string presentations are refused rather than coerced", () => {
    for (const v of [undefined, null, 0, 1, true, {}, [], [GOOD]]) {
      expect(initialAccessTokenMatches(v)).toBe(false);
    }
  });

  test("an Authorization: Bearer header does NOT satisfy the gate", () => {
    // Not a preference — measured. Harper's own auth layer claims every
    // `Authorization: Bearer ...` and answers 401 before flair's code runs, so
    // that channel cannot carry this token; honouring it here would be dead
    // code that reads as a working path.
    expect(decideRegistration(req({ authorization: `Bearer ${GOOD}` })))
      .toEqual({ allowed: false, reason: "invalid_token" });
  });
});

describe("presentedInitialAccessToken", () => {
  test("reads the header, trims it, and treats blank as absent", () => {
    expect(presentedInitialAccessToken(req({ [INITIAL_ACCESS_TOKEN_HEADER]: `  ${GOOD}  ` }))).toBe(GOOD);
    expect(presentedInitialAccessToken(req({ [INITIAL_ACCESS_TOKEN_HEADER]: "   " }))).toBeUndefined();
    expect(presentedInitialAccessToken(req())).toBeUndefined();
  });

  test("survives a request with no headers object at all", () => {
    expect(presentedInitialAccessToken(undefined)).toBeUndefined();
    expect(presentedInitialAccessToken({})).toBeUndefined();
  });
});
