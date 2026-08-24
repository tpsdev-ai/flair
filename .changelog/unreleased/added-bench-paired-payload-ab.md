- **LongMemEval bench: a paired, same-retrieval A/B runner for the reader
  payload format (`payload-ab.ts`).** The dated-payload change could not be
  measured by the existing slice: `selectSlice` round-robins across abilities,
  so a 30-question smoke slice carried only a handful of temporal-reasoning
  questions and scored 100% on them at baseline — a ceiling, where the check
  cannot fire. The new runner fixes both halves of that. `selectAbilitySlice`
  draws n questions of ONE ability by an explicit, re-derivable rule (hash the
  question_id with the seed and take the first n — a keyed pseudo-random draw,
  not a lexicographic prefix, because `gpt4_*` ids mark a subpopulation that a
  prefix draw would confound with the treatment). And the comparison is PAIRED:
  per question the haystack is ingested once and retrieved once, then that same
  retrieved set is formatted both ways and read + judged twice, so question
  difficulty and retrieval luck are held exactly constant within a pair instead
  of being sampled twice. The read is an exact two-sided McNemar on the
  discordant pairs, reported alongside the discordant COUNT and the split that
  would have been needed for p<0.05 — so an underpowered null is legible as
  underpowered rather than as "no effect". Each pair also records whether
  retrieval actually surfaced the dataset's own evidence labels
  (`answer_session_ids` / per-turn `has_answer`), which is what separates "the
  dates did not help" from "the evidence was never there to date". Emits the
  same content-addressed, NOT-FOR-PUBLICATION artifact shape as the four-arm
  run, with the paired design described inside the hashed config so the
  artifact explains its own experiment. Bench harness only — shipped Flair
  behavior is unchanged.
