"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ElectionChoice, PublicTimelineSegment } from "@sloptogether/contracts";
import { API_BASE, apiFetch, ApiError, displayProblem, formatDuration, type SessionSummary } from "./api";
import { Breadcrumbs, LiveBadge, PageTitle, SectionLabel, SiteFooter, SiteHeader } from "./site-shell";
import { useChannelProgram, useChannelTimeline } from "./channel-data";
import { OutputPlayer } from "./output-player";
import { ProgramPlayer } from "./program-player";

function stateText(state: PublicTimelineSegment["state"]) {
  const text: Record<PublicTimelineSegment["state"], string> = {
    open: "Open for ideas", voting: "Community vote", selected: "Selected", locked: "Locked in", ready: "Ready to play", played: "Played",
  };
  return text[state];
}

type ModerationState = "checking"|"ready"|"unavailable"|"unknown";
type ComfyGeneration={id:string;requestId:string;kind:"frame"|"prompt";state:"submitting"|"queued"|"running"|"succeeded"|"held"|"failed"|"uncertain";errorCode?:string|null;hasGeneratedText?:boolean;createdAt?:string};

async function fetchComfyFrameFile(channelSlug:string,generationId:string){
  const response=await fetch(`${API_BASE}/channels/${encodeURIComponent(channelSlug)}/comfy-generations/${encodeURIComponent(generationId)}/frame`,{credentials:"same-origin",cache:"no-store"});
  if(!response.ok){
    const payload=await response.json().catch(()=>null) as {error?:string;message?:string}|null;
    throw new ApiError(payload?.message??`Frame download failed (${response.status}).`,response.status,payload?.error);
  }
  const blob=await response.blob();
  if(blob.type!=="image/png"||blob.size<1||blob.size>16*1024*1024)throw new Error("Comfy Cloud returned an invalid start frame.");
  return new File([blob],"comfy-start-frame.png",{type:"image/png"});
}

async function fetchComfyPromptText(channelSlug:string,generationId:string){
  return apiFetch<{text:string}>(`/channels/${encodeURIComponent(channelSlug)}/comfy-generations/${encodeURIComponent(generationId)}/prompt`);
}

