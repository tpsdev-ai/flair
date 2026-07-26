/**
 * Matchers for asserting that CLI output does or does not carry a given HTTP
 * status code.
 *
 * These exist because a bare `expect(output).not.toContain("405")` is unsound
 * against CLI output: the CLI prints generated record ids, and a random UUID
 * containing those three digits fails the assertion even though the command
 * succeeded. That is not hypothetical — a run of the `flair orgevent` e2e test
 * failed on the id `flair679-e2e-agent-49e40526-…`, whose UUID contains "4052".
 *
 * Requiring the code to stand alone as its own token keeps "HTTP 405",
 * "status 405" and "405:" matching while ignoring digits embedded in an
 * identifier, since every character inside a hex UUID segment is a word
 * character and therefore yields no word boundary.
 */

/** Matches `code` only where it appears as a standalone token. */
export function httpStatus(code: number): RegExp {
  return new RegExp(`\\b${code}\\b`);
}
