- **Size the CI unit-lane time budget from measured shard durations.** The job's
  `timeout-minutes` is 22 and the keep-going lane budget is 1200 s (at most
  about 1.5× the slowest measured lane shard, at least 781 s); the lane summary names a lane-budget
  kill, with the killed step and the not-run count, distinctly from a test
  failure (flair#2614).
