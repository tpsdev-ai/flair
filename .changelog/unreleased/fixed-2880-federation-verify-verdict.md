- **`flair federation verify` names a failed verification in its returned verdict.**

  When the verification itself fails, the result now reports that failure in its
  verdict instead of an empty "no peers to probe" result, and names any cleanup
  request whose outcome is unknown. A genuinely empty peer set still reports
  "no peers to probe."
