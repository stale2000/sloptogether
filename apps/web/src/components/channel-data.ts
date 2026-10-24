"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE, ApiError, type LiveElection, type ProgramOutput, type PublicTimelineResponse, apiFetch, displayProblem } from "./api";
import type { PublicTimelineSegment } from "@sloptogether/contracts";
import type { ProgramManifest } from "./program-player";

export interface ChannelDetail {
  twitchChannelId: string;
  twitchLogin: string;
  displayName: string;
  visibility: "public" | "unlisted" | "private";
  createdAt?: string;
  contributionMode?: string;
  workerStatus?: { generation: string; upscale: string };
}

export interface TimelinePayload extends PublicTimelineResponse {
  channel: ChannelDetail;
  segments: Array<PublicTimelineSegment & { programItemId?:string|null; upscaleUrl?:string }>;
  elections: LiveElection[];
  currentProgramItem: ProgramOutput["currentProgramItem"];
  subscriberInterrupts?: {enabled:boolean;current:{id:string;label:string;state:string}|null};
  playback: {
    offsetSeconds: number;
    sequence: number;
    sourceController: "this_browser" | "another_browser" | "offline";
    updatedAt?: string;
  };
}

export type Loadable<T> =
  | { state: "loading" }
  | { state: "ready"; value: T; refreshError?: string }
  | { state: "error"; error: string; retry: () => void };

export function isLocalDemoFallbackEnabled(channel:string,enabled=process.env.NEXT_PUBLIC_LOCAL_DEMO_ENABLED){
  return channel==="localdemo"&&enabled==="true";
}

async function loadLocalDemoProgram():Promise<ProgramManifest>{
  const response=await fetch("/sloptogether/demo/localdemo/program.json",{cache:"force-cache"});
  if(!response.ok)throw new Error("The static local demo playlist is unavailable.");
  const body=await response.json() as Partial<ProgramManifest>;
  if(body.playlistUrl!=="/sloptogether/demo/localdemo/playlist.m3u8"||body.mimeType!=="application/vnd.apple.mpegurl"
    ||!Number.isSafeInteger(body.epoch)||!Number.isSafeInteger(body.manifestRevision)||!Array.isArray(body.programSpans)||body.programSpans.length!==4){
    throw new Error("The static local demo manifest is invalid.");
  }
  return body as ProgramManifest;
}

export function useChannelTimeline(channel: string): Loadable<TimelinePayload> {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{channel:string;payload:TimelinePayload}|null>(null);
  const [error, setError] = useState<{channel:string;message:string}|null>(null);

  const retry = useCallback(() => {
    setError(null);
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let channelMissing = false;
    let reading=false;
    const abort = new AbortController();

    const read = async () => {
      if(reading||channelMissing||document.hidden)return;
      reading=true;
      try {
        const response = await fetch(`${API_BASE}/channels/${encodeURIComponent(channel)}/timeline`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: abort.signal,
        });
        const body = await response.json().catch(() => null) as TimelinePayload | { error?: string; message?: string } | null;
        if (!response.ok) {
          const record = body as { error?: unknown; message?: unknown } | null;
          const code=typeof record?.error==="string"?record.error:undefined;
          throw new ApiError(typeof record?.message === "string" ? record.message : code??`Timeline unavailable (${response.status}).`,response.status,code);
        }
        if (!body || !("channel" in body) || !Array.isArray(body.segments)) throw new Error("The timeline response wasn't valid.");
        if (!stopped) {
          setValue({channel,payload:body as TimelinePayload});
          setError(null);
        }
      } catch (problem) {
        if (!stopped && !(problem instanceof DOMException && problem.name === "AbortError")) {
          if(problem instanceof ApiError&&problem.status===404&&problem.code==="channel_not_found"){
            channelMissing=true;
          }
          setError({channel,message:displayProblem(problem)});
        }
      }finally{reading=false}
    };

    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 6000);
    return () => {
      stopped = true;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [channel, revision]);

  const currentValue=value?.channel===channel?value.payload:null;
  const currentError=error?.channel===channel?error.message:null;
  if (currentValue) return { state: "ready", value:currentValue, ...(currentError?{refreshError:currentError}:{}) };
  if (currentError) return { state: "error", error:currentError, retry };
  return { state: "loading" };
}

export function useChannelProgram(channel: string): Loadable<ProgramManifest> {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<{channel:string;manifest:ProgramManifest}|null>(null);
  const [error, setError] = useState<{channel:string;message:string}|null>(null);
  const retry = useCallback(() => { setError(null); setRevision((n) => n + 1); }, []);

  useEffect(() => {
    let stopped = false;
    let channelMissing = false;
    let reading = false;
    const controller = new AbortController();
    const read = async () => {
      if (reading || channelMissing || document.hidden) return;
      reading = true;
      try {
        const response = await fetch(`${API_BASE}/channels/${encodeURIComponent(channel)}/program`, {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        const body = await response.json().catch(() => null) as (ProgramManifest & {error?:string;message?:string}) | null;
        if (!response.ok) {
          const code=body&&"error" in body&&typeof body.error==="string"?body.error:undefined;
          const message=body&&"message" in body&&typeof body.message==="string"?body.message:code??`Continuous program unavailable (${response.status}).`;
          throw new ApiError(message,response.status,code);
        }
        if (!body || !Number.isSafeInteger(body.epoch) || !Number.isSafeInteger(body.manifestRevision) || !Array.isArray(body.programSpans)) {
          throw new Error("The continuous program manifest was invalid.");
        }
        if (body.playlistUrl) {
          const url = new URL(body.playlistUrl, window.location.origin);
          const configuredOrigins = (process.env.NEXT_PUBLIC_MEDIA_ORIGINS ?? "")
            .split(",").map((origin) => origin.trim()).filter(Boolean);
          const developmentOrigin = process.env.NODE_ENV !== "production"
            && ["localhost", "127.0.0.1"].includes(url.hostname);
          if (url.origin !== window.location.origin && !configuredOrigins.includes(url.origin) && !developmentOrigin) {
            throw new Error("The media source is not in the configured media-origin allowlist.");
          }
          if (url.protocol !== "https:" && !developmentOrigin) throw new Error("Production media sources must use HTTPS.");
        }
        if (!stopped) { setValue({channel,manifest:body}); setError(null); }
      } catch (problem) {
        if (!stopped && !(problem instanceof DOMException && problem.name === "AbortError")) {
          if(problem instanceof ApiError&&problem.status===404&&problem.code==="channel_not_found"){
            channelMissing=true;
            if(isLocalDemoFallbackEnabled(channel)){
              try{
                const manifest=await loadLocalDemoProgram();
                if(!stopped){setValue({channel,manifest});setError(null);}
                return;
              }catch{/* Keep the original missing-channel state if fixture packaging is incomplete. */}
            }
          }
          setError({channel,message:displayProblem(problem)});
        }
      } finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 5000);
    return () => { stopped = true; controller.abort(); window.clearInterval(timer); };
  }, [channel, revision]);

  const currentValue=value?.channel===channel?value.manifest:null;
  const currentError=error?.channel===channel?error.message:null;
  if (currentValue) return { state: "ready", value:currentValue, ...(currentError?{refreshError:currentError}:{}) };
  if (currentError) return { state: "error", error:currentError, retry };
  return { state: "loading" };
}

export async function submitBallot(electionId: string, choiceId: string): Promise<void> {
  await apiFetch(`/elections/${encodeURIComponent(electionId)}/ballots`, {
    method: "POST",
    body: JSON.stringify({ choiceId }),
  });
}
