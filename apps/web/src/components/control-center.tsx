"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { type InterruptSettings, type WorkerKeyScope, workerKeyScopes } from "@sloptogether/contracts";
import { ApiError, apiFetch, displayProblem, type SessionSummary } from "./api";
import { Breadcrumbs, PageTitle, SectionLabel } from "./site-shell";
import { StoryBatchControl } from "./story-batch-control";

interface ChannelLink { twitchChannelId: string; login: string; displayName: string; role: "broadcaster" | "moderator"; contributionMode?: string }
interface SessionResponse extends SessionSummary { channels?: ChannelLink[] }
interface KeyResponse { keyId: string; secret: string; displayName: string; scopes: WorkerKeyScope[]; expiresAt: string | null }
interface ActiveWorkerKey { keyId:string;displayName:string;scopes:WorkerKeyScope[];createdAt:string;lastUsedAt:string|null }
interface QueueEntry { id: string; kind: "base_video" | "upscale" | "frame" | "start_frame" | "end_frame" | "anchor_pair" | "prompt"; prompt: string; contributor: string; submittedAt: string; thumbnailUrl?: string;endThumbnailUrl?:string;videoUrl?:string;endpointScreenId?:string;durationSeconds?:number;inputScreenExpired?:boolean;state: string; inputHeld?:boolean;automatedState?:string|null;reason?: string; paidAttemptConsumed?: boolean }
interface ChannelPolicyView { contributionMode: string; contributorWhitelist: string[]; reviewerWhitelist: string[]; uploadApprovalBypassIds: string[]; roleBasedUploadBypass: Array<"broadcaster"|"moderator">; subscriberInterrupts: InterruptSettings; subscriberAttemptReservationUsd:number|null; subscriberEventSubAuthorized:boolean; subscriberEventSubRegistered:boolean; bitsEventSubRegistered:boolean; isChannelOwner:boolean; chatVotingEnabled:boolean; preairUpscaleEnabled:boolean; preairUpscaleWaitSeconds:number; ownerBudgetCapUsd:number; ownerBudgetCommittedUsd:number; ownerBudgetRemainingUsd:number; ownerGenerationAttemptReservationUsd:number|null; ownerBudgetRemainingAttempts:number|null; storyWorldPrompt:string }

