- **A failed-tool hook waits for the capture lock instead of dropping its pending error under contention.**
  The pending-error append now waits up to 2 seconds for the append lock before it
  refuses, and a refusal is reported on stderr rather than lost silently (flair#2395).
