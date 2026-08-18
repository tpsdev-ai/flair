"""Register the flair:// URI scheme with ADK's service registry.

`adk web` / `adk run` import this module from the agents dir, after which
--memory_service_uri="flair://localhost:19926" resolves to a
FlairMemoryService (identity still comes from FLAIR_AGENT_ID/FLAIR_KEYFILE).

Why services.py and not services.yaml: ADK's generic YAML factory constructs
the class as `cls(uri=...)`, but FlairMemoryService takes `url=` — verified
against google-adk 2.7.1, where the YAML route fails at boot with
`TypeError: FlairMemoryService.__init__() got an unexpected keyword argument
'uri'`. adk_flair.register() installs a factory that parses the flair:// URI
properly, so it is the supported registration channel.
"""

from adk_flair import register

register()