export function ControlCenter() {
  const router=useRouter();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newChannelState, setNewChannelState] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void apiFetch<SessionResponse>("/auth/session")
      .then((result) => { if (mounted) setSession(result); })
      .catch((problem: unknown) => { if (mounted && !(problem instanceof ApiError && problem.status === 401)) setError(displayProblem(problem)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const signIn = () => { router.push("/api/v1/auth/twitch/start?return_to=%2Fsloptogether%2Fcontrol"); };
  const createChannel = async () => {
    setBusy(true); setError(null); setNewChannelState("");
    try {
      await apiFetch("/channels", { method: "POST", body: JSON.stringify({}) });
      window.location.reload();
    } catch (problem) { setError(displayProblem(problem)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-top"><Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Control room" }]} /></div>
      <PageTitle eyebrow="CHANNEL CONTROL" title="Your channel, your rules." description="Connect Twitch to review clips, control future scenes, and configure the worker trust boundary." />
      {loading ? <div className="control-loading"><div className="loading-pulse"/><div className="loading-pulse short"/></div> : null}
      {!loading && !session?.authenticated ? <section className="auth-card">
        <span className="auth-symbol">◉</span><div><span className="section-label">TWITCH SIGN-IN</span><h2>Sign in as the broadcaster or a moderator.</h2><p>Channel controls use Twitch identity. Review permissions are checked for the selected channel before changes are accepted.</p>{error ? <p className="inline-error" role="status">{error}</p> : null}{session?.configured?.twitchOAuth===false?<p className="panel-copy" role="status">Twitch sign-in is not configured for this deployment yet.</p>:<button className="button" onClick={signIn}>Continue with Twitch <span aria-hidden="true">↗</span></button>}</div>
      </section> : null}
      {!loading && session?.authenticated ? <section className="control-dashboard">
        <div className="signed-in-card"><div className="identity-avatar">{session.user?.displayName.slice(0,1).toUpperCase() ?? "T"}</div><div><span className="section-label">CONNECTED TWITCH ACCOUNT</span><strong>{session.user?.displayName ?? session.user?.login}</strong><small>@{session.user?.login}</small></div><button className="button ghost small" onClick={async () => { await apiFetch("/auth/logout", { method: "POST", body: "{}" }); window.location.reload(); }}>Sign out</button></div>
        {error ? <p className="inline-error" role="status">{error}</p> : null}
      <div className="control-section-heading"><div><SectionLabel>CHANNELS YOU CAN CONTROL</SectionLabel><h2>Choose a channel space.</h2></div><button className="button secondary small" disabled={busy} onClick={() => void createChannel()}>{busy ? "Connecting…" : "Add my channel ＋"}</button></div>
        {session.channels?.length ? <div className="channel-control-grid">{session.channels.map((channel) => <article className="channel-control-card" key={channel.twitchChannelId}><div className="control-card-lockup"><span className="channel-avatar">{channel.displayName.slice(0,1).toUpperCase()}</span><span><strong>{channel.displayName}</strong><small>@{channel.login} · {channel.role}</small></span></div><div className="control-card-links"><Link className="button small" href={`/channels/${encodeURIComponent(channel.login)}/streams/main/moderate`}>Review clips</Link><Link className="button secondary small" href={`/channels/${encodeURIComponent(channel.login)}`}>Streams</Link><Link className="button ghost small" href={`/control/${encodeURIComponent(channel.login)}`}>Settings</Link></div><p className="panel-copy">Role permissions and channel policy are enforced by the server on every control action.</p></article>)}</div> : <div className="empty-state directory-empty"><div className="empty-glyph">✦</div><strong>No channel is connected yet.</strong><p>Add the channel attached to this Twitch account to begin its shared timeline.</p>{newChannelState ? <p className="inline-error">{newChannelState}</p> : null}</div>}
        <p className="fine-print">You can use one Twitch account for several channels; each channel keeps its own roles, contributors, approvals, story and budget.</p>
      </section> : null}
    </>
  );
}

export function ChannelSettings({ channel }: { channel: string }) {
  const [policy, setPolicy] = useState<ChannelPolicyView | null>(null);
  const [contributorIdsDraft, setContributorIdsDraft] = useState("");
  const [reviewerIdsDraft, setReviewerIdsDraft] = useState("");
  const [uploadBypassIdsDraft, setUploadBypassIdsDraft] = useState("");
  const [roleBypassDraft, setRoleBypassDraft] = useState<Array<"broadcaster"|"moderator">>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyScopes, setKeyScopes] = useState<WorkerKeyScope[]>(["worker:generation", "worker:upscale"]);
  const [keyName, setKeyName] = useState("");
  const [issuedKey, setIssuedKey] = useState<KeyResponse | null>(null);
  const [workerKeys,setWorkerKeys]=useState<ActiveWorkerKey[]>([]);
  const [storyWorldDraft,setStoryWorldDraft]=useState("");
  const [bitsEventSubSaving,setBitsEventSubSaving]=useState(false);

  useEffect(() => {
    let mounted = true;
    void apiFetch<ChannelPolicyView>(`/channels/${encodeURIComponent(channel)}/settings`)
      .then((result) => { if (mounted && result) { setPolicy(result); setStoryWorldDraft(result.storyWorldPrompt); setContributorIdsDraft(result.contributorWhitelist.join("\n")); setReviewerIdsDraft(result.reviewerWhitelist.join("\n")); setUploadBypassIdsDraft(result.uploadApprovalBypassIds.join("\n")); setRoleBypassDraft(result.roleBasedUploadBypass); } })
      .catch((problem) => { if (mounted) setError(displayProblem(problem)); });
    return () => { mounted = false; };
  }, [channel]);

  useEffect(()=>{let active=true;void apiFetch<{keys:ActiveWorkerKey[]}>(`/channels/${encodeURIComponent(channel)}/worker-keys`).then(value=>{if(active)setWorkerKeys(value.keys)}).catch(()=>{});return()=>{active=false}},[channel]);

  const updatePolicy = async (patch: Record<string, unknown>) => {
    setSaving(true); setError(null); setMessage(null);
    try {
      const updated = await apiFetch<ChannelPolicyView>(`/channels/${encodeURIComponent(channel)}/settings`, { method: "PATCH", body: JSON.stringify(patch) });
      if (updated) setPolicy(updated);
      setMessage("Channel settings saved.");
    } catch (problem) { setError(displayProblem(problem)); }
    finally { setSaving(false); }
  };

  const saveSubscriberSettings=async()=>{
    if(!policy)return;
    setSaving(true);setError(null);setMessage(null);
    try{
      const result=await apiFetch<{settings:InterruptSettings;eventSubRegistered:boolean}>(`/channels/${encodeURIComponent(channel)}/subscriber-interrupts`,{method:"PUT",body:JSON.stringify(policy.subscriberInterrupts)});
      setPolicy(current=>current?{...current,subscriberInterrupts:result.settings,subscriberEventSubRegistered:result.eventSubRegistered}:current);
      setMessage("Subscriber settings saved.");
    }catch(problem){setError(displayProblem(problem))}finally{setSaving(false)}
  };

  const registerBitsEventSub=async()=>{
    setBitsEventSubSaving(true);setError(null);setMessage(null);
    try{
      const result=await apiFetch<{registered:boolean;subscription:{state:"enabled"|"pending"}}>(`/channels/${encodeURIComponent(channel)}/bits-eventsub`,{method:"POST",body:"{}"});
      setPolicy(current=>current?{...current,bitsEventSubRegistered:result.registered}:current);
      setMessage(result.registered?"Bits transaction events are connected.":"Twitch is verifying the transaction webhook.");
    }catch(problem){setError(displayProblem(problem))}finally{setBitsEventSubSaving(false)}
  };

  const toggleKeyScope = (scope: WorkerKeyScope) => setKeyScopes((current) => current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]);
  const issueKey = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setIssuedKey(null);
    try {
      const result = await apiFetch<KeyResponse>(`/channels/${encodeURIComponent(channel)}/worker-keys`, { method: "POST", body: JSON.stringify({ displayName: keyName.trim(), scopes: keyScopes }) });
      setIssuedKey(result); setKeyName("");
      const updated=await apiFetch<{keys:ActiveWorkerKey[]}>(`/channels/${encodeURIComponent(channel)}/worker-keys`);setWorkerKeys(updated.keys);
    } catch (problem) { setError(displayProblem(problem)); }
  };
  const revokeKey=async(key:ActiveWorkerKey)=>{
    if(!window.confirm(`Revoke ${key.displayName}? Its active work will be fenced.`))return;
    try{await apiFetch(`/channels/${encodeURIComponent(channel)}/worker-keys/${encodeURIComponent(key.keyId)}/revoke`,{method:"POST",body:"{}"});setWorkerKeys(keys=>keys.filter(item=>item.keyId!==key.keyId));setMessage(`${key.displayName} was revoked.`)}
    catch(problem){setError(displayProblem(problem))}
  };
  const reaffirmTrust=async(key:ActiveWorkerKey)=>{
    const reason=window.prompt(`Why reaffirm trust for ${key.displayName}?`);
    if(!reason?.trim())return;
    setError(null);setMessage(null);
    try{
      await apiFetch(`/channels/${encodeURIComponent(channel)}/worker-keys/${encodeURIComponent(key.keyId)}/reaffirm-trust`,{method:"POST",body:JSON.stringify({reason:reason.trim()})});
      setMessage(`Trust reaffirmed for ${key.displayName}.`);
    }catch(problem){setError(displayProblem(problem))}
  };
  const setInterrupt = (patch: Partial<InterruptSettings>) => {
    if (!policy) return;
    setPolicy({ ...policy, subscriberInterrupts: { ...policy.subscriberInterrupts, ...patch } });
  };

  if (!policy && !error) return <div className="panel"><div className="loading-pulse"/><div className="loading-pulse short"/></div>;
  if (!policy) return <div className="alert error">{error ?? "Channel settings aren't available."}</div>;
  return (
    <div className="settings-stack">
      <section className="panel"><SectionLabel>WHO CAN PROPOSE AND WORK</SectionLabel><h2>Set the participation level.</h2><p className="panel-copy">Each contributor must connect their Twitch account in the site or worker. Bans override every allowlist.</p><div className="field"><label htmlFor="contribution-mode">Contribution mode</label><select id="contribution-mode" className="select-input" value={policy.contributionMode} onChange={(event) => setPolicy({ ...policy, contributionMode: event.target.value })}><option value="any_non_banned_twitch_user">Any authenticated, non-banned user</option><option value="broadcaster_and_moderators">Broadcaster and moderators</option><option value="explicit_allowlist">Explicit contributor list</option><option value="combined">Combine roles and allowlist</option></select></div><div className="field"><label htmlFor="contributors">Contributor Twitch user IDs</label><textarea id="contributors" className="text-input text-area" value={contributorIdsDraft} onChange={(event)=>setContributorIdsDraft(event.target.value)} placeholder="One Twitch ID per line"/></div><button className="button secondary small" disabled={saving} onClick={() => void updatePolicy({ contributionMode: policy.contributionMode, contributorWhitelist: parseIds(contributorIdsDraft) })}>{saving ? "Saving…" : "Save contribution access"}</button></section>
      <section className="panel"><SectionLabel>REVIEW &amp; UPLOAD TRUST</SectionLabel><h2>Choose who reviews and who is trusted to publish.</h2><p className="panel-copy">Reviewer access and upload-approval bypass are separate grants. A ban overrides both.</p><div className="form-grid"><label className="field"><span>Reviewer Twitch IDs</span><textarea className="text-input text-area" value={reviewerIdsDraft} onChange={(event)=>setReviewerIdsDraft(event.target.value)} placeholder="One reviewer ID per line"/></label><label className="field"><span>Upload bypass Twitch IDs</span><textarea className="text-input text-area" value={uploadBypassIdsDraft} onChange={(event)=>setUploadBypassIdsDraft(event.target.value)} placeholder="Only trusted uploader IDs"/></label></div><div className="role-bypass"><strong>Upload approval bypass by role</strong>{(["broadcaster","moderator"] as const).map(role=><label className="check-row" key={role}><input type="checkbox" checked={roleBypassDraft.includes(role)} onChange={()=>setRoleBypassDraft(current=>current.includes(role)?current.filter(value=>value!==role):[...current,role])}/><span>{role==="broadcaster"?"Streamer/broadcaster":"Verified Twitch moderators"}</span></label>)}</div><button className="button secondary small" disabled={saving} onClick={() => void updatePolicy({ reviewerWhitelist: parseIds(reviewerIdsDraft), uploadApprovalBypassIds: parseIds(uploadBypassIdsDraft), roleBasedUploadBypass: roleBypassDraft })}>{saving ? "Saving…" : "Save review and trust grants"}</button></section>

      <section className="panel"><SectionLabel>SUBSCRIBER MOMENTS</SectionLabel><h2>Catch a subscription.</h2>
        <p className="panel-copy">Per-alert reservation: {policy.subscriberAttemptReservationUsd===null?"not configured":`$${policy.subscriberAttemptReservationUsd.toFixed(2)}`}</p>
        <ToggleRow label="Listen for subscriptions" description="Record events only. No clips or render spend." checked={policy.subscriberInterrupts.eventSubListening} onChange={(checked) => setInterrupt({ eventSubListening: checked })}/>
        <ToggleRow label="Generate shout-outs" description="Uses the channel budget." checked={policy.subscriberInterrupts.enabled} onChange={(checked) => setInterrupt({ enabled: checked })}/>
        <ToggleRow label="New subscriptions" description="Acknowledge a new subscriber once." checked={policy.subscriberInterrupts.newSubscriptions} onChange={(checked) => setInterrupt({ newSubscriptions: checked })}/>
        <ToggleRow label="Shared resub messages" description="Optional shout-out when Twitch reports a resub message." checked={policy.subscriberInterrupts.resubscriptionMessages} onChange={(checked) => setInterrupt({ resubscriptionMessages: checked })}/>
        <label className="field"><span>Gift subscriptions</span><select className="select-input" value={policy.subscriberInterrupts.giftMode} onChange={(event) => setInterrupt({ giftMode: event.target.value as InterruptSettings["giftMode"] })}><option value="off">Off</option><option value="gifter_batch">One thank-you per gift batch</option><option value="recipient_each">One per recipient</option></select></label>
        <div className="form-grid"><div className="field"><label htmlFor="interrupt-gap">Minimum gap, seconds</label><input id="interrupt-gap" className="text-input" type="number" min={0} max={3600} value={policy.subscriberInterrupts.minimumGapSeconds} onChange={(event) => setInterrupt({ minimumGapSeconds: Number(event.target.value) })}/></div><div className="field"><label htmlFor="interrupt-cap">Hourly render cap, $</label><input id="interrupt-cap" className="text-input" type="number" min={0} step="0.25" max={500} value={policy.subscriberInterrupts.hourlySpendCapUsd} onChange={(event) => setInterrupt({ hourlySpendCapUsd: Number(event.target.value) })}/></div></div>
        <button className="button secondary small" disabled={saving} onClick={() => void saveSubscriberSettings()}>{saving ? "Saving…" : "Save subscriber settings"}</button>
        <p className="panel-copy">Twitch permission: {policy.subscriberEventSubAuthorized?"ready":"needed"} · EventSub: {policy.subscriberEventSubRegistered?"registered":"off"}</p>
        {!policy.subscriberEventSubAuthorized?<a className="text-link" href="/sloptogether/api/v1/auth/twitch/start?scope=openid%20user%3Aread%3Amoderated_channels%20channel%3Aread%3Asubscriptions&return_to=%2Fsloptogether%2Fcontrol">Connect Twitch subscription access ↗</a>:null}
      </section>

      <section className="panel"><SectionLabel>CHAT VOTING</SectionLabel><h2>Use the same ballot in chat.</h2><p className="panel-copy">The broadcaster&apos;s Twitch account must authorize chat-reading scopes. Viewers type <code>!slop vote 1</code> or a choice ID; chat, site, and Extension ballots share one account vote.</p><ToggleRow label="Enable !slop vote" description="Signed Twitch EventSub messages link to the channel election." checked={policy.chatVotingEnabled} onChange={checked=>void updatePolicy({chatVotingEnabled:checked})}/><a className="text-link" href="/sloptogether/api/v1/auth/twitch/start?scope=openid%20user%3Aread%3Amoderated_channels%20user%3Aread%3Achat%20user%3Abot&return_to=%2Fsloptogether%2Fcontrol">Reconnect Twitch with chat-event access ↗</a></section>

      <section className="panel"><SectionLabel>EXTENSION BITS</SectionLabel><h2>Connect transaction events.</h2><p className="panel-copy">Status: {policy.bitsEventSubRegistered?"connected":"not connected"}. Development purchases never dispatch paid renders.</p>{policy.isChannelOwner?<button className="button secondary small" disabled={bitsEventSubSaving||policy.bitsEventSubRegistered} onClick={()=>void registerBitsEventSub()}>{bitsEventSubSaving?"Connecting…":policy.bitsEventSubRegistered?"Connected":"Connect Bits EventSub"}</button>:null}</section>

      <section className="panel"><SectionLabel>UPSCALE BEFORE PLAYBACK</SectionLabel><h2>Upscale future clips</h2><label className="check-row"><input type="checkbox" checked={policy.preairUpscaleEnabled} onChange={event=>setPolicy({...policy,preairUpscaleEnabled:event.target.checked})}/><span>Upscale newly approved clips without fixed end frames</span></label><label className="field"><span>Maximum wait, seconds</span><input className="text-input" type="number" min={60} max={3600} step={60} value={policy.preairUpscaleWaitSeconds} onChange={event=>setPolicy({...policy,preairUpscaleWaitSeconds:Number(event.target.value)})}/></label><p className="panel-copy">If the upscale fails, is rejected, or times out, the approved base clip plays.</p><button className="button secondary small" disabled={saving} onClick={()=>void updatePolicy({preairUpscaleEnabled:policy.preairUpscaleEnabled,preairUpscaleWaitSeconds:policy.preairUpscaleWaitSeconds})}>{saving?"Saving…":"Save upscale settings"}</button></section>
      <section className="panel"><SectionLabel>STORY FEED &amp; OWNER BUDGET</SectionLabel><h2>Configure the test story producer.</h2><p className="panel-copy">The owner story worker only appends a scene when its generation attempt can be reserved under this channel budget.</p><label className="field"><span>Story world</span><textarea className="text-input text-area" value={storyWorldDraft} maxLength={4000} onChange={event=>setStoryWorldDraft(event.target.value)} placeholder="A gentle sci-fi story about a crew exploring impossible places…"/></label><label className="field"><span>Maximum owner-funded generation spend, USD</span><input className="text-input" type="number" min={0} max={10000} step="0.01" value={policy.ownerBudgetCapUsd} onChange={event=>setPolicy({...policy,ownerBudgetCapUsd:Number(event.target.value)})}/></label><p className="panel-copy">Committed or reserved: ${policy.ownerBudgetCommittedUsd.toFixed(2)} · remaining: ${policy.ownerBudgetRemainingUsd.toFixed(2)}. Per-scene reservation: {policy.ownerGenerationAttemptReservationUsd===null?"not configured":`$${policy.ownerGenerationAttemptReservationUsd.toFixed(2)}`}{policy.ownerBudgetRemainingAttempts===null?"":" · scenes available: "+policy.ownerBudgetRemainingAttempts}.</p><button className="button secondary small" disabled={saving} onClick={()=>void updatePolicy({storyWorldPrompt:storyWorldDraft,ownerBudgetCapUsd:policy.ownerBudgetCapUsd})}>{saving?"Saving…":"Save story feed settings"}</button></section>

      <section className="panel"><SectionLabel>WORKER KEYS</SectionLabel><h2>Connect the shared worker program.</h2><p className="panel-copy">Normal contributors pair Twitch. Headless fal/Linux workers can use a channel-scoped key; full editorial override is a separate high-impact grant.</p><form onSubmit={(event) => void issueKey(event)}><div className="field"><label htmlFor="key-name">Worker name</label><input className="text-input" id="key-name" value={keyName} maxLength={80} required onChange={(event) => setKeyName(event.target.value)} placeholder="Fal generation runner"/></div><div className="key-scope-list">{[...workerKeyScopes].map((scope) => <label className="check-row" key={scope}><input type="checkbox" checked={keyScopes.includes(scope)} onChange={() => toggleKeyScope(scope)}/><span><strong>{scope}</strong>{scope==="artifact:system_approve"?<small>Trusted worker output can skip human approval after input and media checks.</small>:null}{scope==="streamer:control"?<small>Full channel editor authority, including votes, timeline and playback.</small>:null}</span></label>)}</div><p className="fine-print key-warning">Streamer control can override channel votes, locks, future content, moderation decisions and browser playback. Give it only to a process you fully control.</p><button className="button" disabled={keyScopes.length===0}>Issue key</button></form>
        {issuedKey ? <div className="secret-card"><strong>Copy this key now. It is shown once.</strong><code>{issuedKey.secret}</code><small>{issuedKey.scopes.join(" · ")}</small></div> : null}
        {workerKeys.length?<div className="worker-key-list">{workerKeys.map(key=><div className="worker-key-row" key={key.keyId} style={{flexWrap:"wrap"}}><span><strong>{key.displayName}</strong><small>{key.scopes.join(" · ")} · {key.lastUsedAt?`Last used ${new Date(key.lastUsedAt).toLocaleString()}`:"Never used"}</small></span>{key.scopes.includes("artifact:system_approve")?<button className="button secondary small" type="button" onClick={()=>void reaffirmTrust(key)}>Reaffirm trust</button>:null}<button className="button danger small" type="button" onClick={()=>void revokeKey(key)}>Revoke</button></div>)}</div>:null}
      </section>
      {error ? <p role="alert" className="inline-error">{error}</p> : null}{message ? <p role="status" className="inline-success">{message}</p> : null}
    </div>
  );
}

