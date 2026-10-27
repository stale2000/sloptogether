import { apiFetch } from "./api";
import type { SessionSummary } from "./api";

export interface StoryBatchStatus {
  batchId: string;
  requested: 4;
  scheduled: number;
  pending: number;
  createdAt?: string;
}

export interface StoryBatchAvailability {
  producerLeaseActive: boolean;
  budget: "available" | "unavailable" | "exhausted";
  hasApprovedStart: boolean;
}

export function canRequestStoryBatch(session: SessionSummary, channel: string): boolean {
  return session.authenticated && Boolean(session.channels?.some(
    item => (item.login.toLowerCase() === channel.toLowerCase() || item.twitchChannelId === channel) && item.role === "broadcaster",
  ));
}

export function storyBatchBlocker(status: StoryBatchStatus | null, availability: StoryBatchAvailability | null): "start" | "budget" | "producer" | null {
  if (!status || status.pending <= 0 || !availability) return null;
  if (!availability.hasApprovedStart) return "start";
  if (availability.budget !== "available") return "budget";
  return availability.producerLeaseActive ? null : "producer";
}

export function storyBatchPath(channel: string, stream: string): string {
  return `/channels/${encodeURIComponent(channel)}/streams/${encodeURIComponent(stream)}/story-batches`;
}

/** Retain the same request id if delivery is ambiguous; a retry must not buy another batch. */
export function createStoryBatchRequester(
  channel: string,
  stream: string,
  post: typeof apiFetch = apiFetch,
  makeId: () => string = () => crypto.randomUUID(),
) {
  let requestId: string | null = null;
  let busy = false;
  return async (): Promise<StoryBatchStatus> => {
    if (busy) throw new Error("Story batch request already in progress");
    busy = true;
    try {
      requestId ??= makeId();
      const result = await post<StoryBatchStatus>(storyBatchPath(channel, stream), {
        method: "POST", body: JSON.stringify({ requestId }),
      });
      requestId = null;
      return result;
    } finally {
      busy = false;
    }
  };
}
