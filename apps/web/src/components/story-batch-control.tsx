"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ApiError, apiFetch, displayProblem, type SessionSummary } from "./api";
import { approveStoryCandidate, createStoryBatchRequester, createStoryCandidateReplanner, createStoryCandidateScreenRetry, rejectStoryCandidate, storyBatchBlocker, storyBatchItemLabel, storyBatchPath, storyCandidateFrames, type StoryBatchAvailability, type StoryBatchItem, type StoryBatchStatus, type StoryCandidateFrame } from "./story-batch-request";

export function StoryBatchControl({ channel, stream }: { channel: string; stream: string }) {
  return <StoryBatchControlInner key={`${channel}/${stream}`} channel={channel} stream={stream}/>;
}

function StoryBatchControlInner({ channel, stream }: { channel: string; stream: string }) {
  const [authorized, setAuthorized] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [canView, setCanView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StoryBatchStatus | null>(null);
  const [batches, setBatches] = useState<StoryBatchStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState(false);
  const [availability, setAvailability] = useState<StoryBatchAvailability|null>(null);
  const running = useRef(false);
  const revision = useRef(0);
  const refresh = useRef<(() => Promise<void>) | null>(null);
  const submit = useMemo(() => createStoryBatchRequester(channel, stream), [channel, stream]);

  useEffect(() => {
    let active = true;
    void apiFetch<SessionSummary>("/auth/session").then(session => {
      if (!active) return;
      setSignedIn(session.authenticated);
    }).catch(() => { if (active) { setSignedIn(false); setAuthorized(false); } });
    return () => { active = false; };
  }, [channel]);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    let permitted = true;
    const poll = async () => {
      const current = ++revision.current;
      try {
        const result = await apiFetch<{ batches: StoryBatchStatus[]; canGenerate: boolean; availability?:StoryBatchAvailability }>(storyBatchPath(channel, stream));
        if (active && current === revision.current) {
          setCanView(true);
          setAuthorized(result.canGenerate === true);
          setQueueError(false);
          const rows = Array.isArray(result.batches) ? result.batches : [];
          setBatches(rows);
          setStatus(rows[0] ?? null);
          setAvailability(result.availability ?? null);
        }
      } catch (problem) {
        if (active && current === revision.current && problem instanceof ApiError && (problem.status === 401 || problem.status === 403)) {
          permitted = false;
          setCanView(false);
          setAuthorized(false);
          setQueueError(false);
        } else if (active && current === revision.current) setQueueError(true);
      }
    };
    refresh.current = poll;
    void poll();
    const timer = window.setInterval(() => { if (permitted && !document.hidden) void poll(); }, 5000);
    return () => { active = false; refresh.current = null; window.clearInterval(timer); };
  }, [signedIn, channel, stream]);

  if (!authorized && !canView && !queueError) return null;
  const blocker = authorized ? storyBatchBlocker(status, availability) : null;
  const generate = async () => {
    if (running.current) return;
    running.current = true;
    revision.current += 1;
    setBusy(true); setError(null);
    try {
      const result = await submit();
      revision.current += 1;
      setStatus(result);
      setBatches(current => current.some(batch => batch.batchId === result.batchId) ? current : [result, ...current]);
      void refresh.current?.();
    }
    catch (problem) { setError(displayProblem(problem)); }
    finally { running.current = false; setBusy(false); }
  };
  return <>
  <div className="panel" style={{display:"flex",gap:"1rem",alignItems:"center",flexWrap:"wrap"}}>
    {authorized ? <button type="button" className="button" disabled={busy} onClick={() => void generate()}>{busy ? "Queueing…" : "Generate 4 clips"}</button> : null}
    {status ? <span role="status">{status.scheduled}/{status.requested} clips scheduled</span> : null}
    {blocker === "budget" ? <Link className="text-link" href={`/control/${encodeURIComponent(channel)}`}>Set generation budget</Link> : null}
    {blocker === "producer" ? <span>Waiting for story producer</span> : null}
    {error ? <span role="alert" className="inline-error">{error}</span> : null}
    {queueError ? <span role="alert">Queue unavailable <button type="button" className="button secondary small" onClick={() => void refresh.current?.()}>Retry</button></span> : null}
  </div>
  <StoryBatchList batches={batches} channel={channel} stream={stream} onChanged={() => void refresh.current?.()}/>
  </>;
}

