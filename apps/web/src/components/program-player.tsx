"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { ProgramOutput } from "./api";

export interface ProgramSpan {
  itemId?: string;
  kind: "story" | "subscriber_interrupt";
  outputStartSeconds: number;
  outputEndSeconds: number;
  segmentId?: string;
  sourceStartSeconds?: number;
  interruptId?: string;
  skipPlayback?: boolean;
}

export function shouldSkipInterruptSpan(span:ProgramSpan|undefined,consumed:Set<string>){
  return Boolean(span?.kind==="subscriber_interrupt"&&(span.skipPlayback||consumed.has(span.itemId??span.interruptId??"")));
}

export function interruptsCrossedByForwardSeek(spans:ProgramSpan[],fromSeconds:number,toSeconds:number){
  if(!Number.isFinite(fromSeconds)||!Number.isFinite(toSeconds)||toSeconds<=fromSeconds)return [];
  return spans.filter(span=>span.kind==="subscriber_interrupt"&&!span.skipPlayback
    &&span.outputEndSeconds>fromSeconds&&span.outputEndSeconds<=toSeconds)
    .map(span=>span.itemId??span.interruptId).filter((id):id is string=>Boolean(id));
}

export function hlsPlayerMode(hasMediaSourceExtensions:boolean,canPlayNatively:boolean){
  return hasMediaSourceExtensions?"hls.js":canPlayNatively?"native":"unsupported";
}

export function safeInterruptTransition(spans:ProgramSpan[],position:number,interruptId:string){
  const interrupt=spans.find(span=>span.kind==="subscriber_interrupt"&&span.interruptId===interruptId&&!span.skipPlayback);
  if(!interrupt)return null;
  const story=spans.find(span=>span.kind==="story"&&position>=span.outputStartSeconds-0.001&&position<=span.outputEndSeconds+0.35);
  if(!story||position<story.outputEndSeconds-0.35)return null;
  const nextStory=spans.find(span=>span.kind==="story"&&span.outputStartSeconds>=story.outputEndSeconds-0.001);
  return {interruptItemId:interrupt.itemId??interrupt.interruptId!,interruptStartSeconds:interrupt.outputStartSeconds,
    interruptEndSeconds:interrupt.outputEndSeconds,resumeSeconds:nextStory?.outputStartSeconds??interrupt.outputEndSeconds};
}

export interface ProgramManifest {
  playlistUrl: string | null;
  mimeType: "application/vnd.apple.mpegurl" | "video/mp4";
  epoch: number;
  manifestRevision: number;
  programSpans: ProgramSpan[];
  controller: {
    canControl: boolean;
    controllerEpoch?: number;
    controllerUserId?: string | null;
  };
  playhead?: {itemId:string;outputSeconds:number;controllerEpoch:number;sequence:number}|null;
}

interface ProgressEvent { itemId: string; seconds: number; manifestRevision: number }

export interface ProgramPlayerHandle { seek: (seconds: number) => void }

export function seekOrQueue(media:Pick<HTMLMediaElement,"readyState"|"currentTime">|null,seconds:number):number|null{
  if(media&&media.readyState>=1){
    try{media.currentTime=seconds;return null;}catch{/* retry once metadata is ready */}
  }
  return seconds;
}

export function controllerMarkerDecision(markerEpoch:number,lastEpoch:number|null,manualEpoch:number|null,hasManualSeek:boolean,claimPending:boolean,ownedEpoch:number|null){
  if(markerEpoch===lastEpoch)return "unchanged";
  if(hasManualSeek&&claimPending&&markerEpoch!==manualEpoch)return "wait";
  if(hasManualSeek&&(markerEpoch===manualEpoch||markerEpoch===ownedEpoch))return "ignore";
  return "apply";
}

