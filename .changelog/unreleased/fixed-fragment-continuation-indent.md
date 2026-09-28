- **Changelog validation rejects odd continuation indentation and leading tabs.**
  Every line after the first is checked, including lines inside fenced code.
  Use an even number of leading spaces: two for entry text, four or more for
  nested content. Unindented lines pass this check. Errors name the file, line
  and indent; docs-freshness annotations point to the offending line.

  (Closes #2007)
