- **A Memory DELETE that answers success has removed the row.**

  A delete confirms the committed store after its transaction and retries a
  removal Harper dropped; a removal that cannot be applied is refused by name
  (`409 delete_not_applied`) (#2632).
