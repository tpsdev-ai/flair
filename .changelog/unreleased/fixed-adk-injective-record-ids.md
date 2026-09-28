- **ADK memory record ids no longer collide when a component contains `:`.**
  App, user, session, and event values that include a colon are percent-encoded
  (`%` as `%25`, `:` as `%3A`) and the id is prefixed with `:`, in both
  `adk-flair` and `adk-flair-js`. Values without a colon keep the same id as
  before, so existing records stay addressable.
