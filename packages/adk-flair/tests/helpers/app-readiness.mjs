const APP_READY_TIMEOUT_MS = 30_000;
const APP_PROBE_TIMEOUT_MS = 2_000;
const APP_POLL_INTERVAL_MS = 500;

export async function waitForAppLoaded(httpURL, timeoutMs = APP_READY_TIMEOUT_MS, {
  request = globalThis.fetch,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  probeTimeoutMs = APP_PROBE_TIMEOUT_MS,
  pollIntervalMs = APP_POLL_INTERVAL_MS,
} = {}) {
  const url = `${httpURL}/Memory`;
  const deadline = now() + timeoutMs;
  let attempt = 0;
  while (now() < deadline) {
    attempt++;
    const elapsed = now() - (deadline - timeoutMs);
    try {
      const res = await request(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(probeTimeoutMs, deadline - now())),
      });
      if (res.status !== 404) {
        console.error(`[boot-harper] app loaded: ${url} → ${res.status} (attempt ${attempt}, ${elapsed}ms)`);
        return;
      }
      console.error(`[boot-harper] app not yet loaded: ${url} → 404 (attempt ${attempt}, ${elapsed}ms)`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.error(`[boot-harper] app probe error: ${url} → ${msg} (attempt ${attempt}, ${elapsed}ms)`);
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error(
    `Flair application not loaded at ${httpURL} after ${timeoutMs}ms ` +
      `(${attempt} attempts). The Flair app must be built before running ` +
      `integration tests — Harper is up but /Memory returns 404.`,
  );
}
