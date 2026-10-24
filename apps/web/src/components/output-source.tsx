"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError,apiFetch, displayProblem, type SessionSummary } from "./api";
import { useChannelProgram, useChannelTimeline } from "./channel-data";
import { ProgramPlayer } from "./program-player";

interface ControllerSession { controllerEpoch: number; leaseId?: string; canControl: boolean }

export function shouldRetryControllerClaim(status:number|null){
  return status!==401&&status!==403;
}

export function OutputSource({ channel }: { channel: string }) {
  const data = useChannelTimeline(channel);
  const program = useChannelProgram(channel);
  const [hasStarted, setHasStarted] = useState(false);
  const [controller, setController] = useState<ControllerSession | null>(null);
  const [controllerNeedsLogin,setControllerNeedsLogin]=useState(false);
  const [error, setError] = useState<string | null>(null);
  const notifyPlaybackNeedsUserStart=useCallback(()=>setHasStarted(false),[]);
  const sequence = useRef(0);
  const lastSentAt = useRef(0);
  const requestInFlight=useRef(false);
  const lastAcceptedPosition=useRef<{itemId:string;seconds:number;manifestRevision:number}|null>(null);
  const latestPosition = useRef<{ itemId: string; seconds: number; manifestRevision: number } | null>(null);
  const timer = useRef<number | null>(null);

  const tryClaimOutput = useCallback(async () => {
    setError(null);
    try {
      const session=await apiFetch<SessionSummary>("/auth/session");
      const canControl=session.authenticated&&session.channels?.some(item=>item.login.toLowerCase()===channel.toLowerCase());
      if(!canControl){
        setController(null);setControllerNeedsLogin(true);
        return;
      }
      const result = await apiFetch<ControllerSession>(`/channels/${encodeURIComponent(channel)}/playback/controller`, { method: "POST", body: JSON.stringify({ clientInstanceId: sessionInstanceId() }) });
      setController(result);
      setControllerNeedsLogin(false);
    } catch (problem) {
      const message = displayProblem(problem);
      const status=problem instanceof ApiError?problem.status:null;
      setController(null);
      setControllerNeedsLogin(!shouldRetryControllerClaim(status));
      if(shouldRetryControllerClaim(status))setError(message);
    }
  }, [channel]);

  const reportPosition = useCallback(async (position: { itemId: string; seconds: number; manifestRevision: number }) => {
    if (!controller?.canControl) return;
    if(requestInFlight.current){latestPosition.current=position;return;}
    const now = Date.now();
    if (now - lastSentAt.current < 4000) {
      latestPosition.current = position;
      return;
    }
    lastSentAt.current = now;
    latestPosition.current = null;
    requestInFlight.current=true;
    try {
      const latestProgram = program.state === "ready" ? program.value : null;
      if (!latestProgram || position.manifestRevision !== latestProgram.manifestRevision) {
        latestPosition.current = null;
        return;
      }
      await apiFetch(`/channels/${encodeURIComponent(channel)}/playback/position`, {
        method: "POST",
        body: JSON.stringify({ itemId: position.itemId, offsetSeconds: position.seconds, controllerEpoch: controller.controllerEpoch, programEpoch: latestProgram.epoch, manifestRevision: position.manifestRevision, sequence: ++sequence.current }),
      });
      lastAcceptedPosition.current=position;
    } catch (problem) {
      if(problem instanceof ApiError&&["playback_manifest_stale","playback_sequence_stale"].includes(problem.code??"")){
        latestPosition.current=position;
        return;
      }
      setError(displayProblem(problem));
      setController(null);
    }finally{requestInFlight.current=false;}
  }, [channel, controller, program]);

  useEffect(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    if (controller?.canControl) {
      timer.current = window.setInterval(() => {
        const queued = latestPosition.current??lastAcceptedPosition.current;
        if (queued) void reportPosition(queued);
      }, 4200);
    }
    return () => { if (timer.current !== null) window.clearInterval(timer.current); };
  }, [controller, reportPosition]);

  useEffect(()=>{
    if(!hasStarted||controller?.canControl)return;
    const id=window.setInterval(()=>void tryClaimOutput(),10_000);
    return()=>window.clearInterval(id);
  },[controller?.canControl,hasStarted,tryClaimOutput]);

  const current = data.state === "ready" ? data.value.currentProgramItem : null;
  useEffect(()=>{
    const marker=program.state==="ready"?program.value.playhead:null;
    if(!marker||!controller?.canControl||marker.controllerEpoch<=controller.controllerEpoch)return;
    queueMicrotask(()=>void tryClaimOutput());
  },[controller?.canControl,controller?.controllerEpoch,program,tryClaimOutput]);
  const programReady = program.state === "ready" && !!program.value.playlistUrl;
  return (
    <main className="output-page">
      <header className="output-topbar">
        <Link href={`/channels/${encodeURIComponent(channel)}`} className="output-brand"><span className="brand-mark" aria-hidden="true"/>slop<span>together</span></Link>
        <span className="output-channel">@{channel.toLowerCase()} · 16:9 PROGRAM</span>
        <div className="output-status"><span className={`tiny-dot${programReady || current ? "" : " waiting-dot"}`} />{program.state==="ready"&&program.refreshError?"RECONNECTING · PLAYING BUFFERED VIDEO":controllerNeedsLogin ? "PUBLIC PREVIEW" : programReady ? "CONTINUOUS SOURCE READY" : data.state === "ready" && current ? "CLIP PREVIEW AVAILABLE" : data.state === "error" || program.state === "error" ? "SOURCE UNAVAILABLE" : "WAITING FOR APPROVED CONTENT"}</div>
      </header>
      <section className="output-stage" aria-label="Channel program output">
        <div className="output-player">
          <ProgramPlayer program={program.state === "ready" ? program.value : null} fallbackItem={current} clean autoPlayIntent={hasStarted}
            autoInterruptId={data.state==="ready"&&data.value.subscriberInterrupts?.current?.state==="ready"?data.value.subscriberInterrupts.current.id:undefined}
            canAutoInterrupt={controller?.canControl===true}
            onNeedsUserStart={notifyPlaybackNeedsUserStart} onProgress={(event) => { latestPosition.current = event; void reportPosition(event); }} />
          {!hasStarted && (programReady || current) ? <div className="output-start-gate"><div className="start-mark">✦</div><strong>Ready when you are.</strong><span>{programReady ? "Start the continuous browser program, then capture this window in OBS." : "Start a clip preview while the continuous program is being prepared."}</span><button className="button" onClick={async () => { await tryClaimOutput(); const video = document.querySelector(".output-player video") as HTMLVideoElement | null; if (video) await video.play().then(() => setHasStarted(true)).catch(() => setError("Press play in this window to start audio and video.")); }}>Start program <span aria-hidden="true">▶</span></button></div> : null}
          {data.state === "error" || error ? <div className="output-error" role="status">{error ?? (data.state === "error" ? data.error : "")}</div> : null}
          {program.state === "error" && !current ? <div className="output-error" role="status">{program.error}<button className="button secondary small" onClick={program.retry}>Retry source</button></div> : null}
          {data.state === "ready" && !current && !programReady ? <div className="output-awaiting"><div className="start-mark">◌</div><strong>Waiting for the next approved scene</strong><span>Queue, review and story status stay in the separate control room.</span></div> : null}
        </div>
      </section>
      <footer className="output-footer"><span>SL<span className="output-star">✦</span> LIVE STORY SOURCE</span><span>{programReady ? "CONTINUOUS HLS · CAPTURE THIS WINDOW IN OBS" : current?.kind === "subscriber_interrupt" ? `SUBSCRIBER MOMENT · ${current.subscriberLabel ?? "COMMUNITY"}` : "CAPTURE THIS WINDOW IN OBS"}</span></footer>
    </main>
  );
}

function sessionInstanceId() {
  const key = "sloptogether-output-client";
  try {
    let id = sessionStorage.getItem(key);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
