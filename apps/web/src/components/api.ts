import type { ProgramItem, PublicChannelSummary } from "@sloptogether/contracts";

export const API_BASE = "/sloptogether/api/v1";

export interface LiveElection {
  id: string;
  segmentId: string;
  closesAt: string;
  state: "open" | "closed" | "selected";
  choices: Array<{ id: string; title: string; votes: number; thumbnailUrl?: string }>;
  myChoiceId?: string | null;
}

export interface ProgramOutput {
  currentProgramItem: (ProgramItem & {
    mimeType?: string;
    upscaleUrl?: string;
    subscriberLabel?: string;
    segmentId?: string | null;
  }) | null;
  sequence: number;
  storyPositionSeconds: number;
  interruptPositionSeconds?: number;
  sourceController?: "this_browser" | "another_browser" | "offline";
  storyResumeAvailable?: boolean;
}

export interface ChannelBundle {
  channel: PublicChannelSummary;
  timeline: PublicTimelineResponse;
  program: ProgramOutput;
  election?: LiveElection | null;
}

export interface PublicTimelineResponse {
  segments: PublicChannelSummary["segments"];
  elections?: LiveElection[];
  revision?: number;
}

export interface SessionSummary {
  authenticated: boolean;
  configured?: { twitchOAuth: boolean };
  user?: { twitchUserId: string; displayName: string; login: string };
  channels?: Array<{ twitchChannelId: string; login: string; role: "broadcaster" | "moderator" }>;
  scopes?: string[];
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError("Couldn't reach SlopTogether. Check the connection and try again.", 0, "network");
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const row = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const nested = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : {};
    const message = (typeof nested.message === "string" ? nested.message : undefined)
      ?? (typeof row.message === "string" ? row.message : undefined)
      ?? (typeof row.error === "string" ? row.error : undefined)
      ?? `Request failed (${response.status}).`;
    throw new ApiError(message, response.status, typeof nested.code === "string" ? nested.code : typeof row.error === "string" ? row.error : undefined);
  }
  return payload as T;
}

export function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function displayProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "channel_not_found") return "This channel is not set up yet.";
    if (error.status === 404 || error.status === 503) return "This service is not configured yet. Your settings and content haven't been changed.";
    if (error.status === 401) return "Connect Twitch to continue.";
    if (error.status === 403) return "Your Twitch account doesn't have permission for this action.";
    return error.message;
  }
  return "Something went wrong. Please try again.";
}
