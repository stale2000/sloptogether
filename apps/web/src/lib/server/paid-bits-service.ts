import "server-only";

import { createHash,randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction,query } from "./db";
import { ApiError,readJson } from "./http";
import { constantTimeEqual } from "./crypto";
import { findChannel,isBanned } from "./channels";
import { verifyExtensionBitsReceipt,verifyExtensionRequest } from "./extension-auth";
import { getExtensionTransaction,listExtensionBitsProducts,twitchExtensionClientId } from "./twitch";
import { bitsReconcileEndpointMatchesApp,bitsTransactionMatchesReceiptTarget } from "../bits-reconciliation";

// Keep the paid product implementation, but never expose or dispatch it.
const PAID_TURBO_ENABLED = process.env.NODE_ENV === "test";

const productsSchema=z.array(z.object({
  sku:z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
  amountBits:z.number().int().min(1).max(10_000),
  resolution:z.enum(["480P","768P","1080P"]),
  reservedUsd:z.number().min(0.0001).max(500),
}).strict()).min(1).max(20);
const dispatchSnapshotSchema=z.object({
  schemaVersion:z.literal(1),channelId:z.string().regex(/^[0-9]{1,32}$/),policyRevision:z.number().int().positive(),
  segmentId:z.string().uuid(),segmentRevisionId:z.string().uuid(),prompt:z.string().min(1).max(6000),
  input:z.object({screenId:z.string().uuid(),screenSha256:z.string().regex(/^[a-f0-9]{64}$/),revisionSha256:z.string().regex(/^[a-f0-9]{64}$/),
    moderationModel:z.string().min(1).max(128),moderationPolicyRevision:z.number().int().positive()}).strict(),
  start:z.object({boundaryRevisionId:z.string().uuid(),assetId:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  end:z.object({boundaryRevisionId:z.string().uuid(),assetId:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable(),
  dependencyResolutionId:z.string().uuid().nullable(),resolution:z.enum(["480P","768P","1080P"]),durationSeconds:z.literal(15),
  promptExpansionMode:z.literal("disabled"),enableSafetyChecker:z.literal(true),syncMode:z.literal(false),recipeSha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const reconcileReceiptSchema=z.object({intentId:z.string().uuid(),outboxId:z.string().regex(/^[0-9]{1,20}$/),leaseUntil:z.string().datetime()}).strict();
const receiptReconcileGraceMs=10*60_000;
const receiptReconcileStates=["receipt_seen","expired","cancelled","receipt_unverified"] as const;

function configuredProducts(){
  if(!PAID_TURBO_ENABLED||process.env.SLOPTOGETHER_BITS_TURBO_ENABLED!=="true"||process.env.SLOPTOGETHER_BITS_POLICY_APPROVED!=="true"
    ||process.env.SLOPTOGETHER_BITS_EVENTSUB_READY!=="true"||process.env.SLOPTOGETHER_BITS_DISPATCH_READY!=="true")
    throw new ApiError(503,"bits_turbo_unavailable","Paid Turbo is disabled until its fixed Extension product and Twitch review are approved.");
  if((process.env.SLOPTOGETHER_BITS_RECONCILE_SECRET??"").length<32)throw new ApiError(503,"bits_reconciliation_not_configured");
  if(!bitsReconcileEndpointMatchesApp(process.env.SLOPTOGETHER_BITS_RECONCILE_URL,process.env.PUBLIC_APP_URL))
    throw new ApiError(503,"bits_reconciliation_not_configured");
  try{return productsSchema.parse(JSON.parse(process.env.SLOPTOGETHER_BITS_TURBO_PRODUCTS_JSON??""));}
  catch{throw new ApiError(503,"bits_catalog_not_configured");}
}

async function availableProducts(){
  const configured=configuredProducts();
  const extensionId=twitchExtensionClientId();
  const subscription=await query(`SELECT 1 FROM sloptogether.extension_bits_eventsub_subscriptions
    WHERE extension_client_id=$1 AND state='enabled' LIMIT 1`,[extensionId]);
  if(!subscription.rowCount)throw new ApiError(503,"bits_eventsub_unavailable","Paid Turbo is paused until its transaction subscription is verified.");
  const catalog=await listExtensionBitsProducts();
  return configured.flatMap(product=>{
    const actual=catalog.find(row=>row.sku===product.sku&&row.amountBits===product.amountBits&&!row.inDevelopment);
    return actual?[{...product,displayName:actual.displayName}]:[];
  });
}

async function lockActiveBitsEventSub(client:PoolClient){
  const subscription=await client.query(`SELECT subscription_id FROM sloptogether.extension_bits_eventsub_subscriptions
    WHERE extension_client_id=$1 AND state='enabled' FOR SHARE`,[twitchExtensionClientId()]);
  if(!subscription.rowCount)throw new ApiError(503,"bits_eventsub_unavailable","Paid Turbo is paused until its transaction subscription is verified.");
}

function falRecipeHash(resolution:string){
  return createHash("sha256").update(["fal/minimax/h3-max-turbo/image-to-video","duration=15",`resolution=${resolution}`,"prompt_expansion_mode=disabled","enable_safety_checker=true","schema-v1"].join("\n")).digest();
}

function canonicalJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).sort(([left],[right])=>left<right?-1:left>right?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}

function dispatchSnapshotHash(snapshot:unknown){
  return createHash("sha256").update(canonicalJson(snapshot)).digest();
}

type VerifiedBitsRecord={transaction_id:string;broadcaster_twitch_id:string;purchaser_twitch_user_id:string;product_sku:string;amount_bits:number;
  occurred_at:Date;is_in_development:boolean;extension_client_id:string;state:string};

async function markBitsTransactionUnallocated(client:PoolClient,transactionId:string,reason:string){
  await client.query("UPDATE sloptogether.extension_bits_transactions SET state='verified_unallocated',settlement_state='pending',processed_at=now() WHERE transaction_id=$1",[transactionId]);
  await client.query(`UPDATE sloptogether.paid_action_intents SET state='verified_unallocated',state_reason=$2,updated_at=now()
    WHERE receipt_transaction_id=$1 AND state=ANY($3::text[])`,[transactionId,reason,[...receiptReconcileStates]]);
}

async function fulfillVerifiedBitsTransaction(client:PoolClient,tx:VerifiedBitsRecord){
  if(tx.is_in_development){
    const intent=await client.query("SELECT id FROM sloptogether.paid_action_intents WHERE twitch_channel_id=$1 AND twitch_user_id=$2 AND product_sku=$3 AND state IN ('intent_open','receipt_seen') AND purchase_window_started_at<=$4 AND expires_at>=$4 ORDER BY created_at LIMIT 2 FOR UPDATE",
      [tx.broadcaster_twitch_id,tx.purchaser_twitch_user_id,tx.product_sku,tx.occurred_at]);
    const intentId=intent.rows.length===1?intent.rows[0]!.id:null;
    if(intentId)await client.query("UPDATE sloptogether.paid_action_intents SET state='cancelled',receipt_transaction_id=$2,receipt_timestamp=$3,state_reason='development_transaction',updated_at=now() WHERE id=$1",[intentId,tx.transaction_id,tx.occurred_at]);
    await client.query("UPDATE sloptogether.extension_bits_transactions SET state='development_ignored',settlement_state='development_ignored',intent_id=$2,processed_at=now() WHERE transaction_id=$1",[tx.transaction_id,intentId]);
    return {state:"development_ignored"};
  }
  const matches=await client.query(`SELECT * FROM sloptogether.paid_action_intents
    WHERE twitch_channel_id=$1 AND twitch_user_id=$2 AND product_sku=$3
      AND (receipt_transaction_id IS NULL OR receipt_transaction_id=$4)
      AND purchase_window_started_at<=$5 AND expires_at>=$5
      AND state IN ('intent_open','receipt_seen','expired','cancelled','paid_unfulfilled','receipt_unverified')
    ORDER BY created_at LIMIT 2 FOR UPDATE`,[tx.broadcaster_twitch_id,tx.purchaser_twitch_user_id,tx.product_sku,tx.transaction_id,tx.occurred_at]);
  if(matches.rows.length!==1){
    await markBitsTransactionUnallocated(client,tx.transaction_id,"transaction_target_ambiguous_or_missing");
    return {state:"verified_unallocated"};
  }
  const intent=matches.rows[0];
  if(intent.extension_client_id!==tx.extension_client_id||intent.amount_bits!==tx.amount_bits){
    await markBitsTransactionUnallocated(client,tx.transaction_id,"transaction_product_or_extension_mismatch");
    return {state:"verified_unallocated"};
  }
  const parsedSnapshot=dispatchSnapshotSchema.safeParse(intent.dispatch_snapshot);
  if(!parsedSnapshot.success||!Buffer.isBuffer(intent.dispatch_snapshot_sha256)
    ||!dispatchSnapshotHash(parsedSnapshot.data).equals(intent.dispatch_snapshot_sha256)){
    await client.query(`INSERT INTO sloptogether.funding_authorizations(twitch_channel_id,source,twitch_transaction_id,purchaser_twitch_user_id,paid_action_intent_id,amount_bits,reserved_usd,state,consumed_at,settled_at)
      VALUES($1,'twitch_extension_bits',$2,$3,$4,$5,$6,'paid_unfulfilled',now(),now()) ON CONFLICT(twitch_transaction_id) DO NOTHING`,
      [tx.broadcaster_twitch_id,tx.transaction_id,tx.purchaser_twitch_user_id,intent.id,tx.amount_bits,intent.reserved_usd]);
    await client.query("UPDATE sloptogether.paid_action_intents SET state='paid_unfulfilled',receipt_transaction_id=$2,receipt_timestamp=$3,state_reason='dispatch_snapshot_missing_or_invalid',updated_at=now() WHERE id=$1",[intent.id,tx.transaction_id,tx.occurred_at]);
    await client.query("UPDATE sloptogether.extension_bits_transactions SET state='paid_unfulfilled',processed_at=now() WHERE transaction_id=$1",[tx.transaction_id]);
    return {state:"paid_unfulfilled"};
  }
  const snapshot=parsedSnapshot.data;
  await client.query("UPDATE sloptogether.extension_bits_transactions SET intent_id=$2 WHERE transaction_id=$1",[tx.transaction_id,intent.id]);
  if(intent.receipt_transaction_id&&intent.receipt_transaction_id!==tx.transaction_id){
    await markBitsTransactionUnallocated(client,tx.transaction_id,"transaction_intent_binding_mismatch");
    return {state:"verified_unallocated"};
  }
  if(!PAID_TURBO_ENABLED||["expired","cancelled","paid_unfulfilled"].includes(intent.state)||process.env.SLOPTOGETHER_BITS_TURBO_ENABLED!=="true"
    ||process.env.SLOPTOGETHER_BITS_POLICY_APPROVED!=="true"||process.env.SLOPTOGETHER_BITS_EVENTSUB_READY!=="true"
    ||process.env.SLOPTOGETHER_BITS_DISPATCH_READY!=="true"){
    await client.query(`INSERT INTO sloptogether.funding_authorizations(twitch_channel_id,source,twitch_transaction_id,purchaser_twitch_user_id,paid_action_intent_id,amount_bits,reserved_usd,state,consumed_at,settled_at)
      VALUES($1,'twitch_extension_bits',$2,$3,$4,$5,$6,'paid_unfulfilled',now(),now()) ON CONFLICT(twitch_transaction_id) DO NOTHING`,
      [tx.broadcaster_twitch_id,tx.transaction_id,tx.purchaser_twitch_user_id,intent.id,tx.amount_bits,intent.reserved_usd]);
    await client.query("UPDATE sloptogether.paid_action_intents SET state='paid_unfulfilled',receipt_transaction_id=$2,receipt_timestamp=$3,state_reason='action_or_dispatch_no_longer_eligible',updated_at=now() WHERE id=$1",[intent.id,tx.transaction_id,tx.occurred_at]);
    await client.query("UPDATE sloptogether.extension_bits_transactions SET state='paid_unfulfilled',processed_at=now() WHERE transaction_id=$1",[tx.transaction_id]);
    return {state:"paid_unfulfilled"};
  }
  const channel=await client.query<{policy_revision:number;is_enabled:boolean;visibility:string}>(
    "SELECT policy_revision,is_enabled,visibility FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[tx.broadcaster_twitch_id]);
  const current=await client.query<{selected_revision_id:string|null;state:string;input_sha256:Buffer;screen_sha256:Buffer;start_boundary_id:string;start_asset_id:string;start_sha256:Buffer;end_boundary_id:string|null;end_asset_id:string|null;end_sha256:Buffer|null;screen_clear:boolean;committed:boolean;active_render:boolean}>(
    `SELECT s.selected_revision_id,s.state,r.input_sha256,i.input_sha256 AS screen_sha256,
       r.start_boundary_revision_id AS start_boundary_id,sb.asset_id AS start_asset_id,sa.sha256 AS start_sha256,
       r.requested_end_boundary_revision_id AS end_boundary_id,eb.asset_id AS end_asset_id,ea.sha256 AS end_sha256,
       (i.id IS NOT NULL AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now()) AND
        (EXISTS(SELECT 1 FROM sloptogether.proposals p WHERE p.segment_revision_id=r.id AND p.input_screen_id=i.id) OR
         EXISTS(SELECT 1 FROM sloptogether.jobs j WHERE j.segment_revision_id=r.id AND j.planning_payload->>'inputScreenId'=i.id::text) OR
         EXISTS(SELECT 1 FROM sloptogether.story_plan_attempts spa WHERE spa.resulting_segment_id=s.id AND spa.screen_id=i.id AND spa.compiled_prompt=r.prompt))) AS screen_clear,
       EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL) AS committed,
       EXISTS(SELECT 1 FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id WHERE j.segment_revision_id=r.id
         AND j.stage='video_base' AND a.state IN ('leased','running','uploaded','validating')) AS active_render
     FROM sloptogether.segments s JOIN sloptogether.branches b ON b.id=s.branch_id AND b.stream_id=(SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$4 AND is_default) AND b.is_selected AND b.archived_at IS NULL
     JOIN sloptogether.segment_revisions r ON r.segment_id=s.id AND r.id=$2
     JOIN sloptogether.input_screens i ON i.id=$3 AND i.twitch_channel_id=s.twitch_channel_id
     JOIN sloptogether.boundary_revisions sb ON sb.id=r.start_boundary_revision_id AND sb.retired_at IS NULL
     JOIN sloptogether.assets sa ON sa.id=sb.asset_id AND sa.status IN ('approved','published') AND sa.media_kind='image'
     LEFT JOIN sloptogether.boundary_revisions eb ON eb.id=r.requested_end_boundary_revision_id AND eb.retired_at IS NULL
     LEFT JOIN sloptogether.assets ea ON ea.id=eb.asset_id AND ea.status IN ('approved','published') AND ea.media_kind='image'
     WHERE s.id=$1 AND s.twitch_channel_id=$4 FOR UPDATE OF s,r,i`,[intent.segment_id,intent.segment_revision_id,intent.input_screen_id,tx.broadcaster_twitch_id]);
  const scene=current.rows[0],channelRow=channel.rows[0];
  const eligible=Boolean(channelRow?.is_enabled&&channelRow.visibility!=="private"&&channelRow.policy_revision===intent.policy_revision
    &&scene&&scene.selected_revision_id===intent.segment_revision_id&&scene.screen_clear&&scene.input_sha256.equals(intent.input_sha256)
    &&snapshot.channelId===tx.broadcaster_twitch_id&&snapshot.segmentId===intent.segment_id&&snapshot.segmentRevisionId===intent.segment_revision_id
    &&snapshot.input.revisionSha256===intent.input_sha256.toString("hex")
    &&scene.start_boundary_id===snapshot.start.boundaryRevisionId&&scene.start_asset_id===snapshot.start.assetId
    &&Buffer.isBuffer(scene.start_sha256)&&scene.start_sha256.equals(Buffer.from(snapshot.start.sha256,"hex"))
    &&Buffer.isBuffer(scene.screen_sha256)&&scene.screen_sha256.equals(Buffer.from(snapshot.input.screenSha256,"hex"))
    &&scene.end_boundary_id===(snapshot.end?.boundaryRevisionId??null)
    &&scene.end_asset_id===(snapshot.end?.assetId??null)
    &&(scene.end_sha256===null?snapshot.end===null:Buffer.isBuffer(scene.end_sha256)&&scene.end_sha256.equals(Buffer.from(snapshot.end!.sha256,"hex")))
    &&!scene.committed&&!scene.active_render&&!["played","retired"].includes(scene.state));
  if(!eligible){
    await client.query(`INSERT INTO sloptogether.funding_authorizations(twitch_channel_id,source,twitch_transaction_id,purchaser_twitch_user_id,paid_action_intent_id,amount_bits,reserved_usd,state,consumed_at,settled_at)
      VALUES($1,'twitch_extension_bits',$2,$3,$4,$5,$6,'paid_unfulfilled',now(),now()) ON CONFLICT(twitch_transaction_id) DO NOTHING`,
      [tx.broadcaster_twitch_id,tx.transaction_id,tx.purchaser_twitch_user_id,intent.id,tx.amount_bits,intent.reserved_usd]);
    await client.query("UPDATE sloptogether.paid_action_intents SET state='paid_unfulfilled',receipt_transaction_id=$2,receipt_timestamp=$3,state_reason='target_or_policy_no_longer_eligible',updated_at=now() WHERE id=$1",[intent.id,tx.transaction_id,tx.occurred_at]);
    await client.query("UPDATE sloptogether.extension_bits_transactions SET state='paid_unfulfilled',processed_at=now() WHERE transaction_id=$1",[tx.transaction_id]);
    return {state:"paid_unfulfilled"};
  }
  await client.query(`UPDATE sloptogether.job_attempts a SET state='cancelled',fence=fence+1,lease_expires_at=now(),finished_at=now(),error_code='paid_turbo_reserved'
    FROM sloptogether.jobs j WHERE a.job_id=j.id AND j.segment_revision_id=$1 AND j.stage='video_base' AND j.execution_mode='pull_worker'
      AND j.state='ready' AND a.state='ready' AND a.claimed_at IS NULL`,[intent.segment_revision_id]);
  await client.query("UPDATE sloptogether.jobs SET state='cancelled',cancelled_at=now() WHERE segment_revision_id=$1 AND stage='video_base' AND execution_mode='pull_worker' AND state='ready'",[intent.segment_revision_id]);
  await client.query("UPDATE sloptogether.funding_authorizations SET state='released',settled_at=now() WHERE id IN (SELECT funding_id FROM sloptogether.jobs WHERE segment_revision_id=$1 AND stage='video_base' AND state='cancelled') AND source='owner_budget' AND state='reserved'",[intent.segment_revision_id]);
  const funding=await client.query<{id:string}>(`INSERT INTO sloptogether.funding_authorizations(twitch_channel_id,source,twitch_transaction_id,purchaser_twitch_user_id,paid_action_intent_id,amount_bits,reserved_usd,state)
    VALUES($1,'twitch_extension_bits',$2,$3,$4,$5,$6,'reserved') RETURNING id`,
    [tx.broadcaster_twitch_id,tx.transaction_id,tx.purchaser_twitch_user_id,intent.id,tx.amount_bits,intent.reserved_usd]);
  const jobId=randomUUID(),attemptId=randomUUID(),dispatchId=randomUUID(),recipeId=`fal/minimax/h3-max-turbo-${intent.resolution.toLowerCase()}`;
  const planningPayload={inputScreenId:intent.input_screen_id,dispatchSnapshotHash:intent.dispatch_snapshot_sha256.toString("hex")};
  await client.query(`INSERT INTO sloptogether.jobs(id,twitch_channel_id,segment_revision_id,stage,execution_mode,state,recipe_id,recipe_sha256,input_sha256,requested_by,funding_id,dependency_resolution_id,planning_payload,priority,result_deadline_at)
    VALUES($1,$2,$3,'video_base','provider_queue','ready',$4,$5,$6,$7,$8,$9,$10::jsonb,100,now()+interval '45 minutes')`,
    [jobId,tx.broadcaster_twitch_id,intent.segment_revision_id,recipeId,falRecipeHash(intent.resolution),intent.input_sha256,tx.purchaser_twitch_user_id,funding.rows[0]!.id,snapshot.dependencyResolutionId,JSON.stringify(planningPayload)]);
  await client.query(`INSERT INTO sloptogether.job_attempts(id,job_id,attempt_number,fence,client_idempotency_key,state,attempt_deadline_at,input_sha256,funding_id)
    VALUES($1,$2,1,1,$3,'ready',now()+interval '45 minutes',$4,$5)`,[attemptId,jobId,`job:${jobId}:attempt:1`,intent.input_sha256,funding.rows[0]!.id]);
  if(snapshot.dependencyResolutionId)await client.query("INSERT INTO sloptogether.endpoint_resolution_dependencies(resolution_id,dependent_job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[snapshot.dependencyResolutionId,jobId]);
  await client.query("INSERT INTO sloptogether.paid_turbo_dispatches(id,intent_id,job_id,attempt_id,snapshot_sha256,state) VALUES($1,$2,$3,$4,$5,'ready')",
    [dispatchId,intent.id,jobId,attemptId,intent.dispatch_snapshot_sha256]);
  await client.query("UPDATE sloptogether.paid_action_intents SET state='reserved',receipt_transaction_id=$2,receipt_timestamp=$3,updated_at=now() WHERE id=$1",[intent.id,tx.transaction_id,tx.occurred_at]);
  await client.query("UPDATE sloptogether.extension_bits_transactions SET intent_id=$2,state='reserved',settlement_state='reserved',processed_at=now() WHERE transaction_id=$1",[tx.transaction_id,intent.id]);
  await client.query("UPDATE sloptogether.segments SET state='rendering',protected_at=coalesce(protected_at,now()) WHERE id=$1 AND selected_revision_id=$2",[intent.segment_id,intent.segment_revision_id]);
  await client.query("INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key) VALUES('paid.turbo.dispatch',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING",
    [jobId,JSON.stringify({jobId,intentId:intent.id,transactionId:tx.transaction_id}),`paid-turbo:${tx.transaction_id}`]);
  await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'bits.action.reserved','paid_action_intent',$3,$4::jsonb)",
    [tx.broadcaster_twitch_id,tx.purchaser_twitch_user_id,intent.id,JSON.stringify({transactionId:tx.transaction_id,jobId,sku:tx.product_sku,bits:tx.amount_bits,resolution:intent.resolution})]);
  return {state:"reserved",jobId};
}

export async function getExtensionBitsState(request:Request){
  const principal=verifyExtensionRequest(request);
  if(!PAID_TURBO_ENABLED)return {enabled:false,products:[],target:null,requiresLinkedIdentity:false};
  if(!principal.linkedTwitchUserId||await isBanned(principal.channelId,principal.linkedTwitchUserId))
    return {enabled:false,products:[],target:null,requiresLinkedIdentity:true};
  const products=await availableProducts();
  if(!products.length)return {enabled:false,products:[],target:null,requiresLinkedIdentity:false};
  const channel=await findChannel(principal.channelId);
  const target=await query<{segment_id:string;revision_id:string;prompt:string;input_screen_id:string}>(
    "SELECT s.id AS segment_id,r.id AS revision_id,r.prompt,"+
    "(SELECT i.id FROM sloptogether.input_screens i WHERE i.twitch_channel_id=s.twitch_channel_id "+
    " AND (EXISTS(SELECT 1 FROM sloptogether.proposals p WHERE p.segment_revision_id=r.id AND p.input_screen_id=i.id) "+
    " OR EXISTS(SELECT 1 FROM sloptogether.jobs j WHERE j.segment_revision_id=r.id AND j.planning_payload->>'inputScreenId'=i.id::text) "+
    " OR EXISTS(SELECT 1 FROM sloptogether.story_plan_attempts spa WHERE spa.resulting_segment_id=s.id AND spa.screen_id=i.id AND spa.compiled_prompt=r.prompt)) "+
    " AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now()) ORDER BY i.created_at DESC LIMIT 1) AS input_screen_id "+
    "FROM sloptogether.branches b JOIN sloptogether.segments s ON s.branch_id=b.id "+
    "JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id "+
    "WHERE b.twitch_channel_id=$1 AND b.stream_id=(SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default) AND b.is_selected AND b.archived_at IS NULL "+
    " AND s.state IN ('selected','locked','rendering','ready') "+
    " AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL) "+
    " AND NOT EXISTS(SELECT 1 FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id "+
    "   WHERE j.segment_revision_id=r.id AND j.stage='video_base' AND a.state IN ('leased','running','uploaded','validating')) "+
    " AND NOT EXISTS(SELECT 1 FROM sloptogether.paid_action_intents p WHERE p.segment_revision_id=r.id AND p.state IN ('intent_open','receipt_seen','receipt_unverified','verified_unallocated','reserved','dispatching','consumed_uncertain')) "+
    "ORDER BY s.ordinal LIMIT 1",[channel.twitch_channel_id]);
  const row=target.rows[0];
  if(!row?.input_screen_id)return {enabled:false,products:[],target:null,requiresLinkedIdentity:false};
  return {enabled:true,products:products.map(({sku,amountBits,resolution,displayName})=>({sku,amountBits,resolution,displayName})),
    target:{segmentId:row.segment_id,segmentRevisionId:row.revision_id,promptPreview:row.prompt.slice(0,180)}};
}

export async function createExtensionBitsIntent(request:Request){
  const principal=verifyExtensionRequest(request);
  if(!PAID_TURBO_ENABLED)throw new ApiError(503,"bits_action_unavailable","This option is currently unavailable.");
  const actor=principal.linkedTwitchUserId;
  if(!actor)throw new ApiError(409,"bits_identity_share_required","Share your Twitch identity before using this product.");
  if(await isBanned(principal.channelId,actor))throw new ApiError(403,"channel_ban_active");
  const body=await readJson(request,z.object({sku:z.string().trim().min(1).max(255)}).strict());
  const product=(await availableProducts()).find(row=>row.sku===body.sku);
  if(!product)throw new ApiError(409,"bits_product_unavailable");
  const channel=await findChannel(principal.channelId);
  return transaction(async client=>{
    await lockActiveBitsEventSub(client);
    const locked=await client.query("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled AND visibility<>'private' FOR UPDATE",[channel.twitch_channel_id]);
    if(!locked.rowCount||Number(locked.rows[0]!.policy_revision)!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    await client.query("UPDATE sloptogether.paid_action_intents SET state='expired',state_reason='purchase_window_elapsed',updated_at=now() WHERE twitch_channel_id=$1 AND state IN ('intent_open','receipt_seen') AND expires_at<=now()",[channel.twitch_channel_id]);
    const recent=await client.query<{count:string}>("SELECT count(*)::text AS count FROM sloptogether.paid_action_intents WHERE twitch_channel_id=$1 AND twitch_user_id=$2 AND created_at>now()-interval '10 minutes'",[channel.twitch_channel_id,actor]);
    if(Number(recent.rows[0]?.count??0)>=3)throw new ApiError(429,"bits_intent_rate_limited","Try again after the current purchase window ends.");
    const candidate=await client.query(`SELECT s.id AS segment_id,r.id AS revision_id,r.prompt,r.input_sha256,
        r.start_boundary_revision_id,r.requested_end_boundary_revision_id,i.id AS input_screen_id,i.input_sha256 AS screen_sha256,
        i.moderation_model,i.moderation_policy_revision,sa.id AS start_asset_id,sa.sha256 AS start_sha256,
        ea.id AS end_asset_id,ea.sha256 AS end_sha256,dependency.id AS dependency_resolution_id
      FROM sloptogether.branches b JOIN sloptogether.segments s ON s.branch_id=b.id
      JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
      JOIN sloptogether.boundary_revisions sb ON sb.id=r.start_boundary_revision_id AND sb.retired_at IS NULL
      JOIN sloptogether.assets sa ON sa.id=sb.asset_id AND sa.status IN ('approved','published') AND sa.media_kind='image'
      LEFT JOIN sloptogether.boundary_revisions eb ON eb.id=r.requested_end_boundary_revision_id AND eb.retired_at IS NULL
      LEFT JOIN sloptogether.assets ea ON ea.id=eb.asset_id AND ea.status IN ('approved','published') AND ea.media_kind='image'
      LEFT JOIN LATERAL(SELECT id FROM sloptogether.endpoint_resolutions WHERE resolved_end_boundary_revision_id=sb.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) dependency ON true
      JOIN LATERAL(SELECT i.id,i.input_sha256,i.moderation_model,i.moderation_policy_revision FROM sloptogether.input_screens i
        WHERE i.twitch_channel_id=s.twitch_channel_id AND i.effective_state='clear' AND (i.expires_at IS NULL OR i.expires_at>now())
          AND (EXISTS(SELECT 1 FROM sloptogether.proposals p WHERE p.segment_revision_id=r.id AND p.input_screen_id=i.id)
            OR EXISTS(SELECT 1 FROM sloptogether.jobs j WHERE j.segment_revision_id=r.id AND j.planning_payload->>'inputScreenId'=i.id::text)
            OR EXISTS(SELECT 1 FROM sloptogether.story_plan_attempts spa WHERE spa.resulting_segment_id=s.id AND spa.screen_id=i.id AND spa.compiled_prompt=r.prompt))
        ORDER BY i.created_at DESC LIMIT 1) i ON true
      WHERE b.twitch_channel_id=$1 AND b.stream_id=(SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default) AND b.is_selected AND b.archived_at IS NULL AND s.state IN ('selected','locked','rendering','ready')
        AND sa.sha256 IS NOT NULL AND (r.requested_end_boundary_revision_id IS NULL OR ea.id IS NOT NULL AND ea.sha256 IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM sloptogether.job_attempts a JOIN sloptogether.jobs j ON j.id=a.job_id
          WHERE j.segment_revision_id=r.id AND j.stage='video_base' AND a.state IN ('leased','running','uploaded','validating'))
        AND NOT EXISTS(SELECT 1 FROM sloptogether.paid_action_intents p WHERE p.segment_revision_id=r.id
          AND p.state IN ('intent_open','receipt_seen','receipt_unverified','verified_unallocated','reserved','dispatching','consumed_uncertain'))
      ORDER BY s.ordinal LIMIT 1 FOR UPDATE OF s,r,sb,sa`,
      [channel.twitch_channel_id]);
    const row=candidate.rows[0];
    if(!row)throw new ApiError(409,"turbo_target_not_ready","There is no selected scene eligible for the fixed Turbo product.");
    const id=randomUUID(),expiresAt=new Date(Date.now()+60_000);
    const snapshot={schemaVersion:1,channelId:channel.twitch_channel_id,policyRevision:channel.policy_revision,segmentId:row.segment_id,
      segmentRevisionId:row.revision_id,prompt:row.prompt,input:{screenId:row.input_screen_id,screenSha256:row.screen_sha256.toString("hex"),
        revisionSha256:row.input_sha256.toString("hex"),moderationModel:row.moderation_model,moderationPolicyRevision:row.moderation_policy_revision},
      start:{boundaryRevisionId:row.start_boundary_revision_id,assetId:row.start_asset_id,sha256:row.start_sha256.toString("hex")},
      end:row.requested_end_boundary_revision_id?{boundaryRevisionId:row.requested_end_boundary_revision_id,assetId:row.end_asset_id,sha256:row.end_sha256.toString("hex")}:null,
      dependencyResolutionId:row.dependency_resolution_id,resolution:product.resolution,durationSeconds:15,
      promptExpansionMode:"disabled",enableSafetyChecker:true,syncMode:false,recipeSha256:falRecipeHash(product.resolution).toString("hex")};
    const snapshotDigest=dispatchSnapshotHash(snapshot);
    await client.query("INSERT INTO sloptogether.paid_action_intents(id,twitch_channel_id,extension_client_id,twitch_user_id,opaque_user_id,product_sku,amount_bits,resolution,reserved_usd,segment_id,segment_revision_id,input_screen_id,input_sha256,policy_revision,expires_at,dispatch_snapshot,dispatch_snapshot_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)",
      [id,channel.twitch_channel_id,twitchExtensionClientId(),actor,principal.opaqueUserId,product.sku,product.amountBits,product.resolution,product.reservedUsd,row.segment_id,row.revision_id,row.input_screen_id,row.input_sha256,channel.policy_revision,expiresAt,JSON.stringify(snapshot),snapshotDigest]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'bits.intent.created','paid_action_intent',$3,$4::jsonb)",
      [channel.twitch_channel_id,actor,id,JSON.stringify({sku:product.sku,bits:product.amountBits,resolution:product.resolution,segmentId:row.segment_id,revisionId:row.revision_id,expiresAt:expiresAt.toISOString()})]);
    return {intentId:id,sku:product.sku,amountBits:product.amountBits,resolution:product.resolution,displayName:product.displayName,segmentId:row.segment_id,segmentRevisionId:row.revision_id,expiresAt:expiresAt.toISOString()};
  });
}

async function scheduleBitsReceiptReconciliation(client:PoolClient,intentId:string){
  await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
    VALUES('paid.bits.reconcile_receipt',$1,$2::jsonb,$3,now()+interval '5 seconds') ON CONFLICT(idempotency_key) DO NOTHING`,
  [intentId,JSON.stringify({intentId}),"bits-reconcile:"+intentId]);
}

export async function recordExtensionBitsReceipt(request:Request){
  const principal=verifyExtensionRequest(request);
  if(!principal.linkedTwitchUserId)throw new ApiError(409,"bits_identity_share_required");
  const body=await readJson(request,z.object({intentId:z.string().uuid(),transactionReceipt:z.string().min(20).max(64_000)}).strict());
  const receipt=verifyExtensionBitsReceipt(body.transactionReceipt);
  if(receipt.userId!==principal.linkedTwitchUserId)throw new ApiError(403,"bits_receipt_user_mismatch");
  return transaction(async client=>{
    const result=await client.query("SELECT state,opaque_user_id,twitch_user_id,purchase_window_started_at,expires_at,receipt_transaction_id FROM sloptogether.paid_action_intents WHERE id=$1 AND twitch_channel_id=$2 FOR UPDATE",
      [body.intentId,principal.channelId]);
    const intent=result.rows[0];if(!intent)throw new ApiError(404,"paid_action_intent_not_found");
    if(intent.opaque_user_id!==principal.opaqueUserId||intent.twitch_user_id!==receipt.userId)throw new ApiError(403,"paid_action_intent_identity_mismatch");
    if(receipt.occurredAt<intent.purchase_window_started_at||receipt.occurredAt>intent.expires_at)throw new ApiError(409,"bits_receipt_outside_purchase_window");
    if(intent.receipt_transaction_id&&intent.receipt_transaction_id!==receipt.transactionId)throw new ApiError(409,"paid_action_intent_already_bound");
    const open=intent.state==="intent_open"||intent.state==="receipt_seen";
    const late=intent.state==="expired"||intent.state==="cancelled";
    if(!open&&!late)return {accepted:intent.state==="reserved",state:intent.state};
    if(receipt.inDevelopment){
      await client.query("UPDATE sloptogether.paid_action_intents SET state='cancelled',receipt_transaction_id=$2,receipt_timestamp=$3,state_reason='development_transaction',updated_at=now() WHERE id=$1",
        [body.intentId,receipt.transactionId,receipt.occurredAt]);
      return {accepted:false,state:"development_ignored"};
    }
    if(late){
      await client.query("UPDATE sloptogether.paid_action_intents SET receipt_transaction_id=$2,receipt_timestamp=$3,state_reason='late_receipt_reconciliation_pending',updated_at=now() WHERE id=$1 AND state IN ('expired','cancelled')",
        [body.intentId,receipt.transactionId,receipt.occurredAt]);
      await scheduleBitsReceiptReconciliation(client,body.intentId);
      return {accepted:true,state:"receipt_seen",transactionId:receipt.transactionId};
    }
    await client.query("UPDATE sloptogether.paid_action_intents SET state='receipt_seen',receipt_transaction_id=$2,receipt_timestamp=$3,updated_at=now() WHERE id=$1",
      [body.intentId,receipt.transactionId,receipt.occurredAt]);
    const verified=await client.query("SELECT * FROM sloptogether.extension_bits_transactions WHERE transaction_id=$1 FOR UPDATE",[receipt.transactionId]);
    const tx=verified.rows[0];
    if(tx&&tx.state==="verified_unallocated"){
      const outcome=await fulfillVerifiedBitsTransaction(client,tx);
      return {accepted:outcome.state==="reserved",state:outcome.state,transactionId:receipt.transactionId};
    }
    if(!tx){
      await scheduleBitsReceiptReconciliation(client,body.intentId);
    }
    return {accepted:tx?.state==="reserved",state:tx?.state??"receipt_seen",transactionId:receipt.transactionId};
  });
}

async function markReceiptUnfulfilled(intentId:string,reason:string,verified?:Awaited<ReturnType<typeof getExtensionTransaction>>){
  return transaction(async client=>{
    const result=await client.query<{id:string;twitch_channel_id:string;twitch_user_id:string;product_sku:string;amount_bits:number;reserved_usd:string;receipt_transaction_id:string|null;state:string}>(
      "SELECT id,twitch_channel_id,twitch_user_id,product_sku,amount_bits,reserved_usd,receipt_transaction_id,state FROM sloptogether.paid_action_intents WHERE id=$1 FOR UPDATE",[intentId]);
    const intent=result.rows[0];if(!intent)throw new ApiError(404,"paid_action_intent_not_found");
    if(!receiptReconcileStates.includes(intent.state as typeof receiptReconcileStates[number]))return {state:intent.state,reconciled:true};
    if(verified&&verified.broadcasterId===intent.twitch_channel_id&&verified.userId===intent.twitch_user_id){
      await client.query(`INSERT INTO sloptogether.extension_bits_transactions(transaction_id,eventsub_message_id,extension_client_id,broadcaster_twitch_id,purchaser_twitch_user_id,
        product_sku,amount_bits,is_in_development,occurred_at,intent_id,state,transaction_payload,settlement_state,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid_unfulfilled',$11::jsonb,'paid_unfulfilled','receipt_reconcile') ON CONFLICT(transaction_id) DO NOTHING`,
      [verified.id,"receipt-reconcile:"+verified.id,process.env.TWITCH_EXTENSION_CLIENT_ID,verified.broadcasterId,verified.userId,verified.sku,verified.amountBits,verified.inDevelopment,
        verified.timestamp,intent.id,JSON.stringify({source:"receipt_reconcile",reason})]);
    }
    await client.query(`INSERT INTO sloptogether.funding_authorizations(twitch_channel_id,source,twitch_transaction_id,purchaser_twitch_user_id,paid_action_intent_id,
      amount_bits,reserved_usd,state,consumed_at,settled_at)
      VALUES($1,'twitch_extension_bits',$2,$3,$4,$5,$6,'paid_unfulfilled',now(),now()) ON CONFLICT(twitch_transaction_id) DO NOTHING`,
    [intent.twitch_channel_id,intent.receipt_transaction_id,intent.twitch_user_id,intent.id,verified?.amountBits??intent.amount_bits,Number(intent.reserved_usd)]);
    await client.query("UPDATE sloptogether.paid_action_intents SET state='paid_unfulfilled',state_reason=$2,updated_at=now() WHERE id=$1 AND state=ANY($3::text[])",[intent.id,reason,[...receiptReconcileStates]]);
    await client.query("UPDATE sloptogether.extension_bits_transactions SET state='paid_unfulfilled',settlement_state='paid_unfulfilled',processed_at=now() WHERE transaction_id=$1 AND intent_id=$2",
      [intent.receipt_transaction_id,intent.id]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'bits.receipt_unfulfilled','paid_action_intent',$3,$4::jsonb)`,
    [intent.twitch_channel_id,intent.twitch_user_id,intent.id,JSON.stringify({transactionId:intent.receipt_transaction_id,reason})]);
    return {state:"paid_unfulfilled",reconciled:true};
  });
}

async function markReceiptUnverified(intentId:string,reason:string){
  return transaction(async client=>{
    const result=await client.query<{id:string;twitch_channel_id:string;twitch_user_id:string;receipt_transaction_id:string|null;state:string}>(
      "SELECT id,twitch_channel_id,twitch_user_id,receipt_transaction_id,state FROM sloptogether.paid_action_intents WHERE id=$1 FOR UPDATE",[intentId]);
    const intent=result.rows[0];if(!intent)throw new ApiError(404,"paid_action_intent_not_found");
    if(!receiptReconcileStates.includes(intent.state as typeof receiptReconcileStates[number]))return {state:intent.state,reconciled:true};
    await client.query("UPDATE sloptogether.paid_action_intents SET state='receipt_unverified',state_reason=$2,updated_at=now() WHERE id=$1",[intent.id,reason]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'bits.receipt_unverified','paid_action_intent',$3,$4::jsonb)`,
    [intent.twitch_channel_id,intent.twitch_user_id,intent.id,JSON.stringify({transactionId:intent.receipt_transaction_id,reason})]);
    return {state:"receipt_unverified",reconciled:true};
  });
}

async function markReceiptUnallocated(intentId:string,reason:string,verified:Awaited<ReturnType<typeof getExtensionTransaction>>){
  return transaction(async client=>{
    const result=await client.query<{id:string;twitch_channel_id:string;twitch_user_id:string;receipt_transaction_id:string|null;state:string}>(
      "SELECT id,twitch_channel_id,twitch_user_id,receipt_transaction_id,state FROM sloptogether.paid_action_intents WHERE id=$1 FOR UPDATE",[intentId]);
    const intent=result.rows[0];if(!intent)throw new ApiError(404,"paid_action_intent_not_found");
    if(!receiptReconcileStates.includes(intent.state as typeof receiptReconcileStates[number]))return {state:intent.state,reconciled:true};
    const development=verified.inDevelopment;
    await client.query(`INSERT INTO sloptogether.extension_bits_transactions(transaction_id,eventsub_message_id,extension_client_id,broadcaster_twitch_id,purchaser_twitch_user_id,
      product_sku,amount_bits,is_in_development,occurred_at,state,transaction_payload,settlement_state,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'receipt_reconcile') ON CONFLICT(transaction_id) DO NOTHING`,
    [verified.id,"receipt-reconcile:"+verified.id,process.env.TWITCH_EXTENSION_CLIENT_ID,verified.broadcasterId,verified.userId,verified.sku,verified.amountBits,development,
      verified.timestamp,development?"development_ignored":"verified_unallocated",JSON.stringify({source:"receipt_reconcile",reason}),development?"development_ignored":"pending"]);
    const state=development?"cancelled":"verified_unallocated";
    await client.query("UPDATE sloptogether.paid_action_intents SET state=$2,state_reason=$3,updated_at=now() WHERE id=$1 AND state=ANY($4::text[])",[intent.id,state,reason,[...receiptReconcileStates]]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'bits.receipt_unallocated','paid_action_intent',$3,$4::jsonb)`,
    [intent.twitch_channel_id,intent.twitch_user_id,intent.id,JSON.stringify({transactionId:intent.receipt_transaction_id,reason,transactionIdMatches:verified.id===intent.receipt_transaction_id})]);
    return {state:development?"development_ignored":"verified_unallocated",reconciled:true};
  });
}

export async function reconcilePaidBitsReceipt(request:Request){
  const secret=process.env.SLOPTOGETHER_BITS_RECONCILE_SECRET??"";
  const authorization=request.headers.get("authorization")??"";
  const supplied=authorization.startsWith("SlopBits ")?authorization.slice("SlopBits ".length):"";
  if(secret.length<32)throw new ApiError(503,"bits_reconcile_not_configured");
  if(!constantTimeEqual(Buffer.from(secret),Buffer.from(supplied)))throw new ApiError(401,"bits_reconcile_unauthorized");
  const body=await readJson(request,reconcileReceiptSchema);
  const result=await reconcilePaidBitsReceiptIntent(body.intentId);
  const completed=await query(`UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL
    WHERE id=$1::bigint AND aggregate_id=$2 AND event_kind='paid.bits.reconcile_receipt'
      AND delivered_at IS NULL AND leased_until=$3::timestamptz RETURNING id`,[body.outboxId,body.intentId,new Date(body.leaseUntil)]);
  if(!completed.rowCount)throw new ApiError(409,"bits_reconcile_outbox_lease_stale");
  return result;
}

async function reconcilePaidBitsReceiptIntent(intentId:string){
  const result=await query<{id:string;twitch_channel_id:string;extension_client_id:string;twitch_user_id:string;product_sku:string;amount_bits:number;reserved_usd:string;
    receipt_transaction_id:string|null;receipt_timestamp:Date|null;purchase_window_started_at:Date;expires_at:Date;state:string}>(
    "SELECT id,twitch_channel_id,extension_client_id,twitch_user_id,product_sku,amount_bits,reserved_usd,receipt_transaction_id,receipt_timestamp,purchase_window_started_at,expires_at,state FROM sloptogether.paid_action_intents WHERE id=$1",[intentId]);
  const intent=result.rows[0];if(!intent)return {state:"missing",reconciled:true};
  if(!receiptReconcileStates.includes(intent.state as typeof receiptReconcileStates[number])||!intent.receipt_transaction_id||!intent.receipt_timestamp)
    return {state:intent.state,reconciled:true};

  const saved=await query<VerifiedBitsRecord>("SELECT transaction_id,broadcaster_twitch_id,purchaser_twitch_user_id,product_sku,amount_bits,occurred_at,is_in_development,extension_client_id,state FROM sloptogether.extension_bits_transactions WHERE transaction_id=$1",[intent.receipt_transaction_id]);
  if(saved.rows[0]?.state==="verified_unallocated"){
    return transaction(async client=>{
      const locked=await client.query("SELECT state FROM sloptogether.paid_action_intents WHERE id=$1 FOR UPDATE",[intent.id]);
      if(!receiptReconcileStates.includes(locked.rows[0]?.state as typeof receiptReconcileStates[number]))return {state:locked.rows[0]?.state??"missing",reconciled:true};
      const outcome=await fulfillVerifiedBitsTransaction(client,saved.rows[0]!);
      return {state:outcome.state,reconciled:true};
    });
  }
  if(saved.rows[0])return {state:saved.rows[0].state,reconciled:true};

  const extensionId=twitchExtensionClientId();
  let verified:Awaited<ReturnType<typeof getExtensionTransaction>>;
  try{verified=await getExtensionTransaction(intent.receipt_transaction_id);}
  catch(error){
    if(error instanceof ApiError&&error.status===404&&Date.now()-intent.receipt_timestamp.getTime()>=receiptReconcileGraceMs)
      return markReceiptUnverified(intent.id,"authoritative_transaction_not_found_after_grace");
    if(error instanceof ApiError&&error.status===404)throw new ApiError(503,"bits_transaction_not_yet_visible");
    throw error;
  }

  const coreMatches=verified.id===intent.receipt_transaction_id&&verified.broadcasterId===intent.twitch_channel_id
    &&extensionId===intent.extension_client_id&&verified.userId===intent.twitch_user_id
    &&verified.sku===intent.product_sku&&verified.amountBits===intent.amount_bits;
  if(!coreMatches||verified.inDevelopment)
    return markReceiptUnallocated(intent.id,"authoritative_transaction_does_not_match_intent",verified);
  if(!bitsTransactionMatchesReceiptTarget({channelId:intent.twitch_channel_id,extensionClientId:intent.extension_client_id,twitchUserId:intent.twitch_user_id,
    sku:intent.product_sku,amountBits:intent.amount_bits,transactionId:intent.receipt_transaction_id,
    purchaseWindowStartedAt:intent.purchase_window_started_at,expiresAt:intent.expires_at},{...verified,extensionClientId:extensionId}))
    return markReceiptUnfulfilled(intent.id,"authoritative_transaction_outside_purchase_window",verified);

  return transaction(async client=>{
    const locked=await client.query(`SELECT id,state,twitch_channel_id,extension_client_id,twitch_user_id,product_sku,amount_bits,receipt_transaction_id
      FROM sloptogether.paid_action_intents WHERE id=$1 FOR UPDATE`,[intent.id]);
    const current=locked.rows[0];if(!current)return {state:"missing",reconciled:true};
    if(!receiptReconcileStates.includes(current.state as typeof receiptReconcileStates[number]))return {state:current.state,reconciled:true};
    if(current.receipt_transaction_id!==verified.id||current.twitch_channel_id!==verified.broadcasterId||current.twitch_user_id!==verified.userId
      ||current.extension_client_id!==intent.extension_client_id||current.product_sku!==verified.sku||current.amount_bits!==verified.amountBits)
      return {state:"receipt_changed",reconciled:false};
    await client.query(`INSERT INTO sloptogether.extension_bits_transactions(transaction_id,eventsub_message_id,extension_client_id,broadcaster_twitch_id,purchaser_twitch_user_id,
      product_sku,amount_bits,is_in_development,occurred_at,state,transaction_payload,settlement_state,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'verified_unallocated',$10::jsonb,'pending','receipt_reconcile') ON CONFLICT(transaction_id) DO NOTHING`,
    [verified.id,"receipt-reconcile:"+verified.id,process.env.TWITCH_EXTENSION_CLIENT_ID,verified.broadcasterId,verified.userId,verified.sku,verified.amountBits,verified.inDevelopment,
      verified.timestamp,JSON.stringify({source:"receipt_reconcile"})]);
    const savedTx=await client.query<VerifiedBitsRecord>("SELECT transaction_id,broadcaster_twitch_id,purchaser_twitch_user_id,product_sku,amount_bits,occurred_at,is_in_development,extension_client_id,state FROM sloptogether.extension_bits_transactions WHERE transaction_id=$1 FOR UPDATE",[verified.id]);
    const tx=savedTx.rows[0];if(!tx)throw new ApiError(500,"bits_reconcile_transaction_not_saved");
    if(tx.broadcaster_twitch_id!==verified.broadcasterId||tx.purchaser_twitch_user_id!==verified.userId||tx.product_sku!==verified.sku||tx.amount_bits!==verified.amountBits)
      throw new ApiError(409,"bits_reconcile_transaction_conflict");
    const outcome=tx.state==="verified_unallocated"?await fulfillVerifiedBitsTransaction(client,tx):{state:tx.state};
    return {state:outcome.state,reconciled:true};
  });
}

export async function cancelExtensionBitsIntent(intentId:string,request:Request){
  const principal=verifyExtensionRequest(request);
  return transaction(async client=>{
    const result=await client.query("UPDATE sloptogether.paid_action_intents SET state='cancelled',state_reason='purchase_cancelled',updated_at=now() WHERE id=$1 AND twitch_channel_id=$2 AND opaque_user_id=$3 AND state='intent_open' RETURNING id",
      [intentId,principal.channelId,principal.opaqueUserId]);
    return {cancelled:Boolean(result.rowCount)};
  });
}

export async function getExtensionBitsIntentStatus(intentId:string,request:Request){
  const principal=verifyExtensionRequest(request);
  if(!principal.linkedTwitchUserId)throw new ApiError(409,"bits_identity_share_required");
  const result=await query<{id:string;state:string;state_reason:string;expires_at:Date;receipt_transaction_id:string|null}>(
    `SELECT id,state,state_reason,expires_at,receipt_transaction_id FROM sloptogether.paid_action_intents
     WHERE id=$1 AND twitch_channel_id=$2 AND twitch_user_id=$3 AND opaque_user_id=$4`,
    [intentId,principal.channelId,principal.linkedTwitchUserId,principal.opaqueUserId]);
  const intent=result.rows[0];if(!intent)throw new ApiError(404,"paid_action_intent_not_found");
  if(intent.state==="intent_open"&&intent.expires_at.getTime()<=Date.now()){
    await query("UPDATE sloptogether.paid_action_intents SET state='expired',state_reason='purchase_window_elapsed',updated_at=now() WHERE id=$1 AND state='intent_open' AND expires_at<=now()",[intent.id]);
    return {intentId:intent.id,state:"expired",expiresAt:intent.expires_at.toISOString(),transactionReceived:Boolean(intent.receipt_transaction_id)};
  }
  if(intent.state==="cancelled"&&intent.state_reason==="development_transaction")
    return {intentId:intent.id,state:"development_ignored",expiresAt:intent.expires_at.toISOString(),transactionReceived:Boolean(intent.receipt_transaction_id)};
  if(intent.state==="receipt_unverified"){
    const pending=await query(`SELECT 1 FROM sloptogether.outbox WHERE event_kind='paid.bits.reconcile_receipt' AND aggregate_id=$1 AND delivered_at IS NULL LIMIT 1`,[intent.id]);
    if(pending.rowCount)return {intentId:intent.id,state:"receipt_seen",expiresAt:intent.expires_at.toISOString(),transactionReceived:Boolean(intent.receipt_transaction_id)};
  }
  const pendingLateReceipt=intent.receipt_transaction_id&&["expired","cancelled"].includes(intent.state);
  return {intentId:intent.id,state:pendingLateReceipt?"receipt_seen":intent.state,expiresAt:intent.expires_at.toISOString(),transactionReceived:Boolean(intent.receipt_transaction_id)};
}

export async function requestBitsReceiptReconciliation(intentId:string,request:Request){
  const principal=verifyExtensionRequest(request);
  if(!principal.linkedTwitchUserId)throw new ApiError(409,"bits_identity_share_required");
  return transaction(async client=>{
    const result=await client.query<{id:string;state:string;updated_at:Date}>(`SELECT id,state,updated_at FROM sloptogether.paid_action_intents
      WHERE id=$1 AND twitch_channel_id=$2 AND twitch_user_id=$3 AND opaque_user_id=$4 FOR UPDATE`,
    [intentId,principal.channelId,principal.linkedTwitchUserId,principal.opaqueUserId]);
    const intent=result.rows[0];if(!intent)throw new ApiError(404,"paid_action_intent_not_found");
    if(intent.state!=="receipt_unverified")return {queued:false,state:intent.state};
    const active=await client.query(`SELECT 1 FROM sloptogether.outbox WHERE event_kind='paid.bits.reconcile_receipt' AND aggregate_id=$1
      AND delivered_at IS NULL LIMIT 1`,[intent.id]);
    if(active.rowCount)return {queued:false,state:intent.state};
    if(Date.now()-intent.updated_at.getTime()<60_000)return {queued:false,state:intent.state,retryAfterSeconds:60};
    const key=`bits-reconcile:${intent.id}:manual:${Math.floor(Date.now()/60_000)}`;
    await client.query(`INSERT INTO sloptogether.outbox(event_kind,aggregate_id,payload,idempotency_key,available_at)
      VALUES('paid.bits.reconcile_receipt',$1,$2::jsonb,$3,now()) ON CONFLICT(idempotency_key) DO NOTHING`,
    [intent.id,JSON.stringify({intentId:intent.id}),key]);
    await client.query("UPDATE sloptogether.paid_action_intents SET updated_at=now() WHERE id=$1 AND state='receipt_unverified'",[intent.id]);
    return {queued:true,state:intent.state};
  });
}

export async function recordVerifiedExtensionBitsEvent(messageId:string,event:Record<string,unknown>){
  const extensionId=twitchExtensionClientId();
  const product=event.product&&typeof event.product==="object"&&!Array.isArray(event.product)?event.product as Record<string,unknown>:null;
  const transactionId=event.id,broadcasterId=event.broadcaster_user_id,userId=event.user_id,sku=product?.sku,bits=product?.bits,inDevelopment=product?.in_development;
  if(event.extension_client_id!==extensionId||typeof transactionId!=="string"||!transactionId||transactionId.length>256
    ||typeof broadcasterId!=="string"||!/^[0-9]{1,32}$/.test(broadcasterId)||typeof userId!=="string"||!/^[0-9]{1,32}$/.test(userId)
    ||typeof sku!=="string"||!sku||sku.length>255||!Number.isSafeInteger(bits)||typeof inDevelopment!=="boolean")
    throw new ApiError(400,"extension_bits_event_invalid");
  const verified=await getExtensionTransaction(transactionId);
  if(verified.id!==transactionId||verified.broadcasterId!==broadcasterId||verified.userId!==userId||verified.sku!==sku
    ||verified.amountBits!==bits||verified.inDevelopment!==inDevelopment)
    throw new ApiError(403,"extension_bits_authoritative_transaction_mismatch");
  const channel=await query("SELECT 1 FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled=true",[broadcasterId]);
  if(!channel.rowCount)return {ignored:true,reason:"channel_unmanaged"};
  return transaction(async client=>{
      await client.query(`INSERT INTO sloptogether.extension_bits_transactions(transaction_id,eventsub_message_id,extension_client_id,broadcaster_twitch_id,purchaser_twitch_user_id,
        product_sku,amount_bits,is_in_development,occurred_at,state,transaction_payload,settlement_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT DO NOTHING`,
      [transactionId,messageId,extensionId,broadcasterId,userId,sku,bits,inDevelopment,verified.timestamp,inDevelopment?"development_ignored":"verified_unallocated",
        JSON.stringify({sku,bits,inDevelopment}),inDevelopment?"development_ignored":"pending"]);
    const saved=await client.query<VerifiedBitsRecord>("SELECT transaction_id,broadcaster_twitch_id,purchaser_twitch_user_id,product_sku,amount_bits,occurred_at,is_in_development,extension_client_id,state FROM sloptogether.extension_bits_transactions WHERE transaction_id=$1 FOR UPDATE",[transactionId]);
    const row=saved.rows[0];if(!row)throw new ApiError(500,"extension_bits_transaction_not_recorded");
    if(row.broadcaster_twitch_id!==broadcasterId||row.purchaser_twitch_user_id!==userId||row.product_sku!==sku||row.amount_bits!==bits)
      throw new ApiError(409,"extension_bits_transaction_id_conflict");
    if(row.state==="verified_unallocated")return fulfillVerifiedBitsTransaction(client,row);
    return {state:row.state};
  });
}
