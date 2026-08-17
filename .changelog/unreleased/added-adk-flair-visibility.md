- **Explicit durability and visibility on `add_memory()`.** The adk-flair Python
  adapter's explicit write API now accepts optional `durability` and `visibility`
  keyword arguments. Omitted behaviour is byte-identical (durability `standard`,
  no visibility key — server applies its durability-keyed default). Supplied values
  are included in the POST body and validated server-side. Enum-restricted on the
  client side (`permanent`/`persistent`/`standard`/`ephemeral` and `private`/`shared`);
  unknown values raise `ValueError` before any network call.
