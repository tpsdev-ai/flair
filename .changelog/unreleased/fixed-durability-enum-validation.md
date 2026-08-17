- **Server-side durability enum validation.** A writer-supplied `durability` that
  is not one of `permanent`/`persistent`/`standard`/`ephemeral` is now refused with
  a 400 naming the valid set, instead of being silently accepted and landing on the
  narrower private branch by accident. Absent durability is unchanged (defaulted to
  `standard`). Applied to both `Memory.post` and `Memory.put`; the adk-flair Python
  adapter's `_VALID_DURABILITIES`/`_VALID_VISIBILITIES` frozensets were also moved to
  module level (cosmetic).
