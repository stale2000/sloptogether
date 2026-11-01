import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { uuidSchema, type InterruptSettings } from "@sloptogether/contracts";
import { query, transaction, transactionOnClient } from "./db";
import { ApiError } from "./http";
import { castBallot } from "./voting-service";
import { recordVerifiedExtensionBitsEvent } from "./paid-bits-service";
import { submitResubPrompt } from "./proposal-service";
import { reservationUsd } from "./reservation";
import { ACTIVE_INTERRUPT_STATES, BITS_EVENT_TYPE, CHAT_EVENT_TYPE, EVENT_TYPES, type EventSubEnvelope, type SubscriptionEventType } from "./eventsub-types";
import { cancelPendingInterrupts, deleteRegistrationFingerprint, ownerAuthorized, settingsFrom, withEventSubLifecycleLock } from "./subscriber-service";

const MAX_WEBHOOK_BYTES = 256_000;
const MAX_PENDING_INTERRUPTS = 20;

async function readRawBody(request: Request): Promise<Buffer> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_WEBHOOK_BYTES) throw new ApiError(413, "webhook_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "webhook_body_required");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) { await reader.cancel(); throw new ApiError(413, "webhook_too_large"); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function eventSubSecrets(): string[] {
  return [process.env.TWITCH_EVENTSUB_SECRET, process.env.TWITCH_EVENTSUB_SECRET_PREVIOUS]
    .filter((secret): secret is string => Boolean(secret && secret.length >= 10 && secret.length <= 100 && /^[\x20-\x7e]+$/.test(secret)));
}

/** Verify the raw bytes before parsing JSON or writing any event receipt. */
export function verifyEventSubMessage(request: Request, body: Buffer, now = Date.now()) {
  const messageId = request.headers.get("twitch-eventsub-message-id") ?? "";
  const timestamp = request.headers.get("twitch-eventsub-message-timestamp") ?? "";
  const signature = request.headers.get("twitch-eventsub-message-signature") ?? "";
  const messageType = request.headers.get("twitch-eventsub-message-type") ?? "";
  if (!messageId || messageId.length > 256 || /[\r\n]/.test(messageId) || timestamp.length > 64 || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    throw new ApiError(403, "eventsub_signature_invalid");
  }
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime) || eventTime < now - 10 * 60_000 || eventTime > now + 30_000) throw new ApiError(403, "eventsub_timestamp_stale");
  if (!["notification", "webhook_callback_verification", "revocation"].includes(messageType)) throw new ApiError(400, "eventsub_message_type_invalid");
  const secrets = eventSubSecrets();
  if (!secrets.length) throw new ApiError(503, "eventsub_not_configured");
  const supplied = Buffer.from(signature.slice(7), "hex");
  const message = Buffer.concat([Buffer.from(messageId + timestamp, "utf8"), body]);
  const verified = secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(message).digest();
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  });
  if (!verified) throw new ApiError(403, "eventsub_signature_invalid");
  return { messageId, eventAt: new Date(eventTime), messageType };
}

