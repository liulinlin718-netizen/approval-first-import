export class WaitError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Bounds waiting, not execution: a host callback must cooperate with its signal. */
export function boundedCall(invoke, { timeoutMs, timeoutCode, signal, stopSignal }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      stopSignal?.removeEventListener('abort', stop);
      if (error) { controller.abort(error); reject(error); } else resolve(value);
    };
    const cancel = () => finish(new WaitError('cancelled'));
    const stop = () => finish(stopSignal.reason);
    if (signal?.aborted) { cancel(); return; }
    if (stopSignal?.aborted) { stop(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    stopSignal?.addEventListener('abort', stop, { once: true });
    if (timeoutMs <= 0) { finish(new WaitError(timeoutCode)); return; }
    timer = setTimeout(() => finish(new WaitError(timeoutCode)), timeoutMs);
    try {
      // Handle late rejection as well as late success; neither can change the settled result.
      Promise.resolve(invoke(Object.freeze({ signal: controller.signal })))
        .then(value => finish(null, value), error => finish(error || new Error('Callback failed.')));
    } catch (error) { finish(error || new Error('Callback failed.')); }
  });
}
