import { expect } from "bun:test";

/**
 * flair#3050: the clauses a Codex config-content refusal message must carry, written out here rather
 * than imported from production, so that removing or altering any of these literal substrings in
 * src/install/clients.ts fails a test. They are substring checks: text added around them is not checked.
 */
export const CODEX_CONDITION_CLAUSES = [
  "Flair edits Codex's config only when its content meets all of these conditions:",
  "(1) the file is UTF-8 whose bytes round-trip;",
  "(2) nothing but Flair's exact [mcp_servers.flair] section, or nothing at all, defines mcp_servers.flair:",
  "no [mcp_servers] table (put its entries in [mcp_servers.<name>] tables)",
  "no dotted or inline mcp_servers key",
  "no quoted or spaced mcp_servers.flair header",
  "no extra [mcp_servers.flair.<name>] table;",
  `(3) no triple-quote delimiter text (""" or '''), even in a comment, comes before [mcp_servers.flair],`,
  "and with no section none appears anywhere, because Flair appends the section at the end of the file;",
  "(4) an existing [mcp_servers.flair] section is exactly the shape Flair writes: edit it, or remove it and its [mcp_servers.flair.*] tables so Flair appends a fresh one.",
  "Fix any that do not hold and re-run flair init; if Flair still cannot read the file as safe, configure Codex by hand.",
  "These cover the file's content only: the pin guard (for example, an existing pin newer than this flair) and a failed write can still stop wiring.",
] as const;

/** Every clause is present in the refusal message. */
export function expectCodexConditionClauses(message: string): void {
  for (const clause of CODEX_CONDITION_CLAUSES) expect(message).toContain(clause);
}
