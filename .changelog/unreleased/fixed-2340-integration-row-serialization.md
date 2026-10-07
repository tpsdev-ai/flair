- **Integration writes re-check the committed row before they commit.**
  An owner's write that raced an operator publishing the same row is refused
  or re-decided against the published row.
