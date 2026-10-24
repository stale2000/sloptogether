import { describe, expect, it } from "vitest";
import { hlsPlayerMode,safeInterruptTransition,shouldSkipInterruptSpan } from "./program-player";

describe("hlsPlayerMode",()=>{
  it("prefers hls.js when Media Source Extensions are available despite a native HLS hint",()=>{
    expect(hlsPlayerMode(true,true)).toBe("hls.js");
  });

  it("uses native HLS only when Media Source Extensions are unavailable",()=>{
    expect(hlsPlayerMode(false,true)).toBe("native");
    expect(hlsPlayerMode(false,false)).toBe("unsupported");
  });
});

describe("safeInterruptTransition",()=>{
  const spans=[
    {itemId:"story-1",kind:"story" as const,outputStartSeconds:0,outputEndSeconds:15},
    {itemId:"story-2",kind:"story" as const,outputStartSeconds:15,outputEndSeconds:30},
    {itemId:"alert-item",interruptId:"alert-1",kind:"subscriber_interrupt" as const,outputStartSeconds:30,outputEndSeconds:45},
  ];

  it("waits until the current story clip reaches its safe boundary",()=>{
    expect(safeInterruptTransition(spans,14.5,"alert-1")).toBeNull();
    expect(safeInterruptTransition(spans,14.8,"alert-1")).toEqual({
      interruptItemId:"alert-item",interruptStartSeconds:30,interruptEndSeconds:45,resumeSeconds:15,
    });
  });

  it("resumes after the alert when no future story clip is committed yet",()=>{
    expect(safeInterruptTransition([spans[0]!,spans[2]!],14.8,"alert-1")?.resumeSeconds).toBe(45);
  });

  it("does not interrupt during an alert or a non-boundary story position",()=>{
    expect(safeInterruptTransition(spans,22,"alert-1")).toBeNull();
    expect(safeInterruptTransition(spans,33,"alert-1")).toBeNull();
  });

  it("skips a consumed or cancelled interrupt during forward playback",()=>{
    const span={itemId:"alert-item",kind:"subscriber_interrupt" as const,outputStartSeconds:30,outputEndSeconds:45,interruptId:"alert-1"};
    expect(shouldSkipInterruptSpan(span,new Set(["alert-item"]))).toBe(true);
    expect(shouldSkipInterruptSpan({...span,skipPlayback:true},new Set())).toBe(true);
    expect(shouldSkipInterruptSpan(span,new Set())).toBe(false);
  });
});
