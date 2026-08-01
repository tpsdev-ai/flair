- **Flair now stamps the data directory with the Harper engine version and refuses to boot when the store was written by a newer engine.** If an older Harper boots against a store written by a newer one, the error names both versions, the data directory, and the remedy — reinstall the newer version or restore from a pre-upgrade snapshot.

  This only helps from the release that ships it onward: the check lives in the version being downgraded *to*, so it cannot rescue a downgrade to a build that predates the stamp.
