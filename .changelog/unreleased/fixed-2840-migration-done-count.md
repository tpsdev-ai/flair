- **Migrations report a row as done when the retry of their own unconfirmed
  write finds it at the target.** On main, a `skip` for a row already at the
  migration's target was not counted, so after a commit whose confirming read
  missed it the retry saw the target and the batch reported one fewer row done
  than it stamped (flair#2840). A skip that names the target now counts only
  when it follows the same run's own attempt on the row whose committed outcome
  was unconfirmed; a row another writer brought to the target stays uncounted.
  Applies to the synthetic CI migration, the visibility backfill and the
  embedding stamp.
