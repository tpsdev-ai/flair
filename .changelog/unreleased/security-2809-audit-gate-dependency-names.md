- **The dependency audit gate rejects a dependency name with an `@` inside a segment.**
  A name such as `a@b` or `@scope/a@b` is not an npm package name, so the gate
  resolves it to nothing instead of looking it up in harper's tree.
