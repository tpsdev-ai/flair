- **The built-in /mcp `memory_basement` and `memory_restore` tool contracts declare the fields their replies actually carry: `id` and `written` (#2575).**

  Both tools return the Memory write result, so their `requiredFields` are now
  `id` and `written` (was `id` and `archived`). A contract test drives each tool
  through the shipped handler and applies its declared contract to the reply.
