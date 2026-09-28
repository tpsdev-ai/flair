- **Changelog validation checks continuation indentation.**
  Outside fenced code, continuation lines require two spaces or at least four for nested content, with file and line diagnostics.
  Validation, assembly and stray-entry detection share fence handling, including fences opened directly after the list marker. Docs-freshness annotations point to the offending continuation line.

  (Closes #2007)
