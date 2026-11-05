- **Federation sync rejects a batch response whose merged and skipped counts add up to more records than it offered.**

  The check now applies to Memory, Soul, Agent and Relationship batches as well
  as Presence, and the error names the table and both counts (#2667).
