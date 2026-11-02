- **Pi unwire matches trimmed npm specs and resolved package paths (#2908).**
  Npm ownership trims the spec after literal `npm:` before matching the package name
  and optional nonempty suffix without internal whitespace. Pi-local paths are normalized
  before matching `node_modules/@tpsdev-ai/pi-flair/` segments.
  In successful unwire/no-op results, entries are identified by their position, not their value.
