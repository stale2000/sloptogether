"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError,apiFetch, displayProblem, type SessionSummary } from "./api";
import { isLocalDemoFallbackEnabled,useChannelProgram,useChannelTimeline } from "./channel-data";
import { ProgramPlayer } from "./program-player";

interface ControllerSession { controllerEpoch: number; leaseId?: string; canControl: boolean }

export function shouldRetryControllerClaim(status:number|null){
  return status!==401&&status!==403;
}

export function OutputSource({ channel }: { channel: string }) {
  const data = useChannelTimeline(channel);
  const program = useChannelProgram(channel);
  const programReady = program.state === "ready" && !!program.value.playlistUrl;
  const [hasStarted, setHasStarted] = useState(false);
  const [controller, setController] = useState<ControllerSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playheadSeconds,setPlayheadSeconds]=useState(0);
  const [scrubSeconds,setScrubSeconds]=useState(0);
  const [scrubbing,setScrubbing]=useState(false);
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
        setController(null);
        return;
      }
      const result = await apiFetch<ControllerSession>(`/channels/${encodeURIComponent(channel)}/playback/controller`, { method: "POST", body: JSON.stringify({ clientInstanceId: sessionInstanceId() }) });
      setController(result);
    } catch (problem) {
      const message = displayProblem(problem);
      const status=problem instanceof ApiError?problem.status:null;
      setController(null);
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
  const programSpans=program.state==="ready"?program.value.programSpans:[];
  const programDuration=programSpans.reduce((maximum,span)=>Math.max(maximum,span.outputEndSeconds),0);
  const scrubPercent=programDuration>0?Math.max(0,Math.min(100,((scrubbing?scrubSeconds:playheadSeconds)/programDuration)*100)):0;
  const programIdentity=program.state==="ready"?`${program.value.epoch}:${program.value.manifestRevision}`:"";
  const localDemoPlaying=program.state==="ready"&&isLocalDemoFallbackEnabled(channel)&&program.value.playlistUrl==="/sloptogether/demo/localdemo/playlist.m3u8";
  useEffect(()=>{
    const video=document.querySelector(".output-player video") as HTMLVideoElement|null;
    if(!video)return;
    const update=()=>{if(!scrubbing)setPlayheadSeconds(video.currentTime)};
    update();video.addEventListener("timeupdate",update);video.addEventListener("durationchange",update);
    return()=>{video.removeEventListener("timeupdate",update);video.removeEventListener("durationchange",update)};
  },[programIdentity,programReady,scrubbing]);
  const seekTo=(seconds:number)=>{
    const video=document.querySelector(".output-player video") as HTMLVideoElement|null;
    if(!video||!Number.isFinite(seconds))return;
    const target=Math.max(0,Math.min(programDuration,seconds));
    video.currentTime=target;setPlayheadSeconds(target);setScrubSeconds(target);setScrubbing(false);
    void video.play().then(()=>setHasStarted(true)).catch(()=>setError("Press Start program to play the selected clip."));
  };
  useEffect(()=>{
    const marker=program.state==="ready"?program.value.playhead:null;
    if(!marker||!controller?.canControl||marker.controllerEpoch<=controller.controllerEpoch)return;
    queueMicrotask(()=>void tryClaimOutput());
  },[controller?.canControl,controller?.controllerEpoch,program,tryClaimOutput]);
  return (
    <main className="output-page">
      <section className="output-stage" aria-label="Channel program output">
        <div className={`output-player${hasStarted?" output-started":""}`}>
          <ProgramPlayer program={program.state === "ready" ? program.value : null} fallbackItem={current} clean autoPlayIntent={hasStarted}
            autoInterruptId={data.state==="ready"&&data.value.subscriberInterrupts?.current?.state==="ready"?data.value.subscriberInterrupts.current.id:undefined}
            canAutoInterrupt={controller?.canControl===true}
            onStarted={()=>setHasStarted(true)} onNeedsUserStart={notifyPlaybackNeedsUserStart} onProgress={(event) => { latestPosition.current = event; void reportPosition(event); }} />
          {programReady&&programDuration>0?<div className="output-scrubber" aria-label="Program clip timeline">
            <div className="output-scrubber-row"><span>{formatProgramTime(scrubbing?scrubSeconds:playheadSeconds)}</span><input type="range" min="0" max={programDuration} step="0.1" value={Math.min(programDuration,scrubbing?scrubSeconds:playheadSeconds)} style={{backgroundImage:`linear-gradient(90deg,#9147ff 0%,#9147ff ${scrubPercent}%,#3d3747 ${scrubPercent}%,#3d3747 100%)`}} aria-label="Seek through clips"
              onPointerDown={()=>{setScrubSeconds(playheadSeconds);setScrubbing(true)}} onChange={event=>{setScrubbing(true);setScrubSeconds(Number(event.currentTarget.value))}}
              onPointerUp={event=>seekTo(Number(event.currentTarget.value))} onKeyUp={event=>seekTo(Number(event.currentTarget.value))} onBlur={event=>{if(scrubbing)seekTo(Number(event.currentTarget.value))}} />
              <span>{formatProgramTime(programDuration)}</span></div>
            <div className="output-clip-jumps">{programSpans.map((span,index)=><button type="button" key={span.itemId} aria-label={`Jump to clip ${index+1}`} title={`Clip ${index+1} · ${formatProgramTime(span.outputStartSeconds)}`} onClick={()=>seekTo(span.outputStartSeconds)}>{String(index+1).padStart(2,"0")}</button>)}</div>
          </div>:null}
          {!hasStarted && (programReady || current) ? <div className="output-start-gate"><button type="button" className="output-center-toggle" aria-label="Start program" onClick={async () => { await tryClaimOutput(); const video = document.querySelector(".output-player video") as HTMLVideoElement | null; if (video) await video.play().then(() => setHasStarted(true)).catch(() => setError("Playback is unavailable.")); }}>▶</button></div> : null}
          {data.state === "ready" && !current && !programReady ? <div className="output-awaiting" aria-label="Waiting for media"/> : null}
        </div>
      </section>
      <span className="visually-hidden" role="status">{error??(localDemoPlaying?"":data.state==="error"?data.error:program.state==="error"?program.error:"")}</span>
    </main>
  );
}

function formatProgramTime(seconds:number){
  const value=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));
  return `${Math.floor(value/60)}:${String(value%60).padStart(2,"0")}`;
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