export function ChannelWorkspace({ channelSlug,streamSlug="main" }: { channelSlug: string;streamSlug?:string }) {
  const data = useChannelTimeline(channelSlug,streamSlug);
  const program=useChannelProgram(channelSlug,streamSlug);
  const streamApi=`/channels/${encodeURIComponent(channelSlug)}/streams/${encodeURIComponent(streamSlug)}`;
  const programReady=program.state==="ready"&&Boolean(program.value.playlistUrl);
  const channelId=data.state==="ready"?data.value.channel.twitchChannelId:null;
  const [moderationState,setModerationState] = useState<ModerationState>("checking");
  const [voted, setVoted] = useState<string | null>(null);
  const [voteNote, setVoteNote] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalNote, setProposalNote] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [endImageFile,setEndImageFile]=useState<File|null>(null);
  const [promptText,setPromptText]=useState("");
  const [canUseComfyTools,setCanUseComfyTools]=useState(false);
  const [comfyFrameEnabled,setComfyFrameEnabled]=useState(false);
  const [comfyPromptEnabled,setComfyPromptEnabled]=useState(false);
  const [comfyGenerations,setComfyGenerations]=useState<ComfyGeneration[]>([]);
  const [activeComfyId,setActiveComfyId]=useState<string|null>(null);
  const [comfyBusy,setComfyBusy]=useState(false);
  const [comfyError,setComfyError]=useState<string|null>(null);
  const [comfyNote,setComfyNote]=useState<string|null>(null);

  useEffect(()=>{
    let active=true;
    void apiFetch<{configured?:{openaiPreflight?:boolean}}>("/health")
      .then(status=>{if(active)setModerationState(status.configured?.openaiPreflight===true?"ready":"unavailable")})
      .catch(()=>{if(active)setModerationState("unknown")});
    return ()=>{active=false};
  },[]);

  useEffect(()=>{
    if(!channelId)return;
    let active=true;
    setCanUseComfyTools(false);setComfyFrameEnabled(false);setComfyPromptEnabled(false);
    void apiFetch<SessionSummary>("/auth/session").then(async session=>{
      if(!active)return;
      const authorized=Boolean(session.channels?.some(item=>item.twitchChannelId===channelId&&(item.role==="broadcaster"||item.role==="moderator")));
      setCanUseComfyTools(authorized);
      if(!authorized)return;
        const comfy=await apiFetch<{available:{frame:boolean;prompt:boolean};generations:ComfyGeneration[]}>(`/channels/${encodeURIComponent(channelSlug)}/comfy-generations`);
      if(!active)return;
      setComfyFrameEnabled(comfy.available.frame);setComfyPromptEnabled(comfy.available.prompt);
      setComfyGenerations(comfy.generations);
      const pending=comfy.generations.find(item=>["submitting","queued","running"].includes(item.state));
      if(pending)setActiveComfyId(pending.id);
    }).catch(()=>{if(active){setCanUseComfyTools(false);setComfyFrameEnabled(false);setComfyPromptEnabled(false);}});
    return()=>{active=false};
  },[channelId,channelSlug]);

  useEffect(()=>{
    if(!activeComfyId||!channelId)return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const update=(job:ComfyGeneration)=>setComfyGenerations(current=>[job,...current.filter(item=>item.id!==job.id)].slice(0,10));
    const poll=async()=>{
      try{
        const job=await apiFetch<ComfyGeneration>(`/channels/${encodeURIComponent(channelSlug)}/comfy-generations/${encodeURIComponent(activeComfyId)}`);
        if(!active)return;update(job);
        if(job.state==="succeeded"){
          try{
            if(job.kind==="frame")setImageFile(await fetchComfyFrameFile(channelSlug,job.id));
            else setPromptText((await fetchComfyPromptText(channelSlug,job.id)).text);
          }
          catch(error){
            if(error instanceof ApiError&&(error.code==="comfy_output_held"||error.code==="comfy_prompt_held"))update({...job,state:"held",errorCode:error.code});
            if(error instanceof ApiError&&error.code==="comfy_prompt_format_invalid")update({...job,state:"failed",errorCode:error.code});
            setComfyError(displayProblem(error));setActiveComfyId(null);return;
          }
          setComfyNote(job.kind==="frame"?"Frame generated and screened. Review it before submitting the scene.":"H3 prompt generated and screened. Review or edit it before submitting the scene.");setActiveComfyId(null);return;
        }
        if(["failed","held","uncertain"].includes(job.state)){
          setComfyError(job.state==="uncertain"?"Comfy Cloud may have accepted this request. It will not be resubmitted automatically.":job.errorCode==="comfy_job_cancelled"?"Comfy Cloud cancelled the job; credits already used may still be charged.":"Comfy Cloud could not produce an approved frame.");
          setActiveComfyId(null);return;
        }
      }catch(error){if(!active)return;setComfyError(displayProblem(error));}
      timer=setTimeout(()=>void poll(),3000);
    };
    void poll();return()=>{active=false;if(timer)clearTimeout(timer)};
  },[activeComfyId,channelId,channelSlug]);

  const generateComfyGeneration=async(kind:"frame"|"prompt")=>{
    if(!promptText.trim()){setComfyError("Add a scene prompt before generating a frame.");return;}
    if(!window.confirm(`This sends the prompt to Comfy Cloud and uses Comfy Cloud credits for one ${kind==="frame"?"image":"prompt"} generation. Continue?`))return;
    setComfyBusy(true);setComfyError(null);setComfyNote(null);
    try{
      const route=kind==="frame"?"comfy-frame-generations":"comfy-prompt-generations";
      const job=await apiFetch<ComfyGeneration>(`/channels/${encodeURIComponent(channelSlug)}/${route}`,{
        method:"POST",body:JSON.stringify({requestId:crypto.randomUUID(),prompt:promptText.trim()}),
      });
      setComfyGenerations(current=>[job,...current.filter(item=>item.id!==job.id)].slice(0,10));
      if(job.state==="uncertain"){setComfyError("Comfy Cloud may have accepted the request. It will not be resubmitted automatically.");return;}
      if(job.state==="failed"){setComfyError(`Comfy Cloud rejected the ${kind} request. Check the configured account and credits.`);return;}
      setActiveComfyId(job.id);setComfyNote(`Comfy Cloud ${kind} generation started. You can keep editing while it runs.`);
    }catch(error){setComfyError(displayProblem(error));}
    finally{setComfyBusy(false);}
  };

  const attachComfyGeneration=async(job:ComfyGeneration)=>{
    setComfyBusy(true);setComfyError(null);setComfyNote(null);
    try{
      if(job.kind==="frame"){
        setImageFile(await fetchComfyFrameFile(channelSlug,job.id));
        setComfyNote("Frame loaded and screened. Review it before submitting the scene.");
      }else{
        setPromptText((await fetchComfyPromptText(channelSlug,job.id)).text);
        setComfyNote("H3 prompt loaded and screened. Review or edit it before submitting the scene.");
      }
    }catch(error){
      if(error instanceof ApiError&&(error.code==="comfy_output_held"||error.code==="comfy_prompt_held"))setComfyGenerations(current=>current.map(row=>row.id===job.id?{...row,state:"held",errorCode:error.code}:row));
      if(error instanceof ApiError&&error.code==="comfy_prompt_format_invalid")setComfyGenerations(current=>current.map(row=>row.id===job.id?{...row,state:"failed",errorCode:error.code}:row));
      setComfyError(displayProblem(error));
    }finally{setComfyBusy(false)}
  };

  const cancelComfyGeneration=async(generationId:string)=>{
    if(!window.confirm("Cancel this Comfy Cloud job? Work already completed may still consume credits."))return;
    setComfyError(null);
    try{
      const job=await apiFetch<ComfyGeneration>(`/channels/${encodeURIComponent(channelSlug)}/comfy-generations/${encodeURIComponent(generationId)}/cancel`,{method:"POST",body:"{}"});
      setComfyGenerations(current=>[job,...current.filter(item=>item.id!==job.id)].slice(0,10));
      if(job.state==="failed"){setActiveComfyId(null);setComfyNote("Comfy Cloud cancellation was recorded.");}
    }catch(error){setComfyError(displayProblem(error))}
  };

  const latestComfyFrame=comfyGenerations.find(job=>job.state==="succeeded"&&job.kind==="frame");
  const latestComfyPrompt=comfyGenerations.find(job=>job.state==="succeeded"&&job.kind==="prompt");
  const activeComfyJob=comfyGenerations.find(job=>job.id===activeComfyId);
  const uncertainComfyJob=comfyGenerations.find(job=>job.state==="uncertain");
  const comfySubmitBlocked=comfyBusy||activeComfyId!==null||uncertainComfyJob!==undefined;

  const submitVote = async (electionId: string, choice: ElectionChoice) => {
    setVoted(choice.id); setVoteError(null); setVoteNote(null);
    try {
      await apiFetch(`${streamApi}/elections/${encodeURIComponent(electionId)}/ballots`, { method: "POST", body: JSON.stringify({ choiceId: choice.id }) });
      setVoteNote("Your vote was recorded. You can change it while voting is open.");
    } catch (error) {
      setVoteError(displayProblem(error));
    } finally { setVoted(null); }
  };

  const seekToScene=(segmentId:string)=>{
    if(program.state!=="ready")return;
    const span=program.value.programSpans.find(item=>item.segmentId===segmentId);
    const video=document.querySelector(".video-frame video") as HTMLVideoElement|null;
    if(!span||!video)return;
    video.currentTime=span.outputStartSeconds;
    void video.play().catch(()=>setVoteError("Press play to start the channel preview."));
  };

  const sendProposal = async (form: FormData) => {
    if(moderationState!=="ready"){
      setProposalError(moderationState==="unavailable"?"Prompt and image screening is not configured yet. Proposals are paused.":"Prompt and image screening could not be verified. Proposals are paused.");
      return;
    }
    setProposing(true); setProposalError(null); setProposalNote(null);
    try {
      const prompt = String(form.get("prompt") ?? "").trim();
      if (!prompt) throw new Error("Add a scene prompt first.");
      const planningMode=form.get("planningMode")==="planned_anchors"?"planned_anchors":"continuation";
      if(planningMode==="planned_anchors"&&!endImageFile)throw new Error("Add an end frame for planned-anchor generation.");
      const uploadFrame=async(file:File,purpose:"proposal_start_frame"|"proposal_end_frame",label:string)=>{
        if(file.size>16*1024*1024)throw new Error(`Choose a ${label} smaller than 16 MB.`);
        if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw new Error("Frames must be PNG, JPEG or WebP images.");
        const ticket = await apiFetch<{ assetId: string; uploadUrl: string; method: "PUT"; requiredHeaders?: Record<string, string>; expiresAt?: string; maxBytes?: number }>(`/channels/${encodeURIComponent(channelSlug)}/assets/upload-grant`, {
          method: "POST", body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size, purpose }),
        });
        if(ticket.maxBytes!==undefined&&file.size>ticket.maxBytes)throw new Error("This image exceeds the channel upload limit.");
        const uploaded=await fetch(ticket.uploadUrl,{method:ticket.method,body:file,headers:ticket.requiredHeaders});
        if(!uploaded.ok)throw new Error(`The ${label} upload failed. You can retry without losing the prompt.`);
        const complete=await apiFetch<{assetId:string}>(`/channels/${encodeURIComponent(channelSlug)}/assets/${encodeURIComponent(ticket.assetId)}/complete`,{method:"POST",body:"{}"});
        return complete.assetId;
      };
      const imageAssetId=imageFile?await uploadFrame(imageFile,"proposal_start_frame","start frame"):undefined;
      const endFrameAssetId=endImageFile?await uploadFrame(endImageFile,"proposal_end_frame","end frame"):undefined;
      await apiFetch(`${streamApi}/proposals`, {
        method: "POST",
        body: JSON.stringify({ prompt, imageAssetId, endFrameAssetId, planningMode }),
      });
      setProposalNote("Proposal submitted for the channel's input check and current selection rules.");
      setImageFile(null);
      setEndImageFile(null);
      setPromptText("");
      const promptInput=document.getElementById("proposal-prompt") as HTMLTextAreaElement|null;
      if(promptInput)promptInput.value="";
    } catch (error) {
      setProposalError(displayProblem(error));
    } finally { setProposing(false); }
  };

  return (
    <>
      <SiteHeader />
      <main className="shell page-main">
        <div className="workspace-heading">
          <div>
            <Breadcrumbs items={[{ label: "Channels", href: "/" }, { label: channelSlug,href:`/channels/${channelSlug}` }, { label: streamSlug }]} />
            {data.state === "ready" ? (
              <PageTitle
                eyebrow="CHANNEL STREAM"
                title={data.value.stream.displayName}
                description={`@${data.value.channel.twitchLogin}`}
                action={<LiveBadge live={programReady||data.value.playback.sourceController !== "offline"&&!!data.value.currentProgramItem} text={programReady?"PROGRAM READY":data.value.currentProgramItem?"BROWSER SOURCE READY":"WAITING FOR FIRST CLIP"} />}
              />
            ) : (
              <PageTitle eyebrow="CHANNEL STREAM" title={streamSlug} description={`@${channelSlug}`} />
            )}
          </div>
          <div className="heading-actions">
            <Link className="button secondary small" href={`/channels/${channelSlug}/streams/${streamSlug}/moderate`}>Review queue</Link>
            <Link className="button secondary small" href={`/channels/${channelSlug}/streams/${streamSlug}/output`} target="_blank" rel="noopener noreferrer">Open OBS output ↗</Link>
          </div>
        </div>

        {data.state === "loading" ? <WorkspaceSkeleton /> : null}
        {data.state === "error" ? <div className="alert error" role="status"><div><b>Channel data isn&apos;t available.</b><br />{data.error}</div><button className="button secondary small" onClick={data.retry}>Retry</button></div> : null}
        {data.state === "ready"&&data.refreshError?<div className="alert" role="status">Channel updates are delayed. Keeping the last loaded scenes.</div>:null}
        {data.state === "ready" ? <>
          <div className="workspace-grid">
            <section aria-label="Current browser source">
              <div className="video-frame">
                {program.state==="ready"&&program.value.playlistUrl?<ProgramPlayer program={program.value} fallbackItem={data.value.currentProgramItem} />:<OutputPlayer item={data.value.currentProgramItem} onPlayback={() => setPlaying(false)} />}
                {!programReady&&data.value.currentProgramItem && !playing ? (
                  <div className="center-play">
                    <button className="hero-play" aria-label="Start video playback" onClick={() => { const video = document.querySelector(".video-frame video") as HTMLVideoElement | null; if (video) void video.play().then(() => setPlaying(true)).catch(() => setVoteError("Press the play control to start browser audio/video.")); }}>▶</button>
                  </div>
                ) : null}
              </div>
              <div className="video-meta">
                <span className="program-tag">{data.value.currentProgramItem?.kind === "subscriber_interrupt" ? "✦ Subscriber interstitial" : "◉ Current story"}</span>
                <span>16:9 · OBS Window Capture</span>
                <Link href={`/channels/${channelSlug}/streams/${streamSlug}/output`} target="_blank" rel="noopener noreferrer" className="subtle-link">Open clean output ↗</Link>
                {data.value.currentProgramItem?.upscaleUrl?<a href={data.value.currentProgramItem.upscaleUrl} target="_blank" rel="noopener noreferrer" className="subtle-link">Open approved upscale ↗</a>:null}
              </div>
              <div className="timeline-heading">
                <div><SectionLabel suffix={<span className="tiny-count">{data.value.segments.length} SCENES</span>}>UP NEXT</SectionLabel><h2>Scenes in this stream</h2></div>
                <Link href={`/channels/${channelSlug}/streams/${streamSlug}/output`} className="subtle-link mono">OPEN SOURCE ↗</Link>
              </div>
              {data.value.segments.length ? <ol className="scene-list">
                {data.value.segments.map((segment, index) => <li className={`scene-card${data.value.currentProgramItem?.segmentId === segment.id ? " scene-current" : ""}`} key={segment.id}>
                  <span className="scene-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className={`scene-art scene-art-${index % 4}`}>{segment.kind === "subscriber_interrupt" ? "✦" : "◈"}</span>
                  <span className="scene-description"><strong>{segment.promptPreview || "Scene prompt awaiting review"}</strong><small>{segment.kind === "subscriber_interrupt" ? "COMMUNITY MOMENT" : "STORY SCENE"} · {formatDuration(segment.durationSeconds)}</small>{segment.upscaleUrl?<a href={segment.upscaleUrl} target="_blank" rel="noopener noreferrer" className="subtle-link">Open approved upscale ↗</a>:null}</span>
                  <span className={`scene-status scene-status-${segment.state}`}><span>{stateText(segment.state)}</span>{programReady&&segment.programItemId?<button type="button" aria-label={`Play scene ${index+1}`} onClick={()=>seekToScene(segment.id)}>▶</button>:null}</span>
                </li>)}
              </ol> : <div className="empty-state"><div className="empty-glyph">✦</div><strong>No scenes yet.</strong><p>Submit a prompt or frame below, or open the Extension while watching this channel.</p></div>}
            </section>

            <aside className="side-stack" aria-label="Channel participation">
              {data.value.elections?.filter((election) => election.state === "open").map((election) => <div className="panel" key={election.id}>
                <SectionLabel suffix={<span className="vote-window">OPEN</span>}>CHANNEL ELECTION</SectionLabel>
                <h2>Vote on the next scene</h2>
                <p className="panel-copy">One ballot per Twitch account. Change it in chat, on the site, or in the Extension.</p>
                <div className="choice-list">{election.choices.map((choice) => <button className="choice-row" key={choice.id} aria-pressed={election.myChoiceId === choice.id} disabled={voted !== null} onClick={() => void submitVote(election.id, choice)}>
                  <span>{choice.title}</span><span className="choice-count">{voted === choice.id ? "…" : choice.votes} <span aria-hidden="true">◉</span></span>
                </button>)}</div>
                {voteError ? <p className="inline-error" role="status">{voteError}</p> : null}
                {voteNote ? <p className="inline-success" role="status">{voteNote}</p> : null}
                <p className="inline-help">Votes are free. A selected idea still passes the channel&apos;s review rules.</p>
              </div>)}
              {!data.value.elections?.some((election) => election.state === "open") ? <div className="panel"><SectionLabel>COMMUNITY VOTE</SectionLabel><h2>Nothing is up for a vote yet.</h2><p className="panel-copy">When an eligible scene is ready, Extension, chat and site ballots show the same stream election.</p><div className="command-line"><code>!slop vote &lt;choice&gt;</code><span>CHAT</span></div><Link className="text-link" href={`/channels/${channelSlug}/streams/${streamSlug}/moderate`}>Check the review queue <span>↗</span></Link></div> : null}

              <form className="panel proposal-card" onSubmit={(event) => { event.preventDefault(); void sendProposal(new FormData(event.currentTarget)); }}>
                <SectionLabel suffix={<span className="free-pill">{moderationState==="ready"?"FREE TO PROPOSE":"SUBMISSIONS PAUSED"}</span>}>YOUR IDEA</SectionLabel>
                <h2>Propose a scene</h2>
                <p className="panel-copy" role="status" aria-live="polite">{moderationState==="ready"?"Your prompt and frame get a quick input check before voting or rendering.":moderationState==="unavailable"?"Prompt and image screening is not configured yet, so proposals cannot be accepted.":moderationState==="checking"?"Checking prompt and image screening availability…":"Screening status could not be verified, so proposals are paused."}</p>
                <label className="field-label" htmlFor="proposal-prompt">Scene prompt</label>
                <textarea id="proposal-prompt" name="prompt" className="prompt-input" rows={4} minLength={1} maxLength={1000} placeholder="Describe the scene you want the community to vote on." value={promptText} onChange={event=>setPromptText(event.currentTarget.value)} required />
                <div className="prompt-meta"><span>Keep it visual and kind</span><span>1,000 characters max</span></div>
                <label className="field-label" htmlFor="proposal-planning">How should this scene connect?</label>
                <select id="proposal-planning" name="planningMode" className="select-input" defaultValue="continuation">
                  <option value="continuation">Continue from the previous ending</option>
                  <option value="planned_anchors">Choose start and end frame anchors</option>
                </select>
                <label className="file-input-row" htmlFor="proposal-frame"><span className="file-icon">＋</span><span><b>{imageFile?.name ?? "Add a start frame"}</b><small>Optional · PNG, JPEG or WebP · up to 16 MB</small></span></label>
                <input id="proposal-frame" type="file" className="visually-hidden" accept="image/png,image/jpeg,image/webp" onChange={(event) => setImageFile(event.currentTarget.files?.[0] ?? null)} />
                {canUseComfyTools?<div className="comfy-frame-tool">
                  <SectionLabel>OPTIONAL COMFY CLOUD TOOLS</SectionLabel>
                  {comfyPromptEnabled?<><p className="panel-copy">Generate an H3 scene prompt with Comfy Cloud credits.</p><button className="button secondary full-button" type="button" onClick={()=>void generateComfyGeneration("prompt")} disabled={comfySubmitBlocked}>{activeComfyJob?.kind==="prompt"?"Writing H3 prompt…":"Generate H3 prompt with Comfy Cloud"}</button></>:null}
                  {comfyFrameEnabled?<><p className="panel-copy">Generate a 448×256 start frame. Each request uses Comfy credits and requires confirmation.</p><button className="button secondary full-button" type="button" onClick={()=>void generateComfyGeneration("frame")} disabled={comfySubmitBlocked}>{activeComfyJob?.kind==="frame"?"Generating start frame…":"Generate start frame with Comfy Cloud"}</button></>:null}
                  {!comfyPromptEnabled&&!comfyFrameEnabled?<p className="fine-print">Comfy Cloud generation is disabled for this deployment.</p>:null}
                  {activeComfyId?<button className="text-link" type="button" onClick={()=>void cancelComfyGeneration(activeComfyId)}>Cancel Comfy Cloud job</button>:null}
                  {uncertainComfyJob?<p className="inline-error" role="alert">Comfy Cloud may have accepted a job. Check the owner account before requesting another; this app will not resubmit it automatically.</p>:null}
                  {latestComfyFrame?<button className="text-link" type="button" disabled={comfyBusy} onClick={()=>void attachComfyGeneration(latestComfyFrame)}>Load latest screened Comfy frame</button>:null}
                  {latestComfyPrompt?<button className="text-link" type="button" disabled={comfyBusy} onClick={()=>void attachComfyGeneration(latestComfyPrompt)}>Load latest screened H3 prompt</button>:null}
                  {comfyError?<p className="inline-error" role="alert">{comfyError}</p>:null}{comfyNote?<p className="inline-success" role="status">{comfyNote}</p>:null}
                </div>:null}
                <label className="file-input-row" htmlFor="proposal-end-frame"><span className="file-icon">＋</span><span><b>{endImageFile?.name??"Add an end frame"}</b><small>Required for planned anchors · the next clip starts here</small></span></label>
                <input id="proposal-end-frame" type="file" className="visually-hidden" accept="image/png,image/jpeg,image/webp" onChange={(event)=>setEndImageFile(event.currentTarget.files?.[0]??null)} />
                {proposalError ? <p className="inline-error" role="alert">{proposalError}</p> : null}
                {proposalNote ? <p className="inline-success" role="status">{proposalNote}</p> : null}
                <button className="button full-button" type="submit" disabled={proposing||moderationState!=="ready"}>{proposing ? "Checking and sending…" : "Submit scene idea"}<span aria-hidden="true">→</span></button>
                <p className="fine-print">Posting is not a billable render. A verified payment authorizes one generation attempt only.</p>
              </form>

              <div className="panel support-card">
                <div className="support-orbit" aria-hidden="true">✦</div>
                <SectionLabel>MORE WAYS TO JOIN</SectionLabel>
                <h2>Volunteer GPU tasks aren’t open yet.</h2>
                <p className="panel-copy">Fal runners are private; the Windows worker client is not published.</p>
                <Link href="/downloads" className="text-link">Check worker release status <span>↗</span></Link>
              </div>
            </aside>
          </div>
          <div className="page-lower-note"><span className="tiny-dot"/> Current media is screened, validated, and approved under this channel&apos;s policy.</div>
        </> : null}
      </main>
      <SiteFooter />
    </>
  );
}

function WorkspaceSkeleton() {
  return <div className="workspace-grid workspace-skeleton"><div className="skeleton-player"><div/><span>Connecting to the channel…</span></div><aside className="panel"><div className="loading-pulse"/><div className="loading-pulse short"/><div className="loading-pulse"/></aside></div>;
}
