- **Keep the CI unit-lane summary inside the job limit when setup runs long.** The
  `test-unit` job's first step records its start; the keep-going lane budget is the
  job limit minus the elapsed setup and a post-lane reserve, and the install step
  carries its own limit so a hung install fails there (flair#2619).
