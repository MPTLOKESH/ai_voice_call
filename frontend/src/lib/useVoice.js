import { useCallback, useEffect, useRef, useState } from "react";

/** Resolves after `ms`, or at once if the signal is aborted. */
export const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * One voice at a time. `run(id, job)` starts `job(signal)` and marks `id` as playing; running the same id
 * again stops it, and running another id cuts the first off. `playing` is the id that is speaking now.
 */
export function useVoice(toast) {
  const [playing, setPlaying] = useState(null);
  const current = useRef(null);   // {id, controller}

  const stop = useCallback(() => current.current?.controller.abort(), []);

  const run = useCallback(async (id, job) => {
    const before = current.current;
    before?.controller.abort();
    if (before?.id === id) return;           // a second press means stop

    const mine = { id, controller: new AbortController() };
    current.current = mine;
    setPlaying(id);
    try {
      await job(mine.controller.signal);
    } catch (failure) {
      if (failure.name !== "AbortError") toast(failure.message, "bad");
    } finally {
      // Only the newest run clears the mark: an older one finishing late must not hide a newer one.
      if (current.current === mine) { current.current = null; setPlaying(null); }
    }
  }, [toast]);

  useEffect(() => () => current.current?.controller.abort(), []);

  return { playing, run, stop };
}

export const NO_AUDIO = "No audio came back. The speech service may be out of credit.";
