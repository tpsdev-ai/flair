- **OrgEvent resource methods refuse malformed bodies with `body_must_be_object` (400), except admitted arrays of records.**

  The guard runs before the resource method's authentication, attribution,
  ownership and createdAt checks. Harper's collection validation, authentication
  or middleware ownership checks can refuse input before resource dispatch.
  Arrays of records are admitted when `allowArrayObjects` is enabled (PUT).
