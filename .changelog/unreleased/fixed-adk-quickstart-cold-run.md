- **`adk-flair` ships a runnable cross-session-recall quickstart.** New
  `examples/quickstart.ts` (JS) and `examples/quickstart.py` (Python) plant a
  fact in one session, wait for a freshly-booted Flair to make it searchable,
  then recall it in a brand-new session and print the result — reliable on a
  cold instance without weakening the adapter's production 2s search budget.
