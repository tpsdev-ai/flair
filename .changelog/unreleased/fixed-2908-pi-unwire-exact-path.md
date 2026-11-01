- **Unwiring pi leaves an `extensions` entry that is not Flair's own in place.**
  A path entry is removed when it names an npm pi-flair spec or has a whole `pi-flair` path segment (the location Flair installs it); one that merely contains the substring, such as `~/dist/pi-flair-notes.js`, survives and is named in the unwire result (#2908).
