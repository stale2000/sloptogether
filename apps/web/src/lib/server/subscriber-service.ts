import "server-only";

import { createHash } from "node:crypto";
import { interruptSettingsSchema, type InterruptSettings } from "@sloptogether/contracts";
import type { PoolClient } from "pg";
import { canContribute, findChannel, isBanned, requireChannelModerator, type ChannelRow } from "./channels";
import { lifecyclePool, query, transaction, transactionOnClient, TransactionCleanupError } from "./db";
import { verifyExtensionRequest } from "./extension-auth";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { requestPrincipal } from "./principals";
import { getActiveElections } from "./timeline";
import { currentSession } from "./session";
import { appAccessToken,twitchCredentials } from "./twitch";
import { reservationUsd } from "./reservation";
import { carryForwardTrustedExecutions } from "./trusted-policy";
import { getStream } from "./stream-service";
import { ACTIVE_INTERRUPT_STATES, CHAT_EVENT_TYPE, EVENT_TYPES, type SubscriptionEventType } from "./eventsub-types";

const DEFAULT_SETTINGS: InterruptSettings = {
  enabled: false,
  newSubscriptions: true,
  resubscriptionMessages: false,
  giftMode: "off",
  minimumGapSeconds: 60,
  eventMaxAgeSeconds: 180,
  hourlySpendCapUsd: 0,
  fallback: "skip",
};

export async function withEventSubLifecycleLock<T>(channelId:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await lifecyclePool().connect();let locked=false;let discard=false;
  try{
    const result=await client.query<{acquired:boolean}>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",["eventsub-lifecycle:"+channelId]);
    if(!result.rows[0]?.acquired)throw new ApiError(409,"eventsub_update_in_progress","Another Twitch event setup change is still running. Retry this settings save.");
    locked=true;
    try{return await work(client)}catch(error){if(error instanceof TransactionCleanupError)discard=true;throw error;}
  }finally{
    if(locked&&!discard){
      try{
        const result=await client.query<{pg_advisory_unlock:boolean}>("SELECT pg_advisory_unlock(hashtextextended($1,0))",["eventsub-lifecycle:"+channelId]);
        if(result.rows[0]?.pg_advisory_unlock!==true)discard=true;
      }catch{discard=true;}
    }
    client.release(discard);
  }
}

