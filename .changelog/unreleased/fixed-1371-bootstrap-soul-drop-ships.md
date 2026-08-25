- **Bootstrap no longer ships a soul entry it decided to drop** (flair#1371).
  Under a tight `maxTokens`, the soul selector could drop an entry from
  `sections.soul`, `soulTokens`, and the context pointer while still putting
  the full key in the structured `soul` map. A decided drop now omits that
  key, so counted == delivered.
