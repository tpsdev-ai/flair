- **adk-flair: closed a tag-collision in the per-user scope tag.** The ADK
  memory adapter built its `adk:<app>:<user>` scope tag by replacing `:` with
  `_`, so distinct identities like `alice:admin` and `alice_admin` collapsed to
  the same tag. Because that tag is the per-user access-control boundary, the
  collision could contaminate memory across users. Segments are now percent-
  encoded (reversible, collision-free); no action is needed for existing
  installs, though any tag written for a user id containing `:` or `_` will
  differ from what the old scheme produced.
