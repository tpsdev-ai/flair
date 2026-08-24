- **`engines.node` now matches Harper's floor.** Flair declared `>=22` while
  the bundled Harper requires `^22.18.0 || >=24`. Node 22.0–22.17 installed
  cleanly and then Harper refused to boot. The declared range is now Harper's
  (flair#1385).
