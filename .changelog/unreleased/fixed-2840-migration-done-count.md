- **Migrations count a row they stamped even when its confirming read missed
  the commit.** The synthetic CI migration and the visibility backfill counted
  `skip` as lost work, so a retry after an unconfirmed commit could report
  `completed` with fewer rows done than it stamped (flair#2840). The embedding
  stamp now counts a row a retry finds current after its own unconfirmed
  attempt.
