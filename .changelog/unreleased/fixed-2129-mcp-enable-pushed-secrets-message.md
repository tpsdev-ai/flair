- **`flair mcp enable` now tells operators to restart Fabric or load verified pushed secrets when confirmation is pending.**
  The confirmation prompt and failure step no longer instruct operators to apply
  the staged file after the secrets were pushed and read back. Runs without a
  verified push retain the staged-file instructions. (Closes #2129)