export function ChannelModerationQueue({ channel,streamSlug="main" }: { channel: string;streamSlug?:string }) {
  const [items, setItems] = useState<QueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const loading=useRef(false);

  const load = useCallback(async () => {
    if(loading.current)return;
    loading.current=true;
    try {
      const response = await apiFetch<{ items: QueueEntry[] }>(`/channels/${encodeURIComponent(channel)}/streams/${encodeURIComponent(streamSlug)}/moderation/queue`);
      setItems(response.items);
      setError(null);
    } catch (problem) { setError(displayProblem(problem)); }
    finally{loading.current=false;}
  },[channel,streamSlug]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const timer=window.setInterval(()=>{if(!document.hidden)void load()},5000);
    return()=>window.clearInterval(timer);
  }, [load]);

  const decide = async (item: QueueEntry, decision: "approve" | "reject") => {
    const reason = decision === "reject" ? window.prompt("Reason for rejection:") : "";
    if (decision === "reject" && (reason === null || !reason.trim())) return;
    setActingOn(item.id); setError(null); setNote(null);
    try {
      const path=item.endpointScreenId?`/channels/${encodeURIComponent(channel)}/moderation/endpoint-input/${encodeURIComponent(item.endpointScreenId)}`:item.videoUrl?`/channels/${encodeURIComponent(channel)}/moderation/assets/${encodeURIComponent(item.id)}`:`/channels/${encodeURIComponent(channel)}/moderation/${encodeURIComponent(item.id)}`;
      const result=await apiFetch<{preairPending?:boolean}>(path, { method: "POST", body: JSON.stringify({ decision, reason }) });
      setItems((current) => current?.filter((entry) => entry.id !== item.id) ?? []);
      setNote(item.endpointScreenId?"End frame rejected.":item.videoUrl?(decision==="approve"?(item.kind==="upscale"?(result.preairPending?"Upscale approved.":"Upscale approved; playback history is unchanged."):"Clip approved."):"Clip rejected. The attempt was used."):decision === "approve" ? "Approved." : "Rejected. The attempt was used.");
    } catch (problem) { setError(displayProblem(problem)); }
    finally { setActingOn(null); }
  };

  const banContributor = async (item:QueueEntry) => {
    const reason=window.prompt("Reason for ban:");
    if(reason===null||!reason.trim())return;
    setActingOn(item.id);setError(null);setNote(null);
    try{
      if(!/^\d{1,32}$/.test(item.contributor))throw new Error("This artifact has no ban-eligible Twitch uploader.");
      await apiFetch(`/channels/${encodeURIComponent(channel)}/bans`,{method:"POST",body:JSON.stringify({twitchUserId:item.contributor,reason:reason.trim()})});
      setItems((current)=>current?.filter(entry=>entry.id!==item.id)??[]);
      setNote("Contributor banned.");
    }catch(problem){setError(displayProblem(problem));}
    finally{setActingOn(null);}
  };

  const resolveInputHold=async(item:QueueEntry)=>{
    const reason=window.prompt("Reason for clearing the input hold:");
    if(reason===null||!reason.trim())return;
    setActingOn(item.id);setError(null);setNote(null);
    try{
      const path=item.endpointScreenId?`/channels/${encodeURIComponent(channel)}/moderation/endpoint-input/${encodeURIComponent(item.endpointScreenId)}`:`/channels/${encodeURIComponent(channel)}/moderation/${encodeURIComponent(item.id)}/input-resolution`;
      await apiFetch(path,{method:"POST",body:JSON.stringify({decision:"clear",reason:reason.trim()})});
      await load();
      setNote("Input hold cleared.");
    }catch(problem){setError(displayProblem(problem))}finally{setActingOn(null)}
  };

  return <>
    <StoryBatchControl channel={channel} stream={streamSlug}/>
    {error ? <div role="alert" className="alert error">{error} <button className="button ghost small" onClick={() => void load()}>Retry</button></div> : null}
    {note ? <div role="status" className="alert success">{note}</div> : null}
    {items === null ? error ? <div className="empty-state review-empty"><strong>Review queue unavailable</strong><button className="button secondary small" onClick={() => void load()}>Retry</button></div> : <div className="panel"><div className="loading-pulse"/><div className="loading-pulse short"/></div> : items.length === 0 ? <div className="empty-state review-empty"><strong>Nothing to review</strong></div> : <div className="review-list">{items.map(item => <article key={item.id} className="review-card">
      <div className={`review-preview${item.endThumbnailUrl ? " review-pair-preview" : ""}`}>
        {item.videoUrl ? <video src={item.videoUrl} controls preload="metadata" aria-label="Generated clip for review"/> : item.thumbnailUrl ? <Image src={item.thumbnailUrl} alt="Start frame preview" width={480} height={270} unoptimized/> : <span aria-hidden="true">◈</span>}
        {item.endThumbnailUrl ? <Image src={item.endThumbnailUrl} alt="End frame preview" width={480} height={270} unoptimized/> : null}
      </div>
      <div className="review-detail">
        <p className="review-prompt">{item.prompt}</p>
        {item.inputHeld ? <p className="inline-error">Input check: {item.automatedState ?? "held"}</p> : null}
        {item.videoUrl && item.inputScreenExpired ? <p className="review-note">Input check expired after dispatch.</p> : null}
        <details className="review-details"><summary>Details</summary><div className="review-meta"><span>{item.kind.replaceAll("_", " ")}</span><span>{/^\d{1,32}$/.test(item.contributor) ? `Twitch user ID ${item.contributor}` : item.contributor}</span><span>{new Date(item.submittedAt).toLocaleString()}</span>{item.durationSeconds ? <span>{item.durationSeconds.toFixed(1)} sec</span> : null}<span>{item.videoUrl ? "Artifact ID" : "Revision ID"}: {item.id}</span></div></details>
      </div>
      <div className="review-actions">
        {item.inputHeld && !item.videoUrl ? <button disabled={actingOn !== null} className="button secondary small" onClick={() => void resolveInputHold(item)}>Clear hold</button> : item.inputHeld ? null : <button disabled={actingOn !== null} className="button small" onClick={() => void decide(item, "approve")}>{actingOn === item.id ? "Saving…" : "Approve"}</button>}
        <button disabled={actingOn !== null} className="button danger small" onClick={() => void decide(item, "reject")}>Reject</button>
        {/^\d{1,32}$/.test(item.contributor) ? <button disabled={actingOn !== null} className="button danger small" onClick={() => void banContributor(item)}>Ban user</button> : null}
      </div>
    </article>)}</div>}
  </>;
}

function ToggleRow({label,description,checked,onChange}: {label:string;description:string;checked:boolean;onChange:(value:boolean)=>void}) {
  return <label className="toggle-row"><span className="toggle-label"><strong>{label}</strong><small>{description}</small></span><span className="toggle-switch"><input type="checkbox" checked={checked} onChange={(event)=>onChange(event.currentTarget.checked)}/><span aria-hidden="true"/></span></label>;
}

function parseIds(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map(item=>item.trim()).filter(item=>/^\d{1,32}$/.test(item)))];
}
