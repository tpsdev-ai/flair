- **Refuse signed requests whose raw target WHATWG URL parsing would rewrite before verification (#2861).**
  The signature is verified over the target exactly as received. The candidate listing refuses a target whose parsed query would differ before reading that query.
