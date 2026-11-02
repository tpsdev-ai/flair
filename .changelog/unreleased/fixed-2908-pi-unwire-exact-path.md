- **Pi unwire uses literal npm sources and lexical package-path segments (#2908).**
  Npm ownership requires literal `npm:@tpsdev-ai/pi-flair` or its `@` suffix
  with a nonempty spec containing no whitespace. Paths use a lexical
  `node_modules/@tpsdev-ai/pi-flair/` segment match; filesystem targets are not resolved.
  In successful unwire/no-op results, entries are identified by their position, not their value.
