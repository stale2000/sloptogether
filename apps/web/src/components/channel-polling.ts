import { ApiError } from "./api";

/** Poll one channel resource until it is disposed or the channel is missing. */
export function startChannelPolling<T>(
  interval: number,
  load: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
  onError: (problem: unknown) => void,
): () => void {
  let stopped = false;
  let channelMissing = false;
  let reading = false;
  const controller = new AbortController();

  const read = async () => {
    if (reading || channelMissing || document.hidden) return;
    reading = true;
    try {
      const value = await load(controller.signal);
      if (!stopped) onValue(value);
    } catch (problem) {
      if (!stopped && !(problem instanceof DOMException && problem.name === "AbortError")) {
        if (problem instanceof ApiError && problem.status === 404 && problem.code === "channel_not_found") channelMissing = true;
        onError(problem);
      }
    } finally {
      reading = false;
    }
  };

  void read();
  const timer = window.setInterval(() => { void read(); }, interval);
  return () => {
    stopped = true;
    controller.abort();
    window.clearInterval(timer);
  };
}
