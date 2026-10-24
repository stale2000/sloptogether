"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_BASE, displayProblem } from "./api";
import { Breadcrumbs, SectionLabel } from "./site-shell";

type WorkerRelease =
  | { available:false; reason:string }
  | { available:true; version:string; downloadUrl:string; sha256:string; releasedAt:string; qualifiedGpus:string[]; roles:Array<"generation"|"upscale">; windowsBuild:string; notes:string[] };

export function WorkerDownloads(){
  const [release,setRelease]=useState<WorkerRelease|null>(null);
  const [checking,setChecking]=useState(true);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;void fetch(`${API_BASE}/worker/releases/windows`,{cache:"no-store"}).then(async response=>{if(!response.ok)throw new Error(`Release catalog unavailable (${response.status}).`);return response.json() as Promise<WorkerRelease>}).then(row=>{if(active)setRelease(row)}).catch(cause=>{if(active)setError(displayProblem(cause))}).finally(()=>{if(active)setChecking(false)});return()=>{active=false}},[]);
  return <>
    <div className="page-top"><Breadcrumbs items={[{label:"Home",href:"/"},{label:"Windows worker"}]}/></div>
    <section className="download-hero"><div className="eyebrow">SLOPTOGETHER WORKER · WINDOWS</div><h1>The Windows worker<br/>is still being <em>qualified.</em></h1><p>The shared worker has two planned GPU roles. A signed installer will appear here after generation, upscaling and the supported hardware profiles pass qualification.</p><div className="download-capabilities"><span>Planned: TrimH3 generation</span><span>Planned: H3 upscale</span><span>Twitch-linked jobs</span></div></section>
    <div className="download-layout">
      <section className="panel release-panel"><SectionLabel suffix={<span className="source-state">WINDOWS X64</span>}>WORKER RELEASE</SectionLabel><h2>{release?.available?`Version ${release.version}` : "Release isn't ready yet"}</h2>
        {checking?<><p className="panel-copy">Checking the worker release catalog…</p><div className="loading-pulse"/></>:release?.available?<><p className="panel-copy">Review the published build, hash and measured GPU qualifications before installing.</p><div className="release-roles">{release.roles.map(role=><span className="role-chip" key={role}>{role==="generation"?"Generation":"Upscaling"}</span>)}</div><dl className="release-metadata"><div><dt>Build</dt><dd>{release.windowsBuild}</dd></div><div><dt>Qualified GPUs</dt><dd>{release.qualifiedGpus.join(", ")||"None listed"}</dd></div><div><dt>Released</dt><dd>{new Date(release.releasedAt).toLocaleDateString()}</dd></div><div><dt>SHA-256</dt><dd><code>{release.sha256}</code></dd></div></dl>{release.notes.map(note=><p className="release-note" key={note}>· {note}</p>)}<a className="button" href={release.downloadUrl} rel="nofollow">Download Windows worker <span>↓</span></a></>:<><div className="alert">{error??(release?.reason==="worker_release_not_published"?"No signed Windows worker release has been published yet.":"The public Windows worker package is not available.")}</div><p className="panel-copy">A signed Windows build has not been qualified or published. The source nodes alone are not a safe public installer.</p><button className="button secondary" disabled>Download worker</button></>}
      </section>
      <aside className="panel"><SectionLabel>PLANNED WORKER SAFEGUARDS</SectionLabel><h2>Your GPU stays yours.</h2><p className="panel-copy">Published builds will require your approval, pair your Twitch account to worker jobs, and upload outputs through expiring, job-scoped tickets.</p><ul className="download-list"><li>Choose generation or upscale when each role is qualified.</li><li>Review model downloads, disk space and resource limits.</li><li>Pause a running worker; banned or revoked devices cannot claim more work.</li><li>Public uploads follow the channel&apos;s approval settings.</li></ul><Link className="text-link" href="/control">Manage a channel&apos;s worker access ↗</Link></aside>
    </div>
    <div className="download-gpu-note"><span className="note-glyph">◈</span><span><b>RTX4090 is a target, not an assumed capability.</b> Current node imports don&apos;t qualify Windows memory use. The release catalog must report each generation/upscale profile after real hardware measurements.</span></div>
  </>;
}
