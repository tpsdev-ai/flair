- **The workspace lockfile resolves handlebars 4.7.10, outside the vulnerable range of GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f and GHSA-xw65-4hp5-5hc7 (>=4.0.0 <=4.7.9).** A root
  `overrides` entry pins it. Installs of the published `@tpsdev-ai/flair` package do not
  include handlebars.
