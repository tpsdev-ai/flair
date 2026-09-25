- **A failed `flair federation token` now really deletes the pairing token it minted.** The rollback used to send the singular `hash_value`, which Harper refuses with a 400, so the token stayed in the table and outlived the bootstrap user it was minted for. It now sends `hash_values` and reports whether Harper confirmed the delete, naming the token by its 8-character prefix only.

  (Refs #1895)