- **By-id reads are scoped on the full stored record.**
  A by-id read that asks for a selection or a single property is checked with the table's read-scope rule on the full stored record, exactly like an unselected read, before the selected value is returned. This covers every table whose by-id reads use the shared read gate.
