- **`flair doctor`'s fallback ops candidate is derived from the HTTP port it probed, not the configured one.** (#2585)

  When neither port is named and the probed instance's configuration records no
  complete HTTP/ops pair, the fallback (`httpPort - 1`) now uses the port doctor
  actually reached. It previously used the configured HTTP port, so a probe that
  differed from the configuration produced a wrong candidate and a false NOT
  RUN. The candidate is still verified by the port-pair check before the roster
  and home reads.
