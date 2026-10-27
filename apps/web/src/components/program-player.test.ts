import { describe, expect, it } from "vitest";
import { controllerMarkerDecision,hlsPlayerMode,safeInterruptTransition,seekOrQueue,shouldSkipInterruptSpan } from "./program-player";

describe("seekOrQueue",()=>{
  it("keeps the user's seek for metadata rather than a previous saved position",()=>{
    const media={readyState:0,currentTime:21};
    expect(seekOrQueue(media,75)).toBe(75);
    expect(media.currentTime).toBe(21);
  });
  it("seeks immediately once metadata is available",()=>{
    const media={readyState:1,currentTime:21};
    expect(seekOrQueue(media,75)).toBeNull();
    expect(media.currentTime).toBe(75);
  });
  it("retains the target if the browser cannot seek yet",()=>{
    const media={readyState:1,get currentTime(){return 21},set currentTime(_value:number){throw new Error("not seekable")}};
    expect(seekOrQueue(media,75)).toBe(75);
  });
});

describe("controllerMarkerDecision",()=>{
  it("preserves a manual seek when the same saved position arrives late",()=>{
    expect(controllerMarkerDecision(3,null,3,true,false,null)).toBe("ignore");
  });
  it("waits for a pending claim and ignores the echo of our own claim",()=>{
    expect(controllerMarkerDecision(4,3,3,true,true,null)).toBe("wait");
    expect(controllerMarkerDecision(4,3,3,true,false,4)).toBe("ignore");
  });
  it("applies a new remote controller or streamer override after the claim settles",()=>{
    expect(controllerMarkerDecision(5,3,3,true,false,4)).toBe("apply");
    expect(controllerMarkerDecision(5,3,3,true,false,null)).toBe("apply");
  });
  it("keeps ignoring repeated markers within an epoch",()=>{
    expect(controllerMarkerDecision(4,4,3,true,false,4)).toBe("unchanged");
  });
});

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