export function ProgramPlayer({
  program,
  fallbackItem,
  onProgress,
  onEnded,
  onStarted,
  onNeedsUserStart,
  autoPlayIntent=false,
  autoInterruptId,
  canAutoInterrupt=false,
  clean = false,
  seekRef,
  controllerClaimPending=false,
  ownedControllerEpoch=null,
}: {
  program: ProgramManifest | null;
  fallbackItem: ProgramOutput["currentProgramItem"];
  onProgress?: (position: ProgressEvent) => void;
  onEnded?: () => void;
  onStarted?: () => void;
  onNeedsUserStart?: () => void;
  autoPlayIntent?:boolean;
  autoInterruptId?:string;
  canAutoInterrupt?:boolean;
  clean?: boolean;
  seekRef?: Ref<ProgramPlayerHandle>;
  controllerClaimPending?: boolean;
  ownedControllerEpoch?: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingClipPreview, setUsingClipPreview] = useState(false);
  const fallbackRef = useRef(fallbackItem);
  const lastPlayheadEpochRef = useRef<number | null>(null);
  const pendingSeekRef=useRef<number|null>(null);
  const manualSeekRef=useRef<{epoch:number|null;programEpoch:number|null}|null>(null);
  const markerEpochRef=useRef<number|null>(null);
  const programEpochRef=useRef<number|null>(null);
  useEffect(()=>{
    markerEpochRef.current=program?.playhead?.controllerEpoch??null;
    programEpochRef.current=program?.epoch??null;
  },[program?.epoch,program?.playhead?.controllerEpoch]);
  const autoPlayIntentRef=useRef(autoPlayIntent);
  const sourceSwitchingRef=useRef(false);
  const resumeAfterSourceRef=useRef(false);
  const resumePlaybackRef=useRef<(()=>void)|null>(null);
  const interruptResumeRef=useRef<{interruptItemId:string;interruptEndSeconds:number;resumeSeconds:number;controllerEpoch:number;sawInterrupt:boolean}|null>(null);
  const lastTriggeredInterruptRef=useRef<string|null>(null);
  const consumedInterruptsRef=useRef(new Set<string>());
  const sourceGenerationRef=useRef(0);
  const playAttemptGenerationRef=useRef(0);
  const spans = useMemo(() => program?.programSpans ?? [], [program?.programSpans]);
  useEffect(()=>{autoPlayIntentRef.current=autoPlayIntent},[autoPlayIntent]);
  useEffect(()=>{fallbackRef.current=fallbackItem;},[fallbackItem]);
  const url = program?.playlistUrl || (fallbackItem?.assetUrl ?? null);
  const kind = program?.playlistUrl ? "continuous" : fallbackItem ? "clip-preview" : "empty";
  const mimetype = program?.playlistUrl ? program.mimeType : (fallbackItem?.mimeType ?? "video/mp4");
  // Hls.js refreshes the manifest in place. A new revision changes source-time
  // mappings; it must not reload/reset the continuous media element.
  const sourceSignature = `${program?.epoch ?? 0}:${program?.playlistUrl ?? ""}`;
  const sourceStartPositionRef=useRef(0);
  useImperativeHandle(seekRef,()=>({seek(seconds:number){
    manualSeekRef.current={epoch:markerEpochRef.current,programEpoch:programEpochRef.current};
    const currentPosition=videoRef.current?.currentTime??sourceStartPositionRef.current;
    for(const itemId of interruptsCrossedByForwardSeek(spans,currentPosition,seconds))consumedInterruptsRef.current.add(itemId);
    sourceStartPositionRef.current=seconds;
    pendingSeekRef.current=seekOrQueue(videoRef.current,seconds);
  }}),[spans]);
  useEffect(()=>{
    if(manualSeekRef.current&&manualSeekRef.current.programEpoch!==(program?.epoch??null))manualSeekRef.current=null;
    if(!manualSeekRef.current)sourceStartPositionRef.current=program?.playhead?.outputSeconds??0;
  },[program?.epoch,program?.playlistUrl,program?.playhead?.outputSeconds]);
  useEffect(() => {
    const media = videoRef.current;
    if (!media || !url) return;
    let mounted = true;
    const sourceGeneration=++sourceGenerationRef.current;
    resumeAfterSourceRef.current=autoPlayIntentRef.current||!media.paused;
    sourceSwitchingRef.current=resumeAfterSourceRef.current;
    const resumePlayback=()=>{
      if(!resumeAfterSourceRef.current){sourceSwitchingRef.current=false;return}
      const playAttempt=++playAttemptGenerationRef.current;
      void media.play().then(()=>{
        if(!mounted||sourceGenerationRef.current!==sourceGeneration||playAttemptGenerationRef.current!==playAttempt)return;
        resumeAfterSourceRef.current=false;sourceSwitchingRef.current=false;
      }).catch(()=>{
        if(!mounted||sourceGenerationRef.current!==sourceGeneration||playAttemptGenerationRef.current!==playAttempt)return;
        sourceSwitchingRef.current=false;
        setError("The program source changed. Press Start program to resume playback.");
        onNeedsUserStart?.();
      });
    };
    const cleanup=()=>{
      mounted=false;
      if(sourceGenerationRef.current===sourceGeneration)sourceGenerationRef.current++;
      playAttemptGenerationRef.current++;
      if(resumePlaybackRef.current===resumePlayback)resumePlaybackRef.current=null;
    };
    resumePlaybackRef.current=resumePlayback;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    media.pause();
    media.removeAttribute("src");
    media.load();
    setError(null);
    setUsingClipPreview(false);

    const fallBackToClip = (message: string) => {
      playAttemptGenerationRef.current++;
      const fallback = fallbackRef.current;
      if (fallback?.assetUrl && fallback.assetUrl !== url) {
        resumeAfterSourceRef.current=autoPlayIntentRef.current||!media.paused;
        sourceSwitchingRef.current=resumeAfterSourceRef.current;
        hlsRef.current?.destroy();
        hlsRef.current=null;
        media.pause();
        media.removeAttribute("src");
        setError(`${message} Showing the current approved clip preview; live position tracking is paused.`);
        setUsingClipPreview(true);
        media.src = fallback.assetUrl;
        media.load();
      } else {
        setError(message);
        onNeedsUserStart?.();
      }
    };

    if (mimetype.includes("mpegurl")) {
      void import("hls.js").then(({ default: Hls }) => {
        if (!mounted) return;
        const mode=hlsPlayerMode(Hls.isSupported(),Boolean(media.canPlayType(mimetype)));
        if(mode==="native"){
          media.src=url;
          media.load();
          return;
        }
        if(mode==="unsupported"){
          fallBackToClip("This browser cannot play the continuous stream.");
          return;
        }
        const hls = new Hls({
          startPosition:sourceStartPositionRef.current,
          maxBufferLength: 18,
          maxMaxBufferLength: 28,
          backBufferLength: 16,
          liveSyncDurationCount: 2,
          enableWorker: true,
        });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(media);
        hls.on(Hls.Events.MANIFEST_PARSED,()=>resumePlayback());
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (mounted && data.fatal) fallBackToClip("The continuous stream stopped loading.");
        });
      }).catch(() => {
        if(!mounted)return;
        if(media.canPlayType(mimetype)){media.src=url;media.load();}
        else fallBackToClip("The continuous-stream player could not load.");
      });
      return () => { cleanup();hlsRef.current?.destroy(); hlsRef.current = null; };
    }

    media.src = url;
    media.load();
    return cleanup;
  }, [url, mimetype, sourceSignature, onNeedsUserStart]);

  useEffect(() => {
    const media=videoRef.current;
    const marker=program?.playhead;
    if(!media||!marker||!Number.isFinite(marker.outputSeconds))return;
    const decision=controllerMarkerDecision(marker.controllerEpoch,lastPlayheadEpochRef.current,manualSeekRef.current?.epoch??null,
      manualSeekRef.current!==null,controllerClaimPending,ownedControllerEpoch);
    if(decision==="unchanged"||decision==="wait")return;
    lastPlayheadEpochRef.current=marker.controllerEpoch;
    if(decision==="ignore")return;
    manualSeekRef.current=null;
    sourceStartPositionRef.current=marker.outputSeconds;
    pendingSeekRef.current=marker.outputSeconds;
    if(media.readyState>=1){
      try{media.currentTime=marker.outputSeconds;pendingSeekRef.current=null;}catch{/* retry when HLS metadata arrives */}
    }
  },[program?.playhead,controllerClaimPending,ownedControllerEpoch]);

  if (!url || kind === "empty") {
    return <div className="output-awaiting"><div className="start-mark">◌</div><strong>Waiting for an approved scene</strong><span>The source browser will show new channel content when it is ready.</span></div>;
  }

  return <div className={`media-stage${clean ? " clean-media-stage" : ""}`}>
    <video
      ref={videoRef}
      controls={!clean}
      playsInline
      preload="metadata"
      aria-label={kind === "continuous" ? "Continuous channel program" : "Current approved clip preview"}
      onLoadedMetadata={(event)=>{
        const target=pendingSeekRef.current;
        if(target!==null){try{event.currentTarget.currentTime=target;pendingSeekRef.current=null;}catch{/* retain for the next metadata event */}}
        resumePlaybackRef.current?.();
      }}
      onPlay={() => {resumeAfterSourceRef.current=false;sourceSwitchingRef.current=false;setError(null);onStarted?.()}}
      onClick={(event)=>{
        if(!clean||event.target!==event.currentTarget)return;
        const media=event.currentTarget;
        if(media.ended||media.currentTime>=media.duration-0.25)media.currentTime=0;
        if(media.paused)void media.play().catch(()=>onNeedsUserStart?.());
        else media.pause();
      }}
      onPause={()=>{if(!sourceSwitchingRef.current)resumeAfterSourceRef.current=false}}
      onTimeUpdate={(event) => {
        if (kind !== "continuous" || !program) return;
        if (usingClipPreview) {
          if (!clean && fallbackItem?.id) onProgress?.({ itemId: fallbackItem.id, seconds: event.currentTarget.currentTime, manifestRevision: program.manifestRevision });
          return;
        }
        const position = event.currentTarget.currentTime;
        const span = spans.find((candidate) => position >= candidate.outputStartSeconds && position < candidate.outputEndSeconds);
        if(span&&shouldSkipInterruptSpan(span,consumedInterruptsRef.current)){
          const nextStory=spans.find(candidate=>candidate.kind==="story"&&candidate.outputStartSeconds>=span.outputEndSeconds-0.001);
          try{event.currentTarget.currentTime=nextStory?.outputStartSeconds??span.outputEndSeconds;}catch{/* the next timeline update retries */}
          return;
        }
        const resume=interruptResumeRef.current;
        if(resume){
          if(program.playhead&&program.playhead.controllerEpoch!==resume.controllerEpoch){interruptResumeRef.current=null;}
          else if(position>=resume.interruptEndSeconds-0.2&&resume.sawInterrupt){
            interruptResumeRef.current=null;
            consumedInterruptsRef.current.add(resume.interruptItemId);
            try{event.currentTarget.currentTime=resume.resumeSeconds;}catch{
              setError("The story could not resume after the subscriber moment. Press Start program to reconnect.");
              onNeedsUserStart?.();
            }
            return;
          }else if(span?.itemId===resume.interruptItemId){resume.sawInterrupt=true;}
        }
        if(canAutoInterrupt&&autoInterruptId&&lastTriggeredInterruptRef.current!==autoInterruptId
          &&!consumedInterruptsRef.current.has(autoInterruptId)&&!interruptResumeRef.current){
          const transition=safeInterruptTransition(spans,position,autoInterruptId);
          if(transition){
            lastTriggeredInterruptRef.current=autoInterruptId;
            interruptResumeRef.current={...transition,controllerEpoch:program.playhead?.controllerEpoch??0,sawInterrupt:false};
            try{event.currentTarget.currentTime=transition.interruptStartSeconds;}catch{
              interruptResumeRef.current=null;
              lastTriggeredInterruptRef.current=null;
            }
            return;
          }
        }
        if (!span) return;
        const itemId = span.segmentId ?? span.interruptId ?? span.itemId;
        if (!itemId) return;
        onProgress?.({
          itemId,
          seconds: (span.sourceStartSeconds ?? 0) + position - span.outputStartSeconds,
          manifestRevision: program.manifestRevision,
        });
      }}
      onEnded={() => { if (kind === "clip-preview") onEnded?.(); }}
      onError={(event) => {if(event.currentTarget.currentSrc)setError("The channel video could not be loaded. Check the approved media source.");}}
    />
    {error ? <div className="media-caption" role="status"><span>{error}</span></div> : null}
    {!clean && kind === "clip-preview" ? <div className="media-caption"><span>Clip preview — continuous HLS manifest is not currently available.</span></div> : null}
  </div>;
}
