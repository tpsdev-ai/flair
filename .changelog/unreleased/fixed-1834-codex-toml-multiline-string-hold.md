- **A Codex TOML pin refresh no longer rewrites a line that sits inside a multiline string.**

  The pin-only editor decided its section boundaries and located the `args` line
  by scanning raw lines, so a `"""` or `'''` string that opened and closed inside
  `[mcp_servers.flair]` could carry a line shaped like a flair sub-table header
  and an `args` line. The scan accepted that fake sub-table as part of the
  section and the substitution rewrote the STRING's content — a wrong-span write
  against a section that carries no package argument. Any multiline-string fence
  between the flair header and the section end is now HELD with the bytes
  untouched, and the reason names the fence. The existing before-the-header
  unmatched-fence rule is unchanged.

  (Refs #1834)
