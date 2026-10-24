"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { apiFetch, displayProblem, type SessionSummary } from "./api";
import { Breadcrumbs, PageTitle, SectionLabel } from "./site-shell";

interface PairSession extends SessionSummary { channels?:Array<{twitchChannelId:string;login:string;displayName:string;role:"broadcaster"|"moderator"}> }

export function WorkerPairing({pairingId}:{pairingId:string}){
  const [session,setSession]=useState<PairSession|null>(null);
  const [code,setCode]=useState("");
  const [channel,setChannel]=useState("");
  const [error,setError]=useState<string|null>(null);
  const [done,setDone]=useState(false);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void apiFetch<PairSession>("/auth/session").then(value=>{if(active){setSession(value);setChannel(value.channels?.[0]?.twitchChannelId??"")}}).catch(problem=>{if(active)setError(displayProblem(problem))});return()=>{active=false}},[]);
  const approve=async(event:FormEvent)=>{
    event.preventDefault();setBusy(true);setError(null);
    try{await apiFetch(`/workers/pairings/${encodeURIComponent(pairingId)}/approve`,{method:"POST",body:JSON.stringify({code:code.replace(/\s/g,""),channelId:channel})});setDone(true)}
    catch(problem){setError(displayProblem(problem))}finally{setBusy(false)}
  };
  return <main className="shell control-section"><div className="page-top"><Breadcrumbs items={[{label:"Home",href:"/"},{label:"Windows worker",href:"/downloads"},{label:"Connect worker"}]}/></div><PageTitle eyebrow="DEVICE PAIRING" title="Connect this worker." description="Approve the one-time code shown by the worker on your own device. The worker receives a channel-scoped key only after you approve it."/>
    {done?<div className="panel"><SectionLabel>PAIRING APPROVED</SectionLabel><h2>Return to the worker.</h2><p className="panel-copy">The worker will receive a Twitch-linked, channel-scoped key. Its jobs remain subject to channel policy.</p></div>:!pairingId?<div className="alert error">This pairing link is incomplete. Restart pairing from the worker.</div>:!session?.authenticated?<section className="panel"><SectionLabel>TWITCH SIGN-IN</SectionLabel><h2>Sign in with the Twitch account running this worker.</h2><p className="panel-copy">Your channel must allow your account to contribute. Bans and revoked worker keys take effect immediately.</p>{error?<p className="inline-error">{error}</p>:null}<a className="button" href={`/sloptogether/api/v1/auth/twitch/start?return_to=${encodeURIComponent(`/sloptogether/worker-pairing?pair=${pairingId}`)}`}>Continue with Twitch ↗</a></section>:<form className="panel settings-stack" onSubmit={(event)=>void approve(event)}><SectionLabel>LINK THIS DEVICE</SectionLabel><h2>Check the pairing code.</h2><label className="field"><span>One-time code from the worker</span><input className="text-input" value={code} onChange={event=>setCode(event.target.value.toUpperCase())} autoComplete="one-time-code" maxLength={12} required/></label><label className="field"><span>Channel to contribute to</span><input className="text-input" list="pair-channel-list" value={channel} onChange={event=>setChannel(event.target.value)} placeholder="Twitch login or channel ID" required/><datalist id="pair-channel-list">{session.channels?.map(item=><option key={item.twitchChannelId} value={item.twitchChannelId}>{item.displayName} · {item.role}</option>)}</datalist></label><p className="fine-print">Only generation or upscale roles requested by this worker are granted. Story producer and streamer-control access are issued separately by the broadcaster.</p>{error?<p className="inline-error" role="alert">{error}</p>:null}<button className="button" disabled={busy||!channel}>{busy?"Linking…":"Link worker to Twitch"}</button></form>}
  </main>;
}
