import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { startChannelPolling } from "./channel-polling";

describe("channel polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", { hidden: false });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("honors its interval, visibility, and in-flight request", async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn((signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return new Promise<string>((done) => { resolve = done; });
    });
    const onValue = vi.fn();
    const stop = startChannelPolling(6000, load, onValue, vi.fn());
    await vi.advanceTimersByTimeAsync(12000);
    expect(load).toHaveBeenCalledTimes(1);
    resolve("first");
    await Promise.resolve();
    expect(onValue).toHaveBeenCalledWith("first");
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(6000);
    expect(load).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await vi.advanceTimersByTimeAsync(6000);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    resolve("late");
    await Promise.resolve();
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0].aborted).toBe(true);
  });

  it("continues after transient errors but stops for a missing channel", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiError("missing", 404, "channel_not_found"));
    const onError = vi.fn();
    const stop = startChannelPolling(5000, load, vi.fn(), onError);
    await vi.advanceTimersByTimeAsync(15000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    stop();
  });
});
