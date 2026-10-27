import { apiFetch } from "./api";

export interface StoryBatchStatus {
  batchId: string;
  requested: 4;
  scheduled: number;
  pending: number;
  createdAt?: string;
  items?: StoryBatchItem[];
}

export interface StoryBatchItem {
  itemId?: string;
  position: number;
  state: string;
  prompt: string | null;
  dialogue: string | null;
  startFrameUrl: string | null;
  endFrameUrl?: string | null;
  startBoundaryRevisionId?: string | null;
  candidateRevision?: number;
  candidateApproved?: boolean;
  candidateRejected?: boolean;
  canApprove?: boolean;
  canReject?: boolean;
  canReplan?: boolean;
  screenBlocked?: boolean;
  canRetryScreen?: boolean;
}

export interface StoryCandidateFrame {
  boundaryRevisionId: string;
  assetId: string;
  previewUrl: string;
  createdAt: string;
}

export function storyCandidatePath(channel: string, stream: string): string {
  return `/channels/${encodeURIComponent(channel)}/streams/${encodeURIComponent(stream)}/story-candidates`;
}

export async function storyCandidateFrames(channel: string, stream: string): Promise<StoryCandidateFrame[]> {
  const result = await apiFetch<{frames:StoryCandidateFrame[]}>(`${storyCandidatePath(channel, stream)}/frames`);
  return Array.isArray(result.frames) ? result.frames : [];
}

export async function approveStoryCandidate(channel:string,stream:string,itemId:string,boundaryRevisionId:string,expectedCandidateRevision:number):Promise<void> {
  await apiFetch(`${storyCandidatePath(channel,stream)}/${encodeURIComponent(itemId)}/approve`, {
    method:"POST", body:JSON.stringify({boundaryRevisionId,expectedCandidateRevision}),
  });
}

export async function submitOwnerCandidate(channel:string,stream:string,itemId:string,boundaryRevisionId:string,expectedCandidateRevision:number,prompt:string):Promise<void> {
  await apiFetch(`${storyCandidatePath(channel,stream)}/${encodeURIComponent(itemId)}/owner-submit`, {
    method:"POST", body:JSON.stringify({boundaryRevisionId,expectedCandidateRevision,prompt}),
  });
}

export async function rejectStoryCandidate(channel:string,stream:string,itemId:string,expectedCandidateRevision:number,reason:string):Promise<void> {
  await apiFetch(`${storyCandidatePath(channel,stream)}/${encodeURIComponent(itemId)}/reject`, {
    method:"POST", body:JSON.stringify({expectedCandidateRevision,reason}),
  });
}

function createStoryCandidateAction(channel:string,stream:string,itemId:string,action:"replan"|"retry-screen",post:typeof apiFetch,makeId:()=>string) {
  let requestId:string|null=null;
  let busy=false;
  return async(expectedCandidateRevision:number):Promise<void> => {
    if(busy)throw new Error("Candidate request already in progress");
    busy=true;
    try {
      requestId ??= makeId();
      await post(`${storyCandidatePath(channel,stream)}/${encodeURIComponent(itemId)}/${action}`, {
        method:"POST",body:JSON.stringify({expectedCandidateRevision,requestId}),
      });
      requestId=null;
    } finally { busy=false; }
  };
}

export function createStoryCandidateReplanner(channel:string,stream:string,itemId:string,post:typeof apiFetch=apiFetch,makeId:()=>string=()=>crypto.randomUUID()) {
  return createStoryCandidateAction(channel,stream,itemId,"replan",post,makeId);
}

export function createStoryCandidateScreenRetry(channel:string,stream:string,itemId:string,post:typeof apiFetch=apiFetch,makeId:()=>string=()=>crypto.randomUUID()) {
  return createStoryCandidateAction(channel,stream,itemId,"retry-screen",post,makeId);
}

export function storyBatchItemLabel(state: string): string {
  switch (state) {
    case "pending": return "Waiting";
    case "planned": return "Needs review";
    case "ready": return "Ready";
    case "leased": return "Claimed";
    case "running": return "Generating";
    case "uploaded": case "validating": return "Checking";
    case "succeeded": return "Complete";
    case "played": return "Played";
    case "failed": return "Failed";
    case "rejected": return "Rejected";
    case "expired": return "Expired";
    case "cancelled": return "Cancelled";
    case "superseded": return "Replaced";
    default: return "Queued";
  }
}

export interface StoryBatchAvailability {
  producerLeaseActive: boolean;
  budget: "available" | "unavailable" | "exhausted" | null;
  hasApprovedStart: boolean;
}

export function storyBatchBlocker(status: StoryBatchStatus | null, availability: StoryBatchAvailability | null): "budget" | "producer" | null {
  if (!status || status.pending <= 0 || !availability) return null;
  if (availability.budget !== null && availability.budget !== "available") return "budget";
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
