- **`flair doctor` no longer reports a healthy agent-keyed instance as missing its embeddings and audit checks.** The checks now sign in with a registered agent the same way a normal command does, instead of an unrelated local key that happened to sort first.

  When the instance genuinely rejects the signature, doctor now shows a clear failure that names the identity and key it used — instead of a soft "not verified" that was easy to ignore on an install that was actually broken. (Refs #1501)
