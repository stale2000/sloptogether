import { describe, expect, it, vi } from "vitest";
import { ApiError, type apiFetch } from "./api";
import { canRequestStoryBatch, createStoryBatchRequester, storyBatchBlocker, storyBatchPath } from "./story-batch-request";

describe("story batch request", () => {
  it("offers the action only to the selected broadcaster", () => {
    const channels = [{twitchChannelId:"1",login:"owner",role:"broadcaster" as const},{twitchChannelId:"2",login:"other",role:"moderator" as const}];
    expect(canRequestStoryBatch({authenticated:true,channels}, "OWNER")).toBe(true);
    expect(canRequestStoryBatch({authenticated:true,channels}, "1")).toBe(true);
    expect(canRequestStoryBatch({authenticated:true,channels}, "other")).toBe(false);
    expect(canRequestStoryBatch({authenticated:true,channels}, "2")).toBe(false);
    expect(canRequestStoryBatch({authenticated:false,channels}, "owner")).toBe(false);
  });

  it("distinguishes budget and producer waits without claiming work is running", () => {
    const pending = {batchId:"b",requested:4 as const,scheduled:0,pending:4};
    expect(storyBatchBlocker(pending,{budget:"available",producerLeaseActive:true,hasApprovedStart:false})).toBe("start");
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
