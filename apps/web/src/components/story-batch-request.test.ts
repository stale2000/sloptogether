import { describe, expect, it, vi } from "vitest";
import { ApiError, type apiFetch } from "./api";
import { approveStoryCandidate, createStoryBatchRequester, createStoryCandidateReplanner, createStoryCandidateScreenRetry, rejectStoryCandidate, storyBatchBlocker, storyBatchPath, storyCandidateFrames } from "./story-batch-request";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryBatchList } from "./story-batch-control";

describe("story batch request", () => {
  it("loads approved frame choices and submits the selected frame and candidate revision", async () => {
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({frames:[{boundaryRevisionId:"boundary",assetId:"asset",previewUrl:"/preview",createdAt:"2026-01-01T00:00:00Z"}]})))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch",fetchMock);
    try {
      expect(await storyCandidateFrames("owner","main")).toMatchObject([{boundaryRevisionId:"boundary"}]);
      await approveStoryCandidate("owner","main","item","boundary",3);
      expect(fetchMock.mock.calls[0]![0]).toBe("/sloptogether/api/v1/channels/owner/streams/main/story-candidates/frames");
      expect(fetchMock.mock.calls[1]![0]).toBe("/sloptogether/api/v1/channels/owner/streams/main/story-candidates/item/approve");
      expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({boundaryRevisionId:"boundary",expectedCandidateRevision:3});
    } finally { vi.unstubAllGlobals(); }
  });

  it("submits a rejection with the exact candidate revision and reason", async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch",fetchMock);
    try {
      await rejectStoryCandidate("owner","main","item",2,"Not suitable");
      expect(fetchMock.mock.calls[0]![0]).toBe("/sloptogether/api/v1/channels/owner/streams/main/story-candidates/item/reject");
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({expectedCandidateRevision:2,reason:"Not suitable"});
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses the same id when retrying an uncertain replan request", async () => {
    const post=vi.fn().mockRejectedValueOnce(new ApiError("offline",0,"network")).mockResolvedValueOnce({});
    const makeId=vi.fn().mockReturnValue("retry-id");
    const replan=createStoryCandidateReplanner("owner","main","item",post as typeof apiFetch,makeId);
    await expect(replan(3)).rejects.toMatchObject({code:"network"});
    await expect(replan(3)).resolves.toBeUndefined();
    expect(post.mock.calls.map(call=>JSON.parse(call[1].body))).toEqual([
      {expectedCandidateRevision:3,requestId:"retry-id"},{expectedCandidateRevision:3,requestId:"retry-id"},
    ]);
    expect(makeId).toHaveBeenCalledTimes(1);
  });

  it("keeps the same request id when retrying an uncertain input-check request", async () => {
    const post=vi.fn().mockRejectedValueOnce(new ApiError("offline",0,"network")).mockResolvedValueOnce({});
    const makeId=vi.fn().mockReturnValue("check-id");
    const retry=createStoryCandidateScreenRetry("owner","main","item",post as typeof apiFetch,makeId);
    await expect(retry(3)).rejects.toMatchObject({code:"network"});
    await expect(retry(3)).resolves.toBeUndefined();
    expect(post.mock.calls[0]![0]).toBe("/channels/owner/streams/main/story-candidates/item/retry-screen");
    expect(post.mock.calls.map(call=>JSON.parse(call[1].body))).toEqual([
      {expectedCandidateRevision:3,requestId:"check-id"},{expectedCandidateRevision:3,requestId:"check-id"},
    ]);
    expect(makeId).toHaveBeenCalledTimes(1);
  });

  it("shows queued prompts and approved frames while leaving future slots pending", () => {
    const markup = renderToStaticMarkup(createElement(StoryBatchList, {batches:[
      {batchId:"new",requested:4,scheduled:0,pending:4,items:[{position:0,state:"pending",prompt:null,dialogue:null,startFrameUrl:null}]},
      {batchId:"old",requested:4,scheduled:1,pending:3,items:[
        {position:0,state:"ready",prompt:"A fox follows the stars.",dialogue:"Look up!",startFrameUrl:"/sloptogether/api/v1/media/frame/preview",endFrameUrl:"/sloptogether/api/v1/media/end/preview"},
        {position:1,state:"pending",prompt:null,dialogue:null,startFrameUrl:null},
      ]},
    ]}));
    expect(markup).toContain("Upcoming clips");
    expect(markup).toContain("Clip 1 · Ready");
    expect(markup).toContain("A fox follows the stars.");
    expect(markup).toContain("Look up!");
    expect(markup).toContain("/sloptogether/api/v1/media/frame/preview");
    expect(markup).toContain("/sloptogether/api/v1/media/end/preview");
    expect(markup).toContain("Clip 2 · Waiting");
    expect(markup).toContain("Waiting for prompt");
    expect(markup.indexOf("A fox follows the stars.")).toBeLessThan(markup.lastIndexOf("Batch 2"));
  });

  it("hides fully played batches and keeps attention states visible", () => {
    const row = (batchId:string,state:string) => ({batchId,requested:4 as const,scheduled:1,pending:3,
      items:[{position:0,state,prompt:batchId,dialogue:null,startFrameUrl:null}]});
    const markup = renderToStaticMarkup(createElement(StoryBatchList, {batches:[
      row("new","pending"),row("failed","failed"),row("middle","pending"),row("old","ready"),row("played","played"),
    ]}));
    expect(markup).not.toContain(">played<");
    expect(markup).toContain("Clip 1 · Failed");
    expect(markup).toMatch(/<details class="story-batch"><summary class="story-batch-heading">Batch 2/);
    expect(markup.indexOf("old")).toBeLessThan(markup.indexOf("new"));
  });

  it("allows the last planned candidate to be reviewed without a next frame", () => {
    const markup = renderToStaticMarkup(createElement(StoryBatchList, {channel:"owner",stream:"main",batches:[
      {batchId:"b",requested:4,scheduled:0,pending:4,items:[
        {itemId:"item-four",position:3,state:"planned",prompt:"A star glows",dialogue:null,startFrameUrl:null,candidateRevision:1,candidateApproved:false,canApprove:true,canReject:true},
      ]},
    ]}));
    expect(markup).toContain('aria-label="Choose start frame for clip 4"');
    expect(markup).toContain('aria-label="Reject clip 4"');
    expect(markup).toContain("A star glows");
    expect(markup).not.toContain("Awaiting next start frame");
  });

  it("shows an approved last candidate waiting for a later start frame", () => {
    const markup = renderToStaticMarkup(createElement(StoryBatchList, {channel:"owner",stream:"main",batches:[
      {batchId:"b",requested:4,scheduled:0,pending:4,items:[
        {itemId:"item-four",position:3,state:"planned",prompt:"A star glows",dialogue:null,startFrameUrl:"/frame",endFrameUrl:null,candidateRevision:1,candidateApproved:true,canApprove:false},
      ]},
    ]}));
    expect(markup).toContain("Awaiting next start frame");
    expect(markup).not.toContain("Choose start frame");
  });

  it("offers an explicit retry for a rejected candidate", () => {
    const markup = renderToStaticMarkup(createElement(StoryBatchList, {channel:"owner",stream:"main",batches:[
      {batchId:"b",requested:4,scheduled:0,pending:4,items:[
        {itemId:"item",position:1,state:"rejected",prompt:"A star glows",dialogue:null,startFrameUrl:null,candidateRevision:2,candidateRejected:true,canReplan:true},
      ]},
    ]}));
    expect(markup).toContain("Clip 2 · Rejected");
    expect(markup).toContain('aria-label="Try clip 2 again"');
    expect(markup).not.toContain("Choose start frame");
  });

  it("shows input-check retry only for an eligible blocked candidate", () => {
    const row=(itemId:string,canRetryScreen:boolean) => ({itemId,position:itemId==="retry"?0:1,state:"planned",prompt:"A star glows",dialogue:null,startFrameUrl:"/frame",candidateRevision:1,candidateApproved:true,screenBlocked:true,canRetryScreen});
    const markup = renderToStaticMarkup(createElement(StoryBatchList, {channel:"owner",stream:"main",batches:[
      {batchId:"b",requested:4,scheduled:0,pending:4,items:[row("retry",true),row("locked",false)]},
    ]}));
    expect(markup).toContain("Clip 1 · Input check blocked");
    expect(markup).toContain('aria-label="Retry input check for clip 1"');
    expect(markup).not.toContain('aria-label="Retry input check for clip 2"');
  });

  it("distinguishes budget and producer waits without claiming work is running", () => {
    const pending = {batchId:"b",requested:4 as const,scheduled:0,pending:4};
    expect(storyBatchBlocker(pending,{budget:"available",producerLeaseActive:true,hasApprovedStart:false})).toBeNull();
    expect(storyBatchBlocker(pending,{budget:"exhausted",producerLeaseActive:false,hasApprovedStart:true})).toBe("budget");
    expect(storyBatchBlocker(pending,{budget:"unavailable",producerLeaseActive:false,hasApprovedStart:true})).toBe("budget");
    expect(storyBatchBlocker(pending,{budget:"available",producerLeaseActive:false,hasApprovedStart:true})).toBe("producer");
    expect(storyBatchBlocker(pending,{budget:"available",producerLeaseActive:true,hasApprovedStart:true})).toBeNull();
    expect(storyBatchBlocker({...pending,pending:0}, {budget:"exhausted",producerLeaseActive:false,hasApprovedStart:false})).toBeNull();
  });

  it("scopes each request to the selected stream and uses a fresh id after success", async () => {
    const post = vi.fn().mockResolvedValue({ batchId: "batch", requested: 4, scheduled: 0, pending: 4 });
    const makeId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    const request = createStoryBatchRequester("my channel", "next stream", post as typeof apiFetch, makeId);
    await request(); await request();
    expect(storyBatchPath("my channel", "next stream")).toBe("/channels/my%20channel/streams/next%20stream/story-batches");
    expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual({requestId:"first"});
    expect(JSON.parse(post.mock.calls[1]![1].body)).toEqual({requestId:"second"});
  });

  it("retries an uncertain delivery with the same id and blocks overlapping clicks", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const post = vi.fn().mockImplementationOnce(async () => { await gate; throw new ApiError("offline",0,"network"); })
      .mockResolvedValueOnce({batchId:"one",requested:4,scheduled:1,pending:3});
    const id = vi.fn().mockReturnValue("one-id");
    const request = createStoryBatchRequester("channel","main",post as typeof apiFetch,id);
    const first = request();
    await expect(request()).rejects.toThrow("already in progress");
    finish(); await expect(first).rejects.toMatchObject({code:"network"});
    await expect(request()).resolves.toMatchObject({batchId:"one"});
    expect(id).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.map(call => JSON.parse(call[1].body).requestId)).toEqual(["one-id","one-id"]);
  });

  it("retains an id across rejected retries until the request succeeds", async () => {
    const post = vi.fn().mockRejectedValueOnce(new ApiError("not allowed",403,"forbidden"))
      .mockResolvedValueOnce({batchId:"two",requested:4,scheduled:0,pending:4});
    const id = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    const request = createStoryBatchRequester("channel","main",post as typeof apiFetch,id);
    await expect(request()).rejects.toMatchObject({status:403});
    await request();
    expect(id).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.map(call => JSON.parse(call[1].body).requestId)).toEqual(["first","first"]);
  });
});
