"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, displayProblem, type SessionSummary } from "./api";
import { canRequestStoryBatch, createStoryBatchRequester, storyBatchBlocker, storyBatchPath, type StoryBatchAvailability, type StoryBatchStatus } from "./story-batch-request";

export function StoryBatchControl({ channel, stream }: { channel: string; stream: string }) {
  return <StoryBatchControlInner key={`${channel}/${stream}`} channel={channel} stream={stream}/>;
}

function StoryBatchControlInner({ channel, stream }: { channel: string; stream: string }) {
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StoryBatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<StoryBatchAvailability|null>(null);
  const running = useRef(false);
  const revision = useRef(0);
  const submit = useMemo(() => createStoryBatchRequester(channel, stream), [channel, stream]);

  useEffect(() => {
    let active = true;
    void apiFetch<SessionSummary>("/auth/session").then(session => {
      if (!active) return;
      setAuthorized(canRequestStoryBatch(session, channel));
    }).catch(() => { if (active) setAuthorized(false); });
    return () => { active = false; };
  }, [channel]);

  useEffect(() => {
    if (!authorized) return;
    let active = true;
    const poll = async () => {
      const current = ++revision.current;
      try {
        const result = await apiFetch<{ batches: StoryBatchStatus[]; availability?:StoryBatchAvailability }>(storyBatchPath(channel, stream));
        if (active && current === revision.current) {
          setStatus(Array.isArray(result.batches) ? result.batches[0] ?? null : null);
          setAvailability(result.availability ?? null);
        }
      } catch { /* The action still reports its own errors. */ }
    };
    void poll();
    const timer = window.setInterval(() => { if (!document.hidden) void poll(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [authorized, channel, stream]);

  if (!authorized) return null;
  const blocker = storyBatchBlocker(status, availability);
  const generate = async () => {
    if (running.current) return;
    running.current = true;
    revision.current += 1;
    setBusy(true); setError(null);
    try { const result = await submit(); revision.current += 1; setStatus(result); }
    catch (problem) { setError(displayProblem(problem)); }
    finally { running.current = false; setBusy(false); }
  };
  return <div className="panel" style={{display:"flex",gap:"1rem",alignItems:"center",flexWrap:"wrap"}}>
    <button type="button" className="button" disabled={busy} onClick={() => void generate()}>{busy ? "Queueing…" : "Generate 4 clips"}</button>
    {status ? <span role="status">{status.scheduled}/{status.requested} clips scheduled</span> : null}
    {blocker === "start" ? <Link className="text-link" href={`/channels/${encodeURIComponent(channel)}/streams/${encodeURIComponent(stream)}`}>Add an approved starting clip</Link> : null}
    {blocker === "budget" ? <Link className="text-link" href={`/control/${encodeURIComponent(channel)}`}>Set generation budget</Link> : null}
    {blocker === "producer" ? <span>Waiting for story producer</span> : null}
    {error ? <span role="alert" className="inline-error">{error}</span> : null}
  </div>;
}
