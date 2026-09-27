- **The canary promote block stops on a FAILED `dist-tag ls`, not just an empty one.**
  A read whose `npm` exits non-zero is treated as unmeasurable and stops the block
  before the first tag moves, naming the package; a value is stripped of CR and
  surrounding whitespace and must be a version, so a malformed read can never
  contaminate a restore line.

  > **Heads-up:** if a canary promote block stops saying "unmeasurable is FAIL" or
  > "is not a version", nothing moved — re-read the tag and promote again.
