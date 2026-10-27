"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, displayProblem, type SessionSummary } from "./api";
import { PageTitle, SiteFooter, SiteHeader } from "./site-shell";

type Stream = { id:string;slug:string;displayName:string;isDefault:boolean;createdAt:string|null };

export function ChannelStreams({channelSlug,channelName,initialStreams}:{channelSlug:string;channelName:string;initialStreams:Stream[]}){
  const [streams,setStreams]=useState(initialStreams);
  const [canCreate,setCanCreate]=useState(false);
  const [displayName,setDisplayName]=useState("");
  const [slug,setSlug]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);

  useEffect(()=>{
    let active=true;
    void apiFetch<SessionSummary>("/auth/session").then(session=>{
      if(active)setCanCreate(Boolean(session.channels?.some(item=>item.login.toLowerCase()===channelSlug.toLowerCase()&&item.role==="broadcaster")));
    }).catch(()=>{if(active)setCanCreate(false)});
    return()=>{active=false};
  },[channelSlug]);

  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();setBusy(true);setError(null);
    try{
      const stream=await apiFetch<Stream>(`/channels/${encodeURIComponent(channelSlug)}/streams`,{method:"POST",body:JSON.stringify({displayName,slug})});
      setStreams(current=>[...current,stream]);setDisplayName("");setSlug("");
    }catch(problem){setError(displayProblem(problem));}
    finally{setBusy(false)}
  };

  return <><SiteHeader/><main className="shell page-main">
    <div className="page-top"><Link className="subtle-link" href="/">Channels</Link></div>
    <PageTitle eyebrow="CHANNEL STREAMS" title={channelName} description="Choose a stream."/>
    <section className="panel-list" aria-label="Streams">
      {streams.map(stream=><article className="panel" key={stream.id}>
        <div className="panel-label">{stream.isDefault?"DEFAULT STREAM":"STREAM"}</div>
        <h2>{stream.displayName}</h2>
        <div className="stat-row">
          <Link className="button" href={`/channels/${encodeURIComponent(channelSlug)}/streams/${encodeURIComponent(stream.slug)}/output`}>Watch</Link>
          <Link className="button secondary" href={`/channels/${encodeURIComponent(channelSlug)}/streams/${encodeURIComponent(stream.slug)}/participate`}>Vote</Link>
          <Link className="subtle-link" href={`/channels/${encodeURIComponent(channelSlug)}/streams/${encodeURIComponent(stream.slug)}`}>Stream page ↗</Link>
        </div>
      </article>)}
    </section>
    {canCreate&&<section className="panel" aria-labelledby="new-stream-title">
      <div className="panel-label">CHANNEL CONTROL</div><h2 id="new-stream-title">New stream</h2>
      <form className="form-grid" onSubmit={submit}>
        <label className="field"><span>Name</span><input required maxLength={80} value={displayName} onChange={event=>setDisplayName(event.target.value)}/></label>
        <label className="field"><span>URL slug</span><input required maxLength={48} pattern="[a-z0-9][a-z0-9-]*" value={slug} onChange={event=>setSlug(event.target.value.toLowerCase())}/></label>
        <button className="button" disabled={busy||!displayName.trim()||!slug.trim()}>{busy?"Creating…":"Create stream"}</button>
        {error&&<p className="alert error" role="alert">{error}</p>}
      </form>
    </section>}
  </main><SiteFooter compact/></>;
}