export function settingsFrom(value: unknown): InterruptSettings {
  const normalized=value&&typeof value==="object"&&!Array.isArray(value)&&"fallback" in value&&value.fallback==="text_acknowledgment"
    ?{...value,fallback:"skip"}:value;
  const parsed = interruptSettingsSchema.safeParse(normalized);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

function requireSubscriberFunding(settings:InterruptSettings,ownerBudgetCapUsd:number|string){
  if(!settings.enabled)return;
  const quote=reservationUsd("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD");
  if(quote===null)throw new ApiError(503,"subscriber_reservation_not_configured","Subscriber render pricing is not configured.");
  if(Number(ownerBudgetCapUsd)+0.000001<quote)
    throw new ApiError(409,"subscriber_budget_cap_too_low","Raise the channel owner budget to at least the per-interrupt reservation.");
  if(settings.hourlySpendCapUsd+0.000001<quote)
    throw new ApiError(409,"subscriber_hourly_cap_too_low","Set the hourly render cap to at least the per-interrupt reservation.");
}

export async function ownerAuthorized(client: { query(text: string, values: unknown[]): Promise<{ rowCount: number | null }> }, ownerId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM sloptogether.sessions WHERE twitch_user_id=$1 AND revoked_at IS NULL
       AND expires_at>now() AND granted_scopes @> ARRAY['channel:read:subscriptions']::text[] LIMIT 1`,
    [ownerId],
  );
  return Boolean(result.rowCount);
}

type ExistingSubscription={id:string;type:string;version:string;status?:string;condition?:{broadcaster_user_id?:string;user_id?:string};transport?:{method?:string;callback?:string}};

async function allSubscriptions(headers:Record<string,string>){
  const statuses=["enabled","webhook_callback_verification_pending","webhook_callback_verification_failed","notification_failures_exceeded","authorization_revoked","moderator_removed"];
  const subscriptions:ExistingSubscription[]=[];
  for(const status of statuses){
    const url=new URL("https://api.twitch.tv/helix/eventsub/subscriptions");url.searchParams.set("status",status);url.searchParams.set("first","100");
    for(let page=0;page<10;page++){
      const response=await fetch(url,{headers,cache:"no-store",signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new ApiError(502,"eventsub_subscription_lookup_failed");
      const value=await response.json() as {data?:ExistingSubscription[];pagination?:{cursor?:string}};
      subscriptions.push(...(value.data??[]));
      const cursor=value.pagination?.cursor;if(!cursor)break;url.searchParams.set("after",cursor);
    }
  }
  return subscriptions;
}

async function removeStaleSubscriptions(headers:Record<string,string>,ids:string[]){
  for(const id of ids){
    const url=new URL("https://api.twitch.tv/helix/eventsub/subscriptions");url.searchParams.set("id",id);
    const response=await fetch(url,{method:"DELETE",headers,cache:"no-store",signal:AbortSignal.timeout(8000)});
    if(!response.ok&&response.status!==404)throw new ApiError(502,"eventsub_subscription_cleanup_failed");
  }
}

function eventSubConfigFingerprint(callback:string,secret:string){return createHash("sha256").update(callback).update("\0").update(secret).digest();}

async function registrationNeedsRefresh(client:PoolClient,channelId:string,key:string,fingerprint:Buffer){
  const stored=await client.query<{config_fingerprint:Buffer}>("SELECT config_fingerprint FROM sloptogether.eventsub_config_fingerprints WHERE twitch_channel_id=$1 AND registration_key=$2",[channelId,key]);
  return !stored.rows[0]?.config_fingerprint.equals(fingerprint);
}

async function storeRegistrationFingerprint(client:PoolClient,channelId:string,key:string,fingerprint:Buffer,subscriptionIds:string[]){
  await client.query(`INSERT INTO sloptogether.eventsub_config_fingerprints(twitch_channel_id,registration_key,config_fingerprint,subscription_ids)
    VALUES($1,$2,$3,$4) ON CONFLICT(twitch_channel_id,registration_key) DO UPDATE SET
      config_fingerprint=EXCLUDED.config_fingerprint,subscription_ids=EXCLUDED.subscription_ids,updated_at=now()`,[channelId,key,fingerprint,subscriptionIds]);
}

export async function deleteRegistrationFingerprint(client:PoolClient,channelId:string,key:string){
  await client.query("DELETE FROM sloptogether.eventsub_config_fingerprints WHERE twitch_channel_id=$1 AND registration_key=$2",[channelId,key]);
}

async function eventSubHeaders(){
  const credentials=twitchCredentials();const token=await appAccessToken();
  return {"Client-Id":credentials.clientId,Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
}

export async function disableSubscriberEventSubscriptions(broadcasterId:string,client:PoolClient){
  const headers=await eventSubHeaders();const subscriptions=await allSubscriptions(headers);
  const relevant=subscriptions.filter(row=>EVENT_TYPES.includes(row.type as SubscriptionEventType)&&row.condition?.broadcaster_user_id===broadcasterId);
  await removeStaleSubscriptions(headers,relevant.map(row=>row.id));
  await deleteRegistrationFingerprint(client,broadcasterId,"subscriber-events");
}

export async function disableChatVoteSubscription(channel:ChannelRow,client:PoolClient){
  const headers=await eventSubHeaders();const subscriptions=await allSubscriptions(headers);
  const relevant=subscriptions.filter(row=>row.type===CHAT_EVENT_TYPE&&row.condition?.broadcaster_user_id===channel.twitch_channel_id&&row.condition?.user_id===channel.owner_twitch_user_id);
  await removeStaleSubscriptions(headers,relevant.map(row=>row.id));
  await deleteRegistrationFingerprint(client,channel.twitch_channel_id,"chat:"+channel.owner_twitch_user_id);
}

/** Persist an already-authorized subscriber policy under the channel lock. */
export async function persistSubscriberSettings(client:PoolClient,channelId:string,actor:string,settings:InterruptSettings){
  const current=await client.query<{owner_twitch_user_id:string;owner_budget_cap_usd:string}>(
    "SELECT owner_twitch_user_id,owner_budget_cap_usd FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channelId]);
  if(!current.rows[0])throw new ApiError(404,"channel_not_found");
  if(await isBanned(channelId,actor,client))throw new ApiError(403,"channel_ban_active");
  if((settings.enabled||settings.resubscriptionMessages)&&!await ownerAuthorized(client,current.rows[0].owner_twitch_user_id))
    throw new ApiError(409,"subscription_authorization_required","The broadcaster must connect Twitch with subscription access before enabling subscription EventSub.");
  requireSubscriberFunding(settings,current.rows[0].owner_budget_cap_usd);
  const updated=await client.query<{policy_revision:number}>(`UPDATE sloptogether.channels SET subscriber_interrupt_policy=$2::jsonb,
    policy_revision=policy_revision+1,updated_at=now() WHERE twitch_channel_id=$1 RETURNING policy_revision`,[channelId,JSON.stringify(settings)]);
  if(!updated.rows[0])throw new ApiError(404,"channel_not_found");
  await carryForwardTrustedExecutions(client,channelId,updated.rows[0].policy_revision);
  if(!settings.enabled)await cancelPendingInterrupts(client,channelId);
  await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,policy_revision,after_state)
    VALUES($1,$2,'subscriber_interrupt.settings','channel',$1,$3,$4::jsonb)`,[channelId,actor,updated.rows[0].policy_revision,JSON.stringify(settings)]);
}

