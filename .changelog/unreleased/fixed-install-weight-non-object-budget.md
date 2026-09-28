- **The install-weight gate refuses a non-object budget file cleanly instead of crashing.** A budget containing null, a bare string, or a boolean is rejected with a clear error message and exit code 2.

  (Closes #1413)
