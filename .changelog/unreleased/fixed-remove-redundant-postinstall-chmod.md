- **Removed the redundant `postinstall` chmod.** npm already sets the executable bit on files
  referenced by `bin` when it links them; the script changed nothing and cost a line in npm's
  install-script approval prompt, on a package whose install output is already noisy.
