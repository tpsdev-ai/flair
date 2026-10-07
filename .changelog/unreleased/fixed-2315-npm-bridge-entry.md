- **The Node CLI loads npm bridge plugins from their entry files.**
  The loader selects `exports`, `main`, or `index.js` and refuses entries outside the package directory. (Closes #2315)
