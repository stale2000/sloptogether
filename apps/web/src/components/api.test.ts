import { describe,expect,it } from "vitest";
import { ApiError,displayProblem } from "./api";
import { isLocalDemoFallbackEnabled } from "./channel-data";

describe("API error display",()=>{
  it("identifies a channel that is not configured",()=>{
    expect(displayProblem(new ApiError("channel_not_found",404,"channel_not_found"))).toBe("This channel is not set up yet.");
  });

  it("limits static demo playback fallback to the explicitly enabled localdemo channel",()=>{
    expect(isLocalDemoFallbackEnabled("localdemo","true")).toBe(true);
    expect(isLocalDemoFallbackEnabled("channel","true")).toBe(false);
    expect(isLocalDemoFallbackEnabled("localdemo","false")).toBe(false);
    expect(isLocalDemoFallbackEnabled("localdemo","true","other")).toBe(false);
  });
});
