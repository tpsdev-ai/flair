export interface PollClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  schedule(callback: () => void, ms: number): () => void;
}

const clock: PollClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export async function readStatusUntil(
  read: (signal: AbortSignal) => Promise<number>,
  want: number,
  transient: number,
  timeoutMs = 5_000,
  pollClock: PollClock = clock,
): Promise<number> {
  const deadline = pollClock.now() + timeoutMs;
  const expired = () => new Error(`status ${want} not observed before the ${timeoutMs} ms deadline`);
  for (;;) {
    const remaining = deadline - pollClock.now();
    if (remaining <= 0) throw expired();
    const controller = new AbortController();
    let cancel = () => {};
    const timeout = new Promise<never>((_, reject) => {
      cancel = pollClock.schedule(() => {
        const error = expired();
        controller.abort(error);
        reject(error);
      }, remaining);
    });
    let status: number;
    try {
      status = await Promise.race([read(controller.signal), timeout]);
      if (pollClock.now() >= deadline) {
        const error = expired();
        controller.abort(error);
        throw error;
      }
    } finally {
      cancel();
    }
    if (status === want || status !== transient) return status;
    await pollClock.sleep(Math.min(50, deadline - pollClock.now()));
  }
}
