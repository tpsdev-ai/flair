- **`flair init` seeds an org-wide `using-flair` skill so every agent's bootstrap lists it with no per-agent setup (flair#2141).**

  The seed writes one skill-tagged Memory row (`using-flair`, persistent, shared, owned by the reserved system writer) and an org-scope assignment every active agent receives unless it opts out; a re-run changes nothing. An unedited shipped version is replaced from the repo's shipped-hash list; an operator-edited row is kept and reported; a row or assignment that cannot be read refuses the seed with a remedy rather than writing a duplicate.

  The text reconciles the flair best-practices guidance and the cursor-flair skills (remember, bootstrap, coordinate, soul): when to write and at what durability, provenance, recall habits, what not to store, identity, and — until a directory tool lands — reading the Agent and Presence records to find teammates.
