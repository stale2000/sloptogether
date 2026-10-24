import { describe,expect,it } from "vitest";
import { ApiError,displayProblem } from "./api";

describe("API error display",()=>{
  it("identifies a channel that is not configured",()=>{
    expect(displayProblem(new ApiError("channel_not_found",404,"channel_not_found"))).toBe("This channel is not set up yet.");
  });
});
