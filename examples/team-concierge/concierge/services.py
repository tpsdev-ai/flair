"""flair:// registration for `adk run` (which loads services from the agent
folder itself), mirroring ../services.py (which `adk web` loads from the
agents parent dir). Both exist because google-adk 2.7.1 resolves the services
module from a different directory per command."""

from adk_flair import register

register()