function parseEnvelope(raw: Buffer, request: Request): EventSubEnvelope {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { throw new ApiError(400, "eventsub_json_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "eventsub_payload_invalid");
  const envelope = value as Record<string, unknown>;
  const subscription = envelope.subscription as Record<string, unknown> | undefined;
  const condition = subscription?.condition as Record<string, unknown> | undefined;
  const type = subscription?.type;
  if (!subscription || typeof subscription.id !== "string" || subscription.id.length > 256 || !(EVENT_TYPES.includes(type as SubscriptionEventType)||type===CHAT_EVENT_TYPE||type===BITS_EVENT_TYPE) || subscription.version !== "1"
    || !condition) {
    throw new ApiError(400, "eventsub_subscription_invalid");
  }
  if(type===BITS_EVENT_TYPE){
    if(typeof condition.extension_client_id!=="string"||condition.extension_client_id!==process.env.TWITCH_EXTENSION_CLIENT_ID)throw new ApiError(403,"eventsub_extension_condition_invalid");
  }else if(typeof condition.broadcaster_user_id !== "string" || !/^\d{1,32}$/.test(condition.broadcaster_user_id))throw new ApiError(400,"eventsub_subscription_invalid");
  if(type===CHAT_EVENT_TYPE&&(typeof condition.user_id!=="string"||!/^\d{1,32}$/.test(condition.user_id)))throw new ApiError(400,"eventsub_chat_condition_invalid");
  const headerType = request.headers.get("twitch-eventsub-subscription-type");
  const headerVersion = request.headers.get("twitch-eventsub-subscription-version");
  if ((headerType && headerType !== type) || (headerVersion && headerVersion !== "1")) throw new ApiError(403, "eventsub_subscription_mismatch");
  const transport = subscription.transport as Record<string, unknown> | undefined;
  if (transport?.method !== undefined && transport.method !== "webhook") throw new ApiError(403, "eventsub_transport_invalid");
  if (transport?.callback !== undefined) {
    const expected = process.env.TWITCH_EVENTSUB_CALLBACK_URL
      ?? (process.env.PUBLIC_APP_URL ? process.env.PUBLIC_APP_URL.replace(/\/$/, "") + "/api/v1/webhooks/eventsub" : null);
    if (!expected || typeof transport.callback !== "string" || transport.callback !== expected) throw new ApiError(403, "eventsub_callback_mismatch");
  }
  return value as EventSubEnvelope;
}

function subscriberLabel(event: Record<string, unknown>): string {
  if (event.is_anonymous === true) return "A generous mystery hero";
  const displayName=event.user_name;
  if(typeof displayName==="string"){
    const safeDisplayName=Array.from(displayName).filter(character=>/[\p{L}\p{N}_ -]/u.test(character)).join("").trim().slice(0,32);
    if(safeDisplayName)return safeDisplayName;
  }
  const login = event.user_login;
  return typeof login === "string" && /^[a-zA-Z0-9_]{1,25}$/.test(login) ? login : "A community hero";
}

function eligibleEvent(type: SubscriptionEventType, event: Record<string, unknown>, settings: InterruptSettings) {
  if (!settings.enabled) return false;
  if (type === "channel.subscribe") return event.is_gift === true ? settings.giftMode === "recipient_each" : settings.newSubscriptions;
  if (type === "channel.subscription.message") return settings.resubscriptionMessages;
  return settings.giftMode === "gifter_batch";
}

function validateSubscriptionEvent(type: SubscriptionEventType, event: Record<string, unknown>) {
  if (type === "channel.subscription.gift") {
    if (typeof event.is_anonymous !== "boolean" || typeof event.total !== "number" || !Number.isSafeInteger(event.total) || event.total < 1) {
      throw new ApiError(400, "eventsub_event_invalid");
    }
    if (event.is_anonymous) return;
  } else if (type === "channel.subscribe" && typeof event.is_gift !== "boolean") {
    throw new ApiError(400, "eventsub_event_invalid");
  }
  if (typeof event.user_id !== "string" || !/^\d{1,32}$/.test(event.user_id)
    || typeof event.user_login !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(event.user_login)) {
    throw new ApiError(400, "eventsub_event_invalid");
  }
}

function subscriptionPromptCommand(event:Record<string,unknown>):{prompt:string|null}|null{
  const message=event.message;
  const text=message&&typeof message==="object"&&!Array.isArray(message)
    ?(message as Record<string,unknown>).text:null;
  if(typeof text!=="string")return null;
  const normalized=text.trim();
  if(!/^!prompt(?:\s|$)/i.test(normalized))return null;
  const prompt=normalized.replace(/^!prompt(?:\s+|$)/i,"").trim();
  return {prompt:prompt.length>0&&prompt.length<=1000?prompt:null};
}

/**
 * Mount at POST /api/v1/webhooks/eventsub. No session, Origin header or JSON
 * middleware should run before this handler: Twitch authenticates raw bytes.
 */
export async function handleEventSubWebhook(request: Request): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(415, "content_type_required");
  const raw = await readRawBody(request);
  const receipt = verifyEventSubMessage(request, raw);
  const envelope = parseEnvelope(raw, request);
  if (receipt.messageType === "webhook_callback_verification") {
    if (typeof envelope.challenge !== "string" || envelope.challenge.length < 1 || envelope.challenge.length > 4096) throw new ApiError(400, "eventsub_challenge_invalid");
    if(envelope.subscription.type===BITS_EVENT_TYPE){
      await query(`INSERT INTO sloptogether.extension_bits_eventsub_subscriptions(extension_client_id,subscription_id,state)
        VALUES($1,$2,'enabled') ON CONFLICT(extension_client_id,subscription_id) DO UPDATE SET state='enabled',updated_at=now()`,
      [process.env.TWITCH_EXTENSION_CLIENT_ID,envelope.subscription.id]);
    }
    return new Response(envelope.challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(Buffer.byteLength(envelope.challenge)), "Cache-Control": "no-store" } });
  }
  if(envelope.subscription.type===BITS_EVENT_TYPE){
    if(receipt.messageType==="revocation"){
      await query(`INSERT INTO sloptogether.extension_bits_eventsub_subscriptions(extension_client_id,subscription_id,state)
        VALUES($1,$2,'revoked') ON CONFLICT(extension_client_id,subscription_id) DO UPDATE SET state='revoked',updated_at=now()`,
      [process.env.TWITCH_EXTENSION_CLIENT_ID,envelope.subscription.id]);
      return new Response(null,{status:204});
    }
    if(!envelope.event||typeof envelope.event!=="object"||Array.isArray(envelope.event))throw new ApiError(400,"extension_bits_event_invalid");
    await recordVerifiedExtensionBitsEvent(receipt.messageId,envelope.event);
    return new Response(null,{status:204});
  }
  const channelId = envelope.subscription.condition.broadcaster_user_id;
  if(!channelId)throw new ApiError(400,"eventsub_broadcaster_missing");
  const known = await query("SELECT 1 FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled=true", [channelId]);
  if (!known.rowCount) throw new ApiError(404, "eventsub_channel_not_found");
  if (receipt.messageType === "revocation") {
    await withEventSubLifecycleLock(channelId,async client=>transactionOnClient(client,async client=>{
      const channel=await client.query<{owner_twitch_user_id:string}>("SELECT owner_twitch_user_id FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE", [channelId]);
      const registrationKey=envelope.subscription.type===CHAT_EVENT_TYPE?"chat:"+channel.rows[0]?.owner_twitch_user_id:"subscriber-events";
      const registration=await client.query<{subscription_ids:string[]}>("SELECT subscription_ids FROM sloptogether.eventsub_config_fingerprints WHERE twitch_channel_id=$1 AND registration_key=$2 FOR UPDATE",[channelId,registrationKey]);
      const currentRegistration=registration.rows[0]?.subscription_ids.includes(envelope.subscription.id)??false;
      const receiptWritten = await client.query<{id:string}>(
        `INSERT INTO sloptogether.audit_log(twitch_channel_id,action,target_kind,target_id,reason,after_state,idempotency_key)
         VALUES($1,'eventsub.revoked','eventsub_subscription',$2,$3,$4::jsonb,$5)
         ON CONFLICT(twitch_channel_id,idempotency_key) DO NOTHING RETURNING id`,
        [channelId, envelope.subscription.id, String(envelope.subscription.status ?? "revoked").slice(0, 100), JSON.stringify({ type: envelope.subscription.type, currentRegistration }), "eventsub-revocation:" + receipt.messageId],
      );
      let fencedRevision:number|undefined;
      if(receiptWritten.rowCount&&currentRegistration&&envelope.subscription.type===CHAT_EVENT_TYPE){
        const updated=await client.query<{policy_revision:number}>("UPDATE sloptogether.channels SET chat_voting_enabled=false,policy_revision=policy_revision+1,updated_at=now() WHERE twitch_channel_id=$1 RETURNING policy_revision",[channelId]);
        fencedRevision=updated.rows[0]?.policy_revision;
      }
      if(receiptWritten.rowCount&&currentRegistration&&EVENT_TYPES.includes(envelope.subscription.type as SubscriptionEventType)){
        const updated=await client.query<{policy_revision:number}>("UPDATE sloptogether.channels SET subscriber_interrupt_policy=jsonb_set(subscriber_interrupt_policy,'{enabled}','false'::jsonb),policy_revision=policy_revision+1,updated_at=now() WHERE twitch_channel_id=$1 RETURNING policy_revision",[channelId]);
        fencedRevision=updated.rows[0]?.policy_revision;
        await cancelPendingInterrupts(client,channelId);
      }
      // Revocations remain a trust fence: record their revision for diagnosis,
      // but never carry trusted execution grants across them.
      if(fencedRevision!==undefined)await client.query("UPDATE sloptogether.audit_log SET policy_revision=$2 WHERE id=$1",[receiptWritten.rows[0]!.id,fencedRevision]);
      if(receiptWritten.rowCount&&currentRegistration)await deleteRegistrationFingerprint(client,channelId,registrationKey);
    }));
    return new Response(null, { status: 204 });
  }

  const event = envelope.event;
  if (!event || typeof event !== "object" || Array.isArray(event) || event.broadcaster_user_id !== channelId) throw new ApiError(403, "eventsub_broadcaster_mismatch");
  if(envelope.subscription.type===CHAT_EVENT_TYPE){
    const channel=await query<{chat_voting_enabled:boolean;owner_twitch_user_id:string}>("SELECT chat_voting_enabled,owner_twitch_user_id FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
    if(envelope.subscription.condition.user_id!==channel.rows[0]?.owner_twitch_user_id)throw new ApiError(403,"eventsub_chat_actor_mismatch");
    if(!channel.rows[0]?.chat_voting_enabled)return new Response(null,{status:204});
    const message=event.message as Record<string,unknown>|undefined;
    const text=message?.text;
    const chatter=event.chatter_user_id;
    const id=event.message_id;
    const match=typeof text==="string"&&text.length<=500? /^!slop\s+vote\s+([0-9a-f-]{36}|[1-9][0-9]?)\s*$/i.exec(text.trim()):null;
    if(match&&typeof chatter==="string"&&/^\d{1,32}$/.test(chatter)&&typeof id==="string"&&id.length<=256){
      const requested=match[1]!;
      const isChoiceId=uuidSchema.safeParse(requested).success;
      const isPosition=/^[1-9][0-9]?$/.test(requested);
      if(!isChoiceId&&!isPosition)return new Response(null,{status:204});
      let choiceId=requested;
      let electionId:string|null=null;
      if(isChoiceId){
        const election=await query<{id:string}>(`SELECT e.id FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id
          JOIN sloptogether.segments s ON s.id=e.segment_id JOIN sloptogether.branches br ON br.id=s.branch_id JOIN sloptogether.input_screens i ON i.id=p.input_screen_id
          WHERE p.id=$1 AND p.state='eligible' AND p.segment_revision_id IS NOT NULL AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
            AND s.twitch_channel_id=$2 AND br.stream_id=(SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$2 AND is_default) AND e.state='open' AND e.closes_at>now()
            AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL
              AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$2))`,[requested,channelId]);
        electionId=election.rows[0]?.id??null;
      }else{
        const election=await query<{id:string}>(`SELECT e.id FROM sloptogether.elections e JOIN sloptogether.segments s ON s.id=e.segment_id JOIN sloptogether.branches br ON br.id=s.branch_id
          WHERE s.twitch_channel_id=$1 AND br.stream_id=(SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default) AND e.state='open' AND e.closes_at>now() AND EXISTS(SELECT 1 FROM sloptogether.proposals p
            JOIN sloptogether.input_screens i ON i.id=p.input_screen_id WHERE p.election_id=e.id AND p.state='eligible' AND p.segment_revision_id IS NOT NULL
              AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
              AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL
                AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$1))) ORDER BY e.closes_at LIMIT 1`,[channelId]);
        electionId=election.rows[0]?.id??null;
      }
      if(!isChoiceId&&electionId){
        const position=Number(requested)-1;
        const choice=await query<{id:string}>(`SELECT p.id FROM sloptogether.proposals p JOIN sloptogether.input_screens i ON i.id=p.input_screen_id
          WHERE p.election_id=$1 AND p.state='eligible' AND p.segment_revision_id IS NOT NULL
            AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
            AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL
              AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$2))
          ORDER BY p.created_at,p.id OFFSET $3 LIMIT 1`,[electionId,channelId,position]);
        choiceId=choice.rows[0]?.id??"00000000-0000-0000-0000-000000000000";
      }
      if(electionId)try{await castBallot(electionId,choiceId,{kind:"chat",channelId,twitchUserId:chatter},"chat",id)}catch(error){
        if(!(error instanceof ApiError&&error.status<500))throw error;
      }
    }
    return new Response(null,{status:204});
  }
  validateSubscriptionEvent(envelope.subscription.type, event);
  if(envelope.subscription.type==="channel.subscription.message"){
    const command=subscriptionPromptCommand(event);
    if(command){
      const messageId=event.message_id;
      if(!command.prompt||typeof messageId!=="string"||messageId.length<1||messageId.length>256)return new Response(null,{status:204});
      try{
        const result=await submitResubPrompt(channelId,event.user_id as string,messageId,command.prompt,receipt.eventAt);
        if(result.handled)return new Response(null,{status:204});
      }catch(error){
        if(error instanceof ApiError&&error.status<500)return new Response(null,{status:204});
        throw error;
      }
    }
  }
  await admitSubscriptionEvent(channelId, envelope.subscription.type, event, receipt.messageId, receipt.eventAt);
  return new Response(null, { status: 204 });
}