function CandidateApproval({ item, channel, stream, onChanged }: { item: StoryBatchItem; channel: string; stream: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [frames, setFrames] = useState<StoryCandidateFrame[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string|null>(null);
  const selectedFrame = frames.find(frame => frame.boundaryRevisionId === selected);
  const replan = useMemo(() => item.itemId ? createStoryCandidateReplanner(channel,stream,item.itemId) : null, [channel,stream,item.itemId]);
  const retryScreen = useMemo(() => item.itemId ? createStoryCandidateScreenRetry(channel,stream,item.itemId) : null, [channel,stream,item.itemId]);

  const choose = async () => {
    setOpen(true); setBusy(true); setError(null);
    try { setFrames(await storyCandidateFrames(channel, stream)); }
    catch (problem) { setError(displayProblem(problem)); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!item.itemId || !selected || !Number.isSafeInteger(item.candidateRevision)) return;
    setBusy(true); setError(null);
    try {
      await approveStoryCandidate(channel, stream, item.itemId, selected, item.candidateRevision!);
      setOpen(false); setSelected(""); onChanged();
    } catch (problem) { setError(displayProblem(problem)); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    const reason = window.prompt("Reason for rejection:");
    if (!reason?.trim() || !item.itemId || !Number.isSafeInteger(item.candidateRevision)) return;
    setBusy(true); setError(null);
    try {
      await rejectStoryCandidate(channel, stream, item.itemId, item.candidateRevision!, reason.trim());
      setOpen(false); onChanged();
    } catch (problem) { setError(displayProblem(problem)); }
    finally { setBusy(false); }
  };
  const tryAgain = async () => {
    if (!replan || !Number.isSafeInteger(item.candidateRevision)) return;
    setBusy(true); setError(null);
    try { await replan(item.candidateRevision!); onChanged(); }
    catch (problem) { setError(displayProblem(problem)); }
    finally { setBusy(false); }
  };
  const retryCheck = async () => {
    if (!retryScreen || !Number.isSafeInteger(item.candidateRevision)) return;
    setBusy(true); setError(null);
    try { await retryScreen(item.candidateRevision!); onChanged(); }
    catch (problem) { setError(displayProblem(problem)); }
    finally { setBusy(false); }
  };
  if (!open) return <div className="story-candidate-buttons">
    {item.canApprove ? <button type="button" className="button secondary small" aria-label={`Choose start frame for clip ${item.position + 1}`} disabled={busy} onClick={() => void choose()}>Choose start frame</button> : null}
    {item.canReject ? <button type="button" className="button danger small" aria-label={`Reject clip ${item.position + 1}`} disabled={busy} onClick={() => void reject()}>Reject</button> : null}
    {item.canReplan ? <button type="button" className="button secondary small" aria-label={`Try clip ${item.position + 1} again`} disabled={busy} onClick={() => void tryAgain()}>Try again</button> : null}
    {item.canRetryScreen ? <button type="button" className="button secondary small" aria-label={`Retry input check for clip ${item.position + 1}`} disabled={busy} onClick={() => void retryCheck()}>Retry check</button> : null}
    {error ? <span className="inline-error" role="alert">{error}</span> : null}
  </div>;
  return <div className="story-candidate-approval">
    <label>Start frame <select className="select-input" value={selected} onChange={event => setSelected(event.currentTarget.value)} disabled={busy}>
      <option value="">Choose a frame</option>
      {frames.map((frame,index) => <option value={frame.boundaryRevisionId} key={frame.boundaryRevisionId}>Frame {index+1} · {new Date(frame.createdAt).toLocaleString()}</option>)}
    </select></label>
    {selectedFrame ? <Image src={selectedFrame.previewUrl} alt="Selected start frame" width={480} height={270} unoptimized/> : null}
    {!busy && !frames.length && !error ? <Link className="text-link" href={`/channels/${encodeURIComponent(channel)}/streams/${encodeURIComponent(stream)}/participate`}>Add a frame</Link> : null}
    {error ? <span className="inline-error" role="alert">{error}</span> : null}
    <div className="row"><button type="button" className="button small" aria-label={`Approve clip ${item.position + 1}`} disabled={busy || !selected} onClick={() => void approve()}>{busy ? "Saving…" : "Approve"}</button>{item.canReject ? <button type="button" className="button danger small" aria-label={`Reject clip ${item.position + 1}`} disabled={busy} onClick={() => void reject()}>Reject</button> : null}<button type="button" className="button secondary small" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
  </div>;
}

export function StoryBatchList({ batches, channel, stream, onChanged = () => {} }: { batches: StoryBatchStatus[]; channel?:string; stream?:string; onChanged?:() => void }) {
  const visible = batches.filter(batch => batch.items?.length && batch.items.some(item => item.state !== "played")).slice().reverse();
  if (!visible.length) return null;
  return <section className="story-batches" aria-label="Upcoming clips">
    <h2>Upcoming clips</h2>
    {visible.map((batch, index) => {
      const items = <div className="story-batch-items">{batch.items?.map(item => <article className="story-batch-item" key={item.position}>
        <div className="story-batch-frames">
          <div className="story-batch-frame">{item.startFrameUrl ? <Image src={item.startFrameUrl} alt={`Start frame for clip ${item.position + 1}`} width={480} height={270} unoptimized/> : null}</div>
          {item.endFrameUrl ? <div className="story-batch-frame"><Image src={item.endFrameUrl} alt={`End frame for clip ${item.position + 1}`} width={480} height={270} unoptimized/></div> : null}
        </div>
        <div className="story-batch-copy"><div className="story-batch-meta">Clip {item.position + 1} · {item.screenBlocked ? "Input check blocked" : item.candidateRejected ? "Rejected" : item.state === "planned" && item.candidateApproved ? (item.endFrameUrl ? "Approved" : "Awaiting next start frame") : storyBatchItemLabel(item.state)}</div>
          {item.prompt ? <p>{item.prompt}</p> : <span className="story-batch-wait">Waiting for prompt</span>}
          {item.dialogue ? <p className="story-batch-dialogue">“{item.dialogue}”</p> : null}
          {(item.canApprove || item.canReject || item.canReplan || item.canRetryScreen) && item.itemId && channel && stream ? <CandidateApproval key={`${item.itemId}:${item.candidateRevision}`} item={item} channel={channel} stream={stream} onChanged={onChanged}/> : null}
        </div>
      </article>)}</div>;
      const needsAttention = batch.items?.some(item => item.screenBlocked || ["failed", "rejected", "expired", "cancelled", "superseded"].includes(item.state));
      const expanded = index === 0 || index === visible.length - 1 || needsAttention;
      if (!expanded) return <details className="story-batch" key={batch.batchId}><summary className="story-batch-heading">Batch {index + 1} · {batch.scheduled}/4 scheduled</summary>{items}</details>;
      return <div className="story-batch" key={batch.batchId}>
        {visible.length > 1 ? <div className="story-batch-heading">Batch {index + 1}</div> : null}{items}
      </div>;
    })}
  </section>;
}
