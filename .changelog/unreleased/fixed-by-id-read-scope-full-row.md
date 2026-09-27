- **By-id reads are scoped on the full stored record.**
  A by-id read that asks for a selection or a single property is checked against the stored record's owner and visibility, exactly like an unselected read, before the selected value is returned. This covers every table whose by-id reads use the shared read gate.
