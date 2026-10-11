- **Semantic-search results now carry `provenance`, like the by-id and list reads.** The
  semantic-search projection includes the stored `provenance` blob (the server-stamped author
  and receipt time). This only widens the field selection with a stored value; it never attaches
  the opt-in trust block or a similarity score, and `includeTrust`/`abstain` stay opt-in.
