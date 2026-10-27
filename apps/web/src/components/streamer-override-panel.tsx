"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { apiFetch } from "./api";
import { useChannelTimeline } from "./channel-data";

type OverrideAction = "replace_future_prompt" | "replace_future_boundary" | "select_proposal" | "hold" | "resume" | "unlock_future";
interface OverrideCandidate { proposalId:string;segmentRevisionId:string;startBoundaryRevisionId:string;startFrameAssetId:string;electionId:string;title:string;votes:number;state:string }

export function StreamerOverridePanel({ channel }: { channel: string }) {
  const timeline = useChannelTimeline(channel);
  const [segmentId,setSegmentId]=useState("");
  const [action,setAction]=useState<OverrideAction>("replace_future_prompt");
  const [proposalId,setProposalId]=useState("");
  const [candidateSet,setCandidateSet]=useState<{segmentId:string;candidates:OverrideCandidate[]}|null>(null);
  const [candidatesLoading,setCandidatesLoading]=useState(false);
  const [seekSegmentId,setSeekSegmentId]=useState("");
  const [upscaleSegmentId,setUpscaleSegmentId]=useState("");
  const [seekSeconds,setSeekSeconds]=useState(0);
  const [prompt,setPrompt]=useState("");
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [upscaling,setUpscaling]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);

  const currentValue=timeline.state==="ready"?timeline.value:null;
  const availableFuture=currentValue?.segments.filter(segment=>segment.state!=="played")??[];
  const candidateSegmentId=availableFuture.find(segment=>segment.id===(segmentId||availableFuture[0]?.id))?.id??availableFuture[0]?.id??"";
  const candidates=candidateSet?.segmentId===candidateSegmentId?candidateSet.candidates:[];
  useEffect(()=>{
    if(!candidateSegmentId)return;
    let active=true;
    const load=async()=>{
      setCandidatesLoading(true);
      try{
        const result=await apiFetch<{candidates:OverrideCandidate[]}>(`/channels/${encodeURIComponent(channel)}/timeline/override-candidates?segmentId=${encodeURIComponent(candidateSegmentId)}`);
        if(active){setCandidateSet({segmentId:candidateSegmentId,candidates:result.candidates});setProposalId(current=>result.candidates.some(item=>item.proposalId===current)?current:result.candidates[0]?.proposalId??"")}
      }catch{if(active)setCandidateSet({segmentId:candidateSegmentId,candidates:[]})}
      finally{if(active)setCandidatesLoading(false)}
    };
    void load();
    const timer=window.setInterval(()=>{if(!document.hidden)void load()},12000);
    return()=>{active=false;window.clearInterval(timer)};
  },[channel,candidateSegmentId]);

  if(timeline.state!=="ready")return <aside className="panel streamer-panel"><div className="section-label">STREAMER CONTROL</div><h2>Full channel authority</h2><p className="panel-copy">{timeline.state==="loading"?"Loading the current timeline…":"The current timeline isn't available. You can still use other channel settings."}</p></aside>;
  const value=timeline.value;
  const future=availableFuture;
  const selected=future.find(segment=>segment.id===(segmentId||future[0]?.id))??future[0];
  const selectedChoice=candidates.find(candidate=>candidate.proposalId===proposalId)??candidates[0];
  const seekable=value.segments.filter(segment=>segment.programItemId&&(segment.state==="ready"||segment.state==="played"));
  const seekTarget=seekable.find(segment=>segment.id===(seekSegmentId||value.currentProgramItem?.segmentId||seekable.at(-1)?.id))??seekable.at(-1);
  const upscaleTarget=seekable.find(segment=>segment.id===(upscaleSegmentId||value.currentProgramItem?.segmentId||seekable.at(-1)?.id))??seekable.at(-1);

  const send=async(payload:Record<string,unknown>,success:string)=>{
    setBusy(true);setError(null);setMessage(null);
    try{
      await apiFetch(`/channels/${encodeURIComponent(channel)}/timeline/overrides`,{method:"POST",body:JSON.stringify({...payload,expectedTimelineRevision:value.revision??1,reason:reason.trim(),idempotencyKey:crypto.randomUUID()})});
      setMessage(success);
      setPrompt("");
    }catch(problem){setError(problem instanceof Error?problem.message:"The override couldn't be applied.");}
    finally{setBusy(false);}
  };

  const force=async()=>{
    if(!selected)return;
    const payload:Record<string,unknown>={action,targetSegmentId:selected.id};
    if(action==="replace_future_prompt")payload.prompt=prompt.trim();
    if(action==="select_proposal")payload.proposalId=selectedChoice?.proposalId;
    if(action==="replace_future_boundary")payload.boundaryRevisionId=selectedChoice?.startBoundaryRevisionId;
    const success=action==="select_proposal"?"The selected proposal is now the channel choice; its worker job was scheduled if eligible."
      :action==="replace_future_boundary"?"The reviewed start frame was screened and selected for a new render."
      :"Override recorded. Older work is fenced from restoring this choice.";
    await send(payload,success);
  };

  const seek=async()=>{
    if(!seekTarget)return;
    await send({action:"seek_program_item",itemId:seekTarget.programItemId,offsetSeconds:seekSeconds},"The browser output is seeking to the selected scene.");
  };

  const skip=async()=>{
    if(!value.currentProgramItem)return;
    await send({action:"skip_program_item",itemId:value.currentProgramItem.id},"The browser output is skipping to the next committed scene.");
  };

  const requestUpscale=async()=>{
    if(!upscaleTarget?.programItemId)return;
    setUpscaling(true);setError(null);setMessage(null);
    try{
      const result=await apiFetch<{existing:boolean}>(`/channels/${encodeURIComponent(channel)}/upscale`,{method:"POST",body:JSON.stringify({programItemId:upscaleTarget.programItemId})});
      setMessage(result.existing?"An upscale request already exists for this scene.":"Upscale queued for review.");
    }catch(problem){setError(problem instanceof Error?problem.message:"The upscale couldn't be queued.");}
    finally{setUpscaling(false);}
  };

  const seekMaximum=Math.max(0,seekTarget?.durationSeconds??0);

  return <aside className="panel streamer-panel">
    <div className="streamer-panel-orbit" aria-hidden="true">✦</div>
    <div className="section-label">STREAMER CONTROL</div>
    <h2>Take the wheel.</h2>
    <p className="panel-copy">Choose a reviewed proposal, replace future prompts, pause or resume a scene, and seek the browser output. Your verified streamer identity or full-control key is checked by the server.</p>
    <label className="field-label" htmlFor="override-reason">Audit reason</label>
    <input id="override-reason" className="text-input" value={reason} maxLength={500} onChange={event=>setReason(event.target.value)} placeholder="Why is the timeline changing?" required/>
    {future.length? <>
      <label className="field-label" htmlFor="override-segment">Future scene</label>
      <select id="override-segment" className="select-input" value={selected?.id??""} onChange={event=>{setSegmentId(event.target.value);setProposalId("")}}>{future.map(segment=><option value={segment.id} key={segment.id}>Scene {segment.ordinal+1} · {segment.promptPreview||segment.state}</option>)}</select>
      <label className="field-label" htmlFor="override-action">Override</label>
      <select id="override-action" className="select-input" value={action} onChange={event=>setAction(event.target.value as OverrideAction)}>
        <option value="replace_future_prompt">Replace the future prompt</option>
        <option value="replace_future_boundary">Replace the future start frame</option>
        <option value="select_proposal">Select a reviewed proposal</option>
        <option value="hold">Hold work for this scene</option>
        <option value="resume">Resume this scene</option>
        <option value="unlock_future">Unlock this future scene</option>
      </select>
      {action==="replace_future_prompt"?<><label className="field-label" htmlFor="override-prompt">New prompt</label><textarea id="override-prompt" className="prompt-input" rows={3} maxLength={1200} value={prompt} onChange={event=>setPrompt(event.target.value)} placeholder="Describe the next future scene…" required/></>:null}
      {action==="select_proposal"||action==="replace_future_boundary"?<><label className="field-label" htmlFor="override-proposal">{action==="select_proposal"?"Reviewed proposal":"Reviewed start frame"}</label><select id="override-proposal" className="select-input" value={selectedChoice?.proposalId??""} onChange={event=>setProposalId(event.target.value)} disabled={!candidates.length}><option value="">{candidatesLoading?"Loading proposals…":candidates.length?"Choose a proposal":"No eligible reviewed start frames for this scene"}</option>{candidates.map(choice=><option key={choice.proposalId} value={choice.proposalId}>{choice.title} · {choice.votes} votes</option>)}</select>{selectedChoice?<Image src={`/sloptogether/api/v1/media/${encodeURIComponent(selectedChoice.startFrameAssetId)}/preview`} alt={`Reviewed start frame for ${selectedChoice.title}`} width={480} height={270} unoptimized style={{width:"100%",height:"auto",borderRadius:12}}/>:null}</>:null}
      <button className="button full-button" disabled={busy||!reason.trim()||(action==="replace_future_prompt"&&!prompt.trim())||((action==="select_proposal"||action==="replace_future_boundary")&&!selectedChoice)} onClick={()=>void force()}>{busy?"Applying…":"Apply streamer override"}</button>
    </>:<div className="empty-state"><strong>No future segments yet.</strong><p>Create the first scene or let the story feed prepare upcoming content.</p></div>}

    <hr className="panel-divider"/>
    <div className="section-label">BROWSER OUTPUT</div>
    <h3>Optional clip upscale</h3>
    {seekable.length?<><label className="field-label" htmlFor="upscale-scene">Clip</label>
      <select id="upscale-scene" className="select-input" value={upscaleTarget?.id??""} onChange={event=>setUpscaleSegmentId(event.target.value)}>{seekable.map(segment=><option key={segment.id} value={segment.id}>Scene {segment.ordinal+1} · {segment.promptPreview||segment.state}</option>)}</select>
    </>:null}
    <button className="button secondary small" disabled={upscaling||!upscaleTarget?.programItemId} onClick={()=>void requestUpscale()}>{upscaling?"Queueing…":"Request upscale"}</button>
    <h3>Jump to a scene</h3>
    {seekable.length?<>
      <label className="field-label" htmlFor="seek-scene">Committed scene</label>
      <select id="seek-scene" className="select-input" value={seekTarget?.id??""} onChange={event=>{setSeekSegmentId(event.target.value);setSeekSeconds(0)}}>{seekable.map(segment=><option key={segment.id} value={segment.id}>Scene {segment.ordinal+1} · {segment.promptPreview||segment.state}</option>)}</select>
      <label className="field-label" htmlFor="seek-position">Position in clip: {seekSeconds.toFixed(1)}s</label>
      <input id="seek-position" className="text-input" type="range" min={0} max={seekMaximum} step={0.1} value={Math.min(seekSeconds,seekMaximum)} onChange={event=>setSeekSeconds(Number(event.target.value))} disabled={!seekMaximum}/>
      <button className="button secondary small" disabled={busy||!reason.trim()||!seekTarget} onClick={()=>void seek()}>Seek browser output</button>
    </>:<p className="panel-copy">No committed scenes are available to seek yet.</p>}
    <button className="button ghost small" disabled={busy||!reason.trim()||!value.currentProgramItem} onClick={()=>void skip()}>Skip current scene</button>
    {error?<p className="inline-error" role="alert">{error}</p>:null}
    {message?<p className="inline-success" role="status">{message}</p>:null}
    <p className="streamer-authority-note">Overrides replace future revisions atomically. Already aired story history remains immutable.</p>
  </aside>;
}