export async function handleSubscriberSettings(locator: string, request: Request, action: "read" | "update") {
  const channel = await findChannel(locator);
  const principal = await requestPrincipal(request);
  const actor = await requireChannelModerator(channel, principal);
  if (await isBanned(channel.twitch_channel_id, actor)) throw new ApiError(403, "channel_ban_active");
  if (action === "update") {
    if (principal?.kind === "session") assertSameOrigin(request);
    const settings = await readJson(request, interruptSettingsSchema);
    const session=settings.enabled?await currentSession(request):null;
    if(settings.enabled&&(!session||session.twitchUserId!==channel.owner_twitch_user_id||!session.scopes.includes("channel:read:subscriptions")))
      throw new ApiError(409,"subscription_authorization_required","The broadcaster must reconnect with subscription access before enabling generated shout-outs.");
    requireSubscriberFunding(settings,channel.owner_budget_cap_usd);
    await withEventSubLifecycleLock(channel.twitch_channel_id,async client=>{
    if(settings.enabled||settings.resubscriptionMessages){
      const eventTypes=settings.enabled?EVENT_TYPES:["channel.subscription.message"] as const;
      await ensureSubscriptionEvents(channel.twitch_channel_id,client,eventTypes);
    }
      await transactionOnClient(client,client=>persistSubscriberSettings(client,channel.twitch_channel_id,actor,settings));
    if(!settings.enabled&&!settings.resubscriptionMessages)await disableSubscriberEventSubscriptions(channel.twitch_channel_id,client);
    });
  }
  const result = await query<{ subscriber_interrupt_policy: unknown; policy_revision: number; owner_twitch_user_id: string }>(
    "SELECT subscriber_interrupt_policy,policy_revision,owner_twitch_user_id FROM sloptogether.channels WHERE twitch_channel_id=$1",
    [channel.twitch_channel_id],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "channel_not_found");
  const pending = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1 AND program_state=ANY($2::text[]) AND expires_at>now()",
    [channel.twitch_channel_id, ACTIVE_INTERRUPT_STATES],
  );
  return {
    settings: settingsFrom(row.subscriber_interrupt_policy),
    policyRevision: row.policy_revision,
    pendingCount: Number(pending.rows[0]?.count ?? 0),
    eventSubAuthorized: await ownerAuthorized({ query }, row.owner_twitch_user_id),
  };
}

