import { describe, expect, test } from "bun:test";
import { httpStatus } from "../helpers/http-status";

describe("httpStatus matcher", () => {
  // The string below is the real CI failure: `flair orgevent` succeeded, but
  // the generated id contains "4052", so a bare not.toContain("405") failed.
  const successOutputWithUnluckyId =
    "✓ OrgEvent published as 'flair679-e2e-agent': kind=status → flint\n" +
    "  id: flair679-e2e-agent-49e40526-ea22-4fde-af83-db0ac1f2e3b4\n";

  test("ignores the status digits when they are embedded in an identifier", () => {
    expect(successOutputWithUnluckyId).not.toMatch(httpStatus(405));
  });

  test("still matches a real status code in the shapes the CLI emits", () => {
    for (const output of [
      "request failed: HTTP 405",
      "status 405 Method Not Allowed",
      "405: /Soul does not have a post method",
      "server responded (405)",
      "405",
    ]) {
      expect(output).toMatch(httpStatus(405));
    }
  });

  test("does not match a longer number that merely contains the code", () => {
    expect("listening on port 4050").not.toMatch(httpStatus(405));
    expect("wrote 1405 bytes").not.toMatch(httpStatus(405));
  });

  test("distinguishes between codes", () => {
    expect("HTTP 400").not.toMatch(httpStatus(405));
    expect("HTTP 400").toMatch(httpStatus(400));
  });
});
