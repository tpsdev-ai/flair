- **`flair init` puts back the plist it wrote when the check of that plist cannot run (flair#2078).**
  When `flair init` retires a legacy `ai.tpsdev.flair` registration, it writes
  the new plist and checks it before unloading anything. A check that cannot
  run, such as `plutil -lint` unable to create its temporary copy, is refused
  like a check that fails: the new plist is put back as it was, or removed if
  there was none, nothing is loaded or unloaded, and the message names the
  plist and the error. If the plist cannot be put back, init says so, names
  the file to remove, and exits non-zero.
