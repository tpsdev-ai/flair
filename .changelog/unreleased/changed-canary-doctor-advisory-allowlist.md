- **The post-publish canary now passes a healthy instance when `flair doctor`'s only complaint is a known advisory hint.**

  A fresh loopback instance makes `flair doctor` exit non-zero with a
  conditional hint about the public URL (flair#1701). The canary's boot check
  now accepts exactly that allow-listed finding — logging
  `doctor: advisory-only (allow-listed): <n>` — and still fails on every other
  finding, or when a non-zero exit prints no findings at all. The allow-list is
  removed when the product fix ships. (Refs #1686 #1698 #1701)
