"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { API_BASE, displayProblem } from "./api";

interface ChannelCardData { twitchLogin: string; displayName: string; segmentCount?: number; currentPrompt?: string }

export function ChannelDirectory() {
  const [channels, setChannels] = useState<ChannelCardData[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query ? channels.filter((channel) => `${channel.displayName} ${channel.twitchLogin}`.toLocaleLowerCase().includes(query)) : channels;
  }, [channels, filter]);

  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${API_BASE}/channels`, { cache: "no-store", credentials: "same-origin", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Channel directory unavailable (${response.status}).`);
        return response.json() as Promise<{ channels?: ChannelCardData[] }>;
      })
      .then((data) => { setChannels(Array.isArray(data.channels) ? data.channels : []); setState("ready"); })
      .catch((problem) => {
        if (problem instanceof DOMException && problem.name === "AbortError") return;
        setError(displayProblem(problem)); setState("error");
      });
    return () => abort.abort();
  }, []);

  return (
    <div className="directory-section" id="channels">
      <div className="directory-heading">
        <div><span className="eyebrow">LIVE CHANNELS</span><h2>Your channels</h2><p>Watch, vote, contribute.</p></div>
        {state === "ready" && channels.length > 0 ? (
          <label className="search-wrap"><span className="visually-hidden">Find a channel</span><span className="search-icon">⌕</span><input className="search-box" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="Find a channel" /></label>
        ) : null}
      </div>
      {state === "loading" ? <div className="directory-grid" aria-label="Loading channels">{[0, 1, 2].map((i) => <div className="channel-discovery-card discovery-loading" key={i}><div className="loading-pulse"/><div className="loading-pulse short"/><div className="loading-pulse"/></div>)}</div> : null}
      {state === "error" ? <div className="empty-state directory-empty"><span className="empty-glyph">⌁</span><strong>Channels aren&apos;t available yet.</strong><p>{error}</p><a className="button secondary small" href="#how-it-works">See how it works</a></div> : null}
      {state === "ready" && channels.length === 0 ? <div className="empty-state directory-empty"><strong>No channels yet.</strong><Link className="button secondary small" href="/control">Connect Twitch <span aria-hidden="true">↗</span></Link></div> : null}
      {state === "ready" && channels.length > 0 && filtered.length === 0 ? <div className="empty-state directory-empty"><strong>No matching channels.</strong><p>Try another Twitch name.</p></div> : null}
      {state === "ready" && filtered.length > 0 ? <div className="directory-grid">
        {filtered.map((channel) => <Link className="channel-discovery-card" key={channel.twitchLogin} href={`/channels/${encodeURIComponent(channel.twitchLogin)}`}>
          <div className="channel-card-top"><span className="channel-orbit">{channel.displayName.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="source-state"><i/> CHANNEL PROGRAM</span></div>
          <h3>{channel.displayName}</h3><span className="channel-at">@{channel.twitchLogin}</span>
          {channel.currentPrompt ? <p className="channel-preview">{channel.currentPrompt}</p> : <p className="channel-preview">Open channel</p>}
          <div className="channel-card-footer"><span>{typeof channel.segmentCount === "number" ? `${channel.segmentCount} scene${channel.segmentCount === 1 ? "" : "s"}` : "Community story"}</span><span className="arrow">↗</span></div>
        </Link>)}
      </div> : null}
    </div>
  );
}
