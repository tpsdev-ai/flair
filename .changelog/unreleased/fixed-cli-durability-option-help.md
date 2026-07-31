- **`--durability` describes itself in `--help` again.** `flair memory add` and
  `flair soul set` both passed the intended default as Commander's second
  argument, which is the description, not the default (that is the third). So
  `flair memory add --help` rendered the option as `--durability <d>  standard`
  and `flair soul set --help` as `--durability <d>  permanent` — the word alone,
  with no indication of what the flag does or what else it takes. Both now name
  the four tiers, and `memory add` also names the visibility each one defaults
  to. Behaviour is unchanged: the real defaults were always supplied separately.
