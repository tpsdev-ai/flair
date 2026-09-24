- **Excerpts of long source memories end on a complete character, not a mangled
  one.**

  When the reflection feature trims a long source memory down to fit the
  per-source budget, the cut could fall between the two halves of a single
  character — any character outside the Basic Multilingual Plane (emoji and
  similar are stored as two code units) — leaving the excerpt ending in a
  broken fragment that serializes as a replacement character (U+FFFD) in the
  distillation prompt. The trim now cuts on whole-character boundaries, so a
  truncated excerpt always ends on a complete character.

  (Closes #1772)
