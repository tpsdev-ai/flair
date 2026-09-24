- **`flair doctor --fix` adoption no longer accepts a foreign listener when the launchd job reports no pid.**

   After a `flair doctor --fix` launchd adopt, the tool proves the adopted job —
   not the old direct process — owns the port. That ownership check was skipped
   whenever launchd reported no pid for the adopted label. If the job crashed
   after load and a different process bound the port before the old process died,
   adoption passed for the wrong process. A missing launchd pid now fails the
   proof: without a live pid the job's identity cannot be confirmed, so its
   listener cannot be attributed to it.

  > **Heads-up:** if a `flair doctor --fix` adopt now reports "the launchd job
  > reports no pid after load", the adopted service did not come up as expected;
  > confirm the label is loaded, then re-run `flair doctor --fix`.

  (Closes #1841)
