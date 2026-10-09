- **The hook-status probe ignores HUP/INT/QUIT/TERM in its group pin before forking it, so the probe's own SIGTERM cannot kill the pin.**
  The pin keeps the command's process-group id in use so cleanup can signal the
  group: SIGTERM, then SIGKILL after a bounded grace. A group that outlives
  SIGKILL is still reported as a named cleanup failure (flair#2385).
