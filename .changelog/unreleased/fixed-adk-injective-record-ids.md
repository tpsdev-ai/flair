- **ADK record ids for colon-bearing tuples sit outside historical ids.**
  When an app, user, session, or event value contains `:`, both adk-flair
  packages percent-encode the components and join them with `|`. The result
  contains no `:`. The old join always contains at least three `:`, so a new
  id is not a row the previous encoder stored. Tuples with no colon in any
  component keep the historical id.
