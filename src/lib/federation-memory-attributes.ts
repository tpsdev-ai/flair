/**
 * The outbound federation projection uses the same declared and named Memory
 * fields as the inbound guard. Pointer inputs are absent from that contract.
 */
import { MEMORY_ATTRIBUTES, UNDECLARED_ALLOWED } from "./memory-attributes.js";

export const FEDERATION_MEMORY_ATTRIBUTES = MEMORY_ATTRIBUTES;
export const FEDERATION_MEMORY_UNDECLARED = UNDECLARED_ALLOWED;

/** Harper rejects undeclared names in a string projection. Its named object
 * selectors can read these stored fields; the nested wildcard keeps the whole
 * value of `meta` (including arbitrary journal keys), never the whole Memory
 * row. Scalar values such as `kind` are returned directly. See Harper's
 * searchValidator and Table.transformEntryForSelect. */
export const FEDERATION_MEMORY_SELECT = Object.freeze(
  FEDERATION_MEMORY_ATTRIBUTES.map((attribute) =>
    (FEDERATION_MEMORY_UNDECLARED as readonly string[]).includes(attribute)
      ? Object.freeze({ name: attribute, select: Object.freeze(["*"]) })
      : attribute,
  ),
);
