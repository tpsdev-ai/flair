- **`models/*.gguf.downloading` is now ignored.** `.gitignore` covered `*.gguf` but not the
  in-progress placeholder Harper writes beside it, and the integration harness points
  `FLAIR_MODELS_DIR` at the repo's own `models/` directory — so a killed test run left an untracked
  file in the working tree.