async function ensureSubscriptionEvents(broadcasterId:string,client:PoolClient,eventTypes:readonly SubscriptionEventType[]=EVENT_TYPES){
  const callback=process.env.TWITCH_EVENTSUB_CALLBACK_URL??`${(process.env.PUBLIC_APP_URL??"").replace(/\/$/,"")}/api/v1/webhooks/eventsub`;
  const secret=process.env.TWITCH_EVENTSUB_SECRET;
  if(!secret||secret.length<10||secret.length>100||!callback.startsWith("https://"))throw new ApiError(503,"eventsub_not_configured");
  const fingerprint=eventSubConfigFingerprint(callback,secret);
  const refresh=await registrationNeedsRefresh(client,broadcasterId,"subscriber-events",fingerprint);
  const credentials=twitchCredentials();const token=await appAccessToken();const headers={"Client-Id":credentials.clientId,Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  const subscriptions=await allSubscriptions(headers);
  const relevant=subscriptions.filter(row=>EVENT_TYPES.includes(row.type as SubscriptionEventType)&&row.condition?.broadcaster_user_id===broadcasterId);
  const reusable=refresh?[]:relevant.filter(row=>eventTypes.includes(row.type as SubscriptionEventType)&&["enabled","webhook_callback_verification_pending"].includes(row.status??"")&&row.version==="1"&&row.transport?.method==="webhook"&&row.transport.callback===callback);
  const existing=new Set(reusable.map(row=>row.type));
  const subscriptionIds=new Set(reusable.map(row=>row.id));
  await removeStaleSubscriptions(headers,relevant.filter(row=>refresh||!existing.has(row.type)||!["enabled","webhook_callback_verification_pending"].includes(row.status??"")||row.version!=="1"||row.transport?.method!=="webhook"||row.transport.callback!==callback).map(row=>row.id));
  for(const type of eventTypes){
    if(existing.has(type))continue;
    const response=await fetch("https://api.twitch.tv/helix/eventsub/subscriptions",{
      method:"POST",headers,cache:"no-store",signal:AbortSignal.timeout(8000),
      body:JSON.stringify({type,version:"1",condition:{broadcaster_user_id:broadcasterId},transport:{method:"webhook",callback,secret}}),
    });
    if(!response.ok)throw new ApiError(502,"eventsub_subscription_create_failed","Twitch could not enable the subscription event. Confirm the channel scope and callback configuration.");
    const result=await response.json() as {data?:Array<{id?:string}>};
    const id=result.data?.[0]?.id;if(!id)throw new ApiError(502,"eventsub_subscription_response_invalid");
    subscriptionIds.add(id);
  }
  await storeRegistrationFingerprint(client,broadcasterId,"subscriber-events",fingerprint,[...subscriptionIds]);
}

export async function authorizeChatVoteSubscription(channel:ChannelRow,request:Request){
  assertSameOrigin(request);
  const principal=await requestPrincipal(request);
  const actor=await requireChannelModerator(channel,principal);
  if(principal?.kind!=="session"||actor!==channel.owner_twitch_user_id)throw new ApiError(403,"broadcaster_session_required");
  const session=await currentSession(request);
  if(!session||session.twitchUserId!==channel.owner_twitch_user_id||!session.scopes.includes("user:read:chat")||!session.scopes.includes("user:bot"))
    throw new ApiError(409,"chat_authorization_required","Reconnect the broadcaster Twitch account with user:read:chat and user:bot access first.");
  return session;
}

export async function ensureChatVoteSubscription(channel:ChannelRow,session:NonNullable<Awaited<ReturnType<typeof currentSession>>>,client:PoolClient){
  const callback=process.env.TWITCH_EVENTSUB_CALLBACK_URL??`${(process.env.PUBLIC_APP_URL??"").replace(/\/$/,"")}/api/v1/webhooks/eventsub`;
  const secret=process.env.TWITCH_EVENTSUB_SECRET;
  if(!secret||secret.length<10||secret.length>100||!callback.startsWith("https://"))throw new ApiError(503,"eventsub_not_configured");
  const fingerprint=eventSubConfigFingerprint(callback,secret);
  const registrationKey="chat:"+session.twitchUserId;
  const refresh=await registrationNeedsRefresh(client,channel.twitch_channel_id,registrationKey,fingerprint);
  const credentials=twitchCredentials();const token=await appAccessToken();const headers={"Client-Id":credentials.clientId,Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  const subscriptions=await allSubscriptions(headers);
  const relevant=subscriptions.filter(row=>row.type===CHAT_EVENT_TYPE&&row.condition?.broadcaster_user_id===channel.twitch_channel_id&&row.condition?.user_id===session.twitchUserId);
  const reusable=refresh?[]:relevant.filter(row=>["enabled","webhook_callback_verification_pending"].includes(row.status??"")&&row.version==="1"&&row.transport?.method==="webhook"&&row.transport.callback===callback);
  const found=reusable.length>0;
  const subscriptionIds=new Set(reusable.map(row=>row.id));
  await removeStaleSubscriptions(headers,relevant.filter(row=>refresh||!["enabled","webhook_callback_verification_pending"].includes(row.status??"")||row.version!=="1"||row.transport?.method!=="webhook"||row.transport.callback!==callback).map(row=>row.id));
  if(found){await storeRegistrationFingerprint(client,channel.twitch_channel_id,registrationKey,fingerprint,[...subscriptionIds]);return {enabled:true}}
  const response=await fetch("https://api.twitch.tv/helix/eventsub/subscriptions",{
    method:"POST",headers,cache:"no-store",signal:AbortSignal.timeout(8000),
    body:JSON.stringify({type:CHAT_EVENT_TYPE,version:"1",condition:{broadcaster_user_id:channel.twitch_channel_id,user_id:session.twitchUserId},transport:{method:"webhook",callback,secret}}),
  });
  if(!response.ok)throw new ApiError(502,"eventsub_chat_subscription_create_failed","Twitch could not enable chat voting. Confirm the broadcaster's chat scopes and EventSub settings.");
  const result=await response.json() as {data?:Array<{id?:string}>};
  const id=result.data?.[0]?.id;if(!id)throw new ApiError(502,"eventsub_subscription_response_invalid");
  subscriptionIds.add(id);
  await storeRegistrationFingerprint(client,channel.twitch_channel_id,registrationKey,fingerprint,[...subscriptionIds]);
  return {enabled:true};
}

export async function cancelPendingInterrupts(client: PoolClient, channelId: string, expiredOnly = false, actorId?:string) {
  await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[channelId]);
  const terminalState = expiredOnly ? "expired" : "cancelled";
  const cancelled = await client.query<{ id: string; funding_id: string | null; job_id: string | null }>(
    `UPDATE sloptogether.interrupt_requests ir SET program_state=$3
     WHERE ir.broadcaster_twitch_id=$1 AND ir.program_state=ANY($2::text[]) AND ir.program_state<>'playing'
       AND ($4::boolean=false OR ir.expires_at<=now())
       AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM sloptogether.subscription_events se WHERE se.interrupt_id=ir.id AND se.twitch_actor_id=$5))
     RETURNING ir.id,ir.funding_id,ir.job_id`,
    [channelId, ACTIVE_INTERRUPT_STATES, terminalState, expiredOnly, actorId??null],
  );
  if (!cancelled.rowCount) return;
  const ids = cancelled.rows.map((row) => row.id);
  const jobIds = cancelled.rows.map((row) => row.job_id).filter((id): id is string => Boolean(id));
  const fundingIds = cancelled.rows.map((row) => row.funding_id).filter((id): id is string => Boolean(id));
  await client.query("UPDATE sloptogether.subscription_events SET state=$2 WHERE interrupt_id=ANY($1::uuid[]) AND state<>'played'", [ids, terminalState]);
  await client.query(
    "UPDATE sloptogether.outbox SET delivered_at=now() WHERE aggregate_id=ANY($1::text[]) AND event_kind='subscriber_interrupt.plan' AND delivered_at IS NULL",
    [ids],
  );
  if (jobIds.length) {
    await client.query("UPDATE sloptogether.jobs SET state=$2,cancelled_at=now() WHERE id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','cancelled','expired')", [jobIds, terminalState]);
    await client.query(
      `UPDATE sloptogether.job_attempts SET state=$2,fence=fence+1,lease_expires_at=now(),finished_at=now()
       WHERE job_id=ANY($1::uuid[]) AND state NOT IN ('succeeded','failed','rejected','expired','cancelled')`,
      [jobIds, terminalState],
    );
    await client.query("UPDATE sloptogether.upload_reservations SET state='expired',expires_at=now() WHERE attempt_id IN (SELECT id FROM sloptogether.job_attempts WHERE job_id=ANY($1::uuid[])) AND state IN ('issued','uploaded')",[jobIds]);
    const rejected=await client.query<{id:string}>(`UPDATE sloptogether.assets SET status='rejected'
      WHERE id IN (SELECT a.output_asset_id FROM sloptogether.job_attempts a WHERE a.job_id=ANY($1::uuid[]) AND a.output_asset_id IS NOT NULL)
        AND status IN ('quarantine','validated','approved')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.asset_id=sloptogether.assets.id AND pi.committed_at IS NOT NULL)
      RETURNING id`,[jobIds]);
    const rejectedIds=rejected.rows.map(row=>row.id);
    if(rejectedIds.length){
      await client.query("UPDATE sloptogether.artifact_approvals SET decision='revoked',reason='Subscriber interrupt was cancelled or expired' WHERE asset_id=ANY($1::uuid[]) AND decision='approved'",[rejectedIds]);
      await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE aggregate_id=ANY($1::text[]) AND event_kind IN ('media.validate','media.publish_requested') AND delivered_at IS NULL",[rejectedIds]);
    }
  }
  if (fundingIds.length) {
    // Claimed or uncertain work keeps its spend history. A ready attempt that
    // never received a lease has not consumed the reservation.
    await client.query(
      `UPDATE sloptogether.funding_authorizations f SET state='released',settled_at=now()
       WHERE f.id=ANY($1::uuid[]) AND f.state='reserved'
         AND NOT EXISTS(SELECT 1 FROM sloptogether.job_attempts a WHERE a.funding_id=f.id AND a.claimed_at IS NOT NULL)`,
      [fundingIds],
    );
  }
}

export async function getPublicSubscriberState(channelId: string) {
  const expired=await query<{id:string}>(`SELECT id FROM sloptogether.interrupt_requests
    WHERE broadcaster_twitch_id=$1 AND program_state=ANY($2::text[]) AND program_state<>'playing' AND expires_at<=now() LIMIT 1`,[channelId,ACTIVE_INTERRUPT_STATES]);
  if(expired.rowCount)await transaction(client=>cancelPendingInterrupts(client,channelId,true));
  const result = await query<{ subscriber_interrupt_policy: unknown; is_enabled: boolean }>(
    "SELECT subscriber_interrupt_policy,is_enabled FROM sloptogether.channels WHERE twitch_channel_id=$1",
    [channelId],
  );
  const channel = result.rows[0];
  const enabled = Boolean(channel?.is_enabled && settingsFrom(channel.subscriber_interrupt_policy).enabled);
  if (!enabled) return { enabled: false, current: null };
  const current = await query<{ id: string; subscriber_label: string; program_state: string }>(
    `SELECT id,subscriber_label,program_state FROM sloptogether.interrupt_requests
     WHERE broadcaster_twitch_id=$1 AND program_state=ANY($2::text[]) AND expires_at>now()
     ORDER BY (program_state='playing') DESC,created_at LIMIT 1`,
    [channelId, ACTIVE_INTERRUPT_STATES],
  );
  const row = current.rows[0];
  return { enabled: true, current: row ? { id: row.id, label: row.subscriber_label, state: row.program_state } : null };
}

export async function getExtensionState(request: Request) {
  const extension = verifyExtensionRequest(request);
  const channel = await findChannel(extension.channelId);
  const requestedSlug=new URL(request.url).searchParams.get("stream")?.toLowerCase()??"main";
  const stream=await getStream(channel.twitch_channel_id,requestedSlug);
  const streamRows=await query<{id:string;slug:string;display_name:string;is_default:boolean}>(
    "SELECT id,slug,display_name,is_default FROM sloptogether.streams WHERE twitch_channel_id=$1 ORDER BY is_default DESC,created_at,id",[channel.twitch_channel_id]);
  const [elections, subscriberInterrupts] = await Promise.all([
    getActiveElections(channel.twitch_channel_id, { kind: "extension", extension },stream.id),
    getPublicSubscriberState(channel.twitch_channel_id),
  ]);
  const canSubmitPrompts=await canContribute(channel,{kind:"extension",extension});
  return {
    channel: { twitchChannelId: channel.twitch_channel_id, twitchLogin: channel.twitch_login, displayName: channel.display_name },
    stream:{id:stream.id,slug:stream.slug,displayName:stream.display_name},
    streams:streamRows.rows.map(item=>({id:item.id,slug:item.slug,displayName:item.display_name,isDefault:item.is_default})),
    elections,
    activeElection: elections[0] ?? null,
    subscriberInterrupts,
    canSubmitPrompts,
  };
}