async function admitSubscriptionEvent(channelId: string, type: SubscriptionEventType, event: Record<string, unknown>, messageId: string, eventAt: Date) {
  return transaction(async (client) => {
    const channels = await client.query<{ owner_twitch_user_id: string; subscriber_interrupt_policy: unknown; owner_budget_cap_usd: string; policy_revision: number; is_enabled: boolean }>(
      "SELECT owner_twitch_user_id,subscriber_interrupt_policy,owner_budget_cap_usd,policy_revision,is_enabled FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",
      [channelId],
    );
    const channel = channels.rows[0];
    if (!channel) throw new ApiError(404, "eventsub_channel_not_found");
    await cancelPendingInterrupts(client, channelId, true);
    const actor = event.is_anonymous === true ? null : typeof event.user_id === "string" && /^\d{1,32}$/.test(event.user_id) ? event.user_id : null;
    // Non-command resub chat text is deliberately omitted from planner input and receipts.
    const storedEvent = Object.fromEntries(["broadcaster_user_id", "user_id", "user_login", "user_name", "is_anonymous", "is_gift", "total", "tier", "cumulative_months"].filter((key) => key in event).map((key) => [key, event[key]]));
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sloptogether.subscription_events(twitch_message_id,event_type,broadcaster_twitch_id,twitch_actor_id,is_anonymous,event_payload,event_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(twitch_message_id) DO NOTHING RETURNING id`,
      [messageId, type, channelId, actor, event.is_anonymous === true, JSON.stringify(storedEvent), eventAt],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) return { duplicate: true };
    const settings = settingsFrom(channel.subscriber_interrupt_policy);
    const quote = reservationUsd("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD");
    let ignoredReason: string | null = null;
    if (!channel.is_enabled || !eligibleEvent(type, event, settings)) ignoredReason = "feature_or_event_disabled";
    else if (eventAt.getTime() + settings.eventMaxAgeSeconds * 1000 <= Date.now()) ignoredReason = "event_expired";
    else if (!await ownerAuthorized(client, channel.owner_twitch_user_id)) ignoredReason = "subscription_authorization_missing";
    else if (quote === null) ignoredReason = "render_quote_unavailable";
    if (!ignoredReason) {
      const banned = await client.query(
        `SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=ANY($1::text[]) AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at>now()) AND (scope='global' OR twitch_channel_id=$2) LIMIT 1`,
        [[channel.owner_twitch_user_id, ...(actor ? [actor] : [])], channelId],
      );
      if (banned.rowCount) ignoredReason = "ban_active";
    }
    const capacity = await client.query<{ pending_count: string; last_created_at: Date | null }>(
      `SELECT count(*) FILTER(WHERE program_state=ANY($2::text[]) AND expires_at>now())::text AS pending_count,
       max(created_at) AS last_created_at FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1`,
      [channelId, ACTIVE_INTERRUPT_STATES],
    );
    const last = capacity.rows[0];
    if (!ignoredReason && Number(last?.pending_count ?? 0) >= MAX_PENDING_INTERRUPTS) ignoredReason = "queue_full";
    if (!ignoredReason && last?.last_created_at && last.last_created_at.getTime() + settings.minimumGapSeconds * 1000 > Date.now()) ignoredReason = "minimum_gap";
    if (!ignoredReason && quote !== null) {
      const spending = await client.query<{ hourly: string; total: string }>(
        `SELECT coalesce(sum(greatest(f.reserved_usd,coalesce(f.actual_cost_usd,0))) FILTER(WHERE f.created_at>now()-interval '1 hour'
           AND EXISTS(SELECT 1 FROM sloptogether.interrupt_requests i WHERE i.funding_id=f.id)),0)::text AS hourly,
         coalesce(sum(greatest(f.reserved_usd,coalesce(f.actual_cost_usd,0))),0)::text AS total
         FROM sloptogether.funding_authorizations f WHERE f.twitch_channel_id=$1 AND f.source='owner_budget' AND f.state<>'released'`,
        [channelId],
      );
      if (Number(spending.rows[0]?.hourly ?? 0) + quote > settings.hourlySpendCapUsd + 0.000001) ignoredReason = "hourly_spend_cap";
      if (Number(spending.rows[0]?.total ?? 0) + quote > Number(channel.owner_budget_cap_usd) + 0.000001) ignoredReason = "owner_budget_cap";
    }
    if (ignoredReason || quote === null) {
      await client.query("UPDATE sloptogether.subscription_events SET state=$2 WHERE id=$1", [eventId, ignoredReason === "event_expired" ? "expired" : "ignored"]);
      await client.query(
        `INSERT INTO sloptogether.audit_log(twitch_channel_id,action,target_kind,target_id,reason,after_state,idempotency_key)
         VALUES($1,'subscriber_interrupt.not_queued','subscription_event',$2,$3,$4::jsonb,$5)`,
        [channelId, eventId, ignoredReason ?? "render_quote_unavailable", JSON.stringify({ fallback: settings.fallback }), "subscriber-event:" + messageId],
      );
      return { queued: false, reason: ignoredReason };
    }
    const interruptId = randomUUID();
    const funding = await client.query<{ id: string }>(
      `INSERT INTO sloptogether.funding_authorizations(twitch_channel_id,source,purchaser_twitch_user_id,action_intent_id,reserved_usd,state)
       VALUES($1,'owner_budget',$2,$3,$4,'reserved') RETURNING id`,
      [channelId, channel.owner_twitch_user_id, interruptId, quote],
    );
    const label = subscriberLabel(event);
    const expiresAt = new Date(eventAt.getTime() + settings.eventMaxAgeSeconds * 1000);
    const planPayload = { kind: "subscriber_interrupt", policyRevision: channel.policy_revision, eventType: type, subscriberLabel: label, giftCount: type === "channel.subscription.gift" && typeof event.total === "number" ? Math.max(1, Math.min(1000, Math.trunc(event.total))) : null, requireAudio: true, durationSeconds: 10, frameCount: 243, reservationUsd: quote };
    await client.query(
      `INSERT INTO sloptogether.interrupt_requests(id,broadcaster_twitch_id,trigger_event_id,idempotency_key,subscriber_label,plan_payload,program_state,funding_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,'queued',$7,$8)`,
      [interruptId, channelId, eventId, "subscriber-event:" + messageId, label, JSON.stringify(planPayload), funding.rows[0]!.id, expiresAt],
    );
    await client.query("UPDATE sloptogether.subscription_events SET state='queued',interrupt_id=$2 WHERE id=$1", [eventId, interruptId]);
    await client.query(
      `INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key)
       VALUES('subscriber_interrupt.plan',$1,$2::jsonb,$3)`,
      [interruptId, JSON.stringify({ channelId, interruptId, eventId, fundingId: funding.rows[0]!.id, policyRevision: channel.policy_revision, expiresAt: expiresAt.toISOString() }), "subscriber-plan:" + messageId],
    );
    await client.query(
      `INSERT INTO sloptogether.audit_log(twitch_channel_id,action,target_kind,target_id,policy_revision,after_state,idempotency_key)
       VALUES($1,'subscriber_interrupt.queued','interrupt_request',$2,$3,$4::jsonb,$5)`,
      [channelId, interruptId, channel.policy_revision, JSON.stringify({ eventId, fundingId: funding.rows[0]!.id, reservationUsd: quote }), "subscriber-event:" + messageId],
    );
    return { queued: true, interruptId };
  });
}
