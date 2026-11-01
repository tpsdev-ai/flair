- **Unwiring pi leaves an `extensions` entry that is not Flair's own in place.**
  An entry is removed only when it is exactly `npm:@tpsdev-ai/pi-flair`
  (`@<spec>` allowed), or a file path containing the consecutive segments
  `node_modules/@tpsdev-ai/pi-flair/`. Anything else carrying the name, such as
  `npm:@other/pi-flair`, `~/work/pi-flair/notes.js` or `~/dist/pi-flair-notes.js`,
  survives and is named in the unwire result (#2908).
