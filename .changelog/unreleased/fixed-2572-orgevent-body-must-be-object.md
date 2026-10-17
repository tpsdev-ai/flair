- **OrgEvent POST, PUT and PATCH refuse malformed bodies with 400 body_must_be_object; PUT admits arrays of records (#2580).**

  The guard runs before the resource method's authentication, attribution,
  ownership and createdAt checks. Harper's collection validation, authentication
  or middleware ownership checks can refuse input before resource dispatch.
  Arrays of records are admitted when `allowArrayObjects` is enabled (PUT).
