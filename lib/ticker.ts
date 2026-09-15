/**
 * Repeating timer driven by a Web Worker. Browsers throttle main-thread timers in background or hidden tabs (down to
 * once a minute after a few minutes), which would stall polling and step timers; worker timers keep their interval.
 * Falls back to setInterval where workers are unavailable. Returns a function that stops the ticker.
 */
export function startTicker(intervalMs: number, tick: () => void) {
  try {
    const source = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${intervalMs});`], { type: "text/javascript" }));
    const worker = new Worker(source);
    worker.onmessage = () => tick();
    return () => { worker.terminate(); URL.revokeObjectURL(source); };
  } catch {
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }
}
