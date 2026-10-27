import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { proposalRequestSchema } from "@sloptogether/contracts";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { query, transaction } from "./db";
import { canContribute, findChannel, principalTwitchId, type ChannelRow } from "./channels";
import { requestPrincipal, type RequestPrincipal } from "./principals";
import { inputAsset, screenPromptAndImages } from "./preflight";
import { signedPrivateReadUrl } from "./storage";
import { getDefaultStreamId } from "./stream-service";

interface Target { id:string; branch_id:string; ordinal:string; state:string }
interface Boundary { id:string; asset_id:string; storage_key:string; content_type:string; status:string; sha256:Buffer|null }

async function readBoundary(channelId:string,id:string):Promise<Boundary> {
  const rows=await query<Boundary>(`SELECT b.id,b.asset_id,a.storage_key,a.content_type,a.status,a.sha256
    FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
    WHERE b.id=$1 AND b.twitch_channel_id=$2 AND b.retired_at IS NULL
      AND a.media_kind='image' AND a.status IN ('approved','published')`,[id,channelId]);
  if(!rows.rows[0])throw new ApiError(409,"boundary_not_approved");
  return rows.rows[0];
}

async function boundaryBytes(boundary:Boundary) {
  const response=await fetch(await signedPrivateReadUrl(boundary.storage_key,60),{cache:"no-store",signal:AbortSignal.timeout(8000)});
  if(!response.ok||!response.body)throw new ApiError(503,"boundary_image_unavailable");
  const chunks:Buffer[]=[];let length=0;
  const reader=response.body.getReader();
  try { for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
    if(length>16*1024*1024)throw new ApiError(413,"boundary_image_too_large");chunks.push(Buffer.from(part.value));} }
  finally {reader.releaseLock();}
  const bytes=Buffer.concat(chunks);
  if(boundary.sha256&&!createHash("sha256").update(bytes).digest().equals(boundary.sha256))throw new ApiError(409,"boundary_image_changed");
  return {bytes,contentType:boundary.content_type};
}

async function predecessorBoundary(branchId:string,ordinal:number,client?:PoolClient) {
  const sql=`SELECT coalesce(r.requested_end_boundary_revision_id,er.resolved_end_boundary_revision_id) AS boundary_id
    FROM sloptogether.segments s JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id
    LEFT JOIN LATERAL(SELECT resolved_end_boundary_revision_id FROM sloptogether.endpoint_resolutions
      WHERE segment_revision_id=r.id AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1) er ON true
    WHERE s.branch_id=$1 AND s.ordinal<$2 AND s.state NOT IN ('retired','rejected') ORDER BY s.ordinal DESC LIMIT 1`;
  const result=client?await client.query<{boundary_id:string|null}>(sql,[branchId,ordinal]):await query<{boundary_id:string|null}>(sql,[branchId,ordinal]);
  return result.rows[0]?.boundary_id??null;
}

async function uploaderBypass(channel:ChannelRow,principal:RequestPrincipal,actor:string) {
  if(channel.upload_approval_bypass_ids.includes(actor))return true;
  if(actor===channel.owner_twitch_user_id&&channel.role_based_upload_bypass.includes("broadcaster"))return true;
  if(!channel.role_based_upload_bypass.includes("moderator"))return false;
  if(principal.kind==="extension")return principal.extension.channelId===channel.twitch_channel_id&&principal.extension.role==="moderator";
  if(principal.kind!=="session"||!principal.session.scopes.includes("user:read:moderated_channels"))return false;
  const {getModeratedChannelIds}=await import("./twitch-subs");
  return (await getModeratedChannelIds(principal.session.accessToken,actor)).has(channel.twitch_channel_id);
}

async function reserveProposalSubmission(channelId:string,actor:string){
  const id=randomUUID();
  await transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`proposal-rate:${channelId}:${actor}`]);
    await client.query("DELETE FROM sloptogether.proposal_rate_reservations WHERE expires_at<=now()");
    const recent=await client.query<{n:string}>(`SELECT
      (SELECT count(*) FROM sloptogether.proposals p JOIN sloptogether.elections e ON e.id=p.election_id JOIN sloptogether.segments s ON s.id=e.segment_id
        WHERE p.author_twitch_user_id=$1 AND s.twitch_channel_id=$2 AND p.created_at>now()-interval '10 minutes')+
      (SELECT count(*) FROM sloptogether.proposal_rate_reservations r WHERE r.twitch_user_id=$1 AND r.twitch_channel_id=$2 AND r.state IN ('reserved','released') AND r.expires_at>now()) AS n`,[actor,channelId]);
    if(Number(recent.rows[0]?.n??0)>=20)throw new ApiError(429,"proposal_rate_limited");
    await client.query("INSERT INTO sloptogether.proposal_rate_reservations(id,twitch_channel_id,twitch_user_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[id,channelId,actor]);
  });
  return id;
}

export async function submitProposal(locator:string,request:Request,requestedStreamId?:string) {
  const principal=await requestPrincipal(request);
  if(!principal)throw new ApiError(401,"login_required");
  if(principal.kind==="session")assertSameOrigin(request);
  if(principal.kind!=="session"&&principal.kind!=="extension")throw new ApiError(403,"interactive_identity_required");
  const channel=await findChannel(locator);
  const streamId=requestedStreamId??await getDefaultStreamId(channel.twitch_channel_id);
  if(principal.kind==="extension"&&principal.extension.channelId!==channel.twitch_channel_id)throw new ApiError(403,"extension_channel_mismatch");
  if(!await canContribute(channel,principal))throw new ApiError(403,"contribution_not_allowed");
  const actor=principalTwitchId(principal)!;
  const body=await readJson(request,proposalRequestSchema);
  const reservationId=await reserveProposalSubmission(channel.twitch_channel_id,actor);
  let reservationConsumed=false;
  try{
  const targetResult=await query<Target>(`SELECT s.id,s.branch_id,s.ordinal,s.state FROM sloptogether.segments s
    JOIN sloptogether.branches b ON b.id=s.branch_id AND b.stream_id=$3 AND b.is_selected AND b.archived_at IS NULL
    WHERE s.twitch_channel_id=$1 AND ($2::uuid IS NULL OR s.id=$2)
      AND s.state IN ('open','voting') AND s.protected_at IS NULL ORDER BY s.ordinal LIMIT 1`,[channel.twitch_channel_id,body.segmentId??null,streamId]);
  const target=targetResult.rows[0];
  if(!target)throw new ApiError(409,"open_segment_required","There is no unlocked future segment available.");
  const predecessor=await predecessorBoundary(target.branch_id,Number(target.ordinal));
  const uploaded=body.imageAssetId?await inputAsset(channel.twitch_channel_id,body.imageAssetId,actor):null;
  const uploadedEnd=body.endFrameAssetId?await inputAsset(channel.twitch_channel_id,body.endFrameAssetId,actor):null;
  let start:Boundary|null=predecessor?await readBoundary(channel.twitch_channel_id,predecessor):null;
  if(start&&uploaded){
    const supplied=createHash("sha256").update(uploaded.bytes).digest();
    if(!start.sha256||!supplied.equals(start.sha256))throw new ApiError(409,"continuity_boundary_locked","This scene must begin at the previous scene's approved ending.");
    throw new ApiError(409,"start_frame_already_inherited","This scene already begins at the previous ending; remove the extra start-frame upload.");
  }
  if(!start&&!uploaded)throw new ApiError(422,"start_frame_required",Number(target.ordinal)===0?"Upload a start frame for the first scene.":"This scene has no approved continuation frame yet. Upload a start frame to open it for voting.");
  const startInput=uploaded??(start?await boundaryBytes(start):null);
  const end=body.boundaryRevisionId?await readBoundary(channel.twitch_channel_id,body.boundaryRevisionId):null;
  if(body.planningMode==="continuation"&&(end||uploadedEnd))throw new ApiError(400,"continuation_end_boundary_forbidden");
  if(body.planningMode==="planned_anchors"&&!end&&!uploadedEnd)throw new ApiError(422,"end_frame_required","Planned-anchor generation needs a reviewed end frame.");
  const images=[...(startInput?[startInput]:[]),...(end?[await boundaryBytes(end)]:[]),...(uploadedEnd?[uploadedEnd]:[])];
  const screen=await screenPromptAndImages({channelId:channel.twitch_channel_id,prompt:body.prompt,images});
  const needsImageReview=Boolean((uploaded||uploadedEnd)&&!await uploaderBypass(channel,principal,actor));
  const result=await transaction(async client=>{
    const currentChannel=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 FOR UPDATE",[channel.twitch_channel_id]);
    if(currentChannel.rows[0]?.policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    const ban=await client.query(`SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) AND (scope='global' OR twitch_channel_id=$2)`,[actor,channel.twitch_channel_id]);
    if(ban.rowCount)throw new ApiError(403,"channel_ban_active");
    const locked=await client.query<Target>("SELECT id,branch_id,ordinal,state FROM sloptogether.segments WHERE id=$1 AND state IN ('open','voting') AND protected_at IS NULL FOR UPDATE",[target.id]);
    if(!locked.rows[0])throw new ApiError(409,"segment_locked");
    const currentPredecessor=await predecessorBoundary(target.branch_id,Number(target.ordinal),client);
    if(currentPredecessor!==predecessor)throw new ApiError(409,"continuity_boundary_changed");
    const evidence=await client.query<{id:string;effective_state:string}>(`SELECT id,effective_state FROM sloptogether.input_screens
      WHERE twitch_channel_id=$1 AND input_sha256=$2 AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[channel.twitch_channel_id,Buffer.from(screen.digest,"hex")]);
    const screenRow=evidence.rows[0];if(!screenRow)throw new ApiError(409,"input_screen_missing");
    const state=screenRow.effective_state==="clear"&&!needsImageReview?"eligible":"pending";
    if(!start&&uploaded){
      const boundary=await client.query<{id:string}>(`INSERT INTO sloptogether.boundary_revisions(twitch_channel_id,asset_id,created_by,moderation_evidence_id)
        VALUES($1,$2,$3,$4) RETURNING id`,[channel.twitch_channel_id,uploaded.assetId,actor,screenRow.id]);
      start={id:boundary.rows[0]!.id,asset_id:uploaded.assetId,storage_key:"",content_type:uploaded.contentType,status:"quarantine",sha256:null};
      if(state==="eligible")await client.query("UPDATE sloptogether.assets SET status='approved' WHERE id=$1 AND status='quarantine'",[uploaded.assetId]);
    }
    let endBoundary=end?.id??null;
    if(uploadedEnd){
      const boundary=await client.query<{id:string}>(`INSERT INTO sloptogether.boundary_revisions(twitch_channel_id,asset_id,created_by,moderation_evidence_id)
        VALUES($1,$2,$3,$4) RETURNING id`,[channel.twitch_channel_id,uploadedEnd.assetId,actor,screenRow.id]);
      endBoundary=boundary.rows[0]!.id;
      if(state==="eligible")await client.query("UPDATE sloptogether.assets SET status='approved' WHERE id=$1 AND status='quarantine'",[uploadedEnd.assetId]);
    }
    const election=await openElection(client,target.id,state==="eligible");
    const count=await client.query<{n:string}>("SELECT count(*) AS n FROM sloptogether.proposals WHERE election_id=$1 AND state NOT IN ('rejected','withdrawn','superseded')",[election]);
    if(Number(count.rows[0]?.n??0)>=100)throw new ApiError(409,"election_proposal_limit");
    // Future continuation slots can collect prompt votes before the preceding
    // output exists. Their immutable generation revision is materialized only
    // after the selected upstream endpoint has passed admission.
    const proposalId=randomUUID();
    let revisionId:string|null=null;
    if(start){
      const revisionNo=await client.query<{n:number}>("SELECT coalesce(max(revision),0)+1 AS n FROM sloptogether.segment_revisions WHERE segment_id=$1",[target.id]);
      revisionId=randomUUID();
      const inputDigest=createHash("sha256").update(JSON.stringify({prompt:body.prompt,screen:screen.digest,start:start.id,end:endBoundary,mode:body.planningMode})).digest();
      await client.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,requested_end_boundary_revision_id,
        planning_mode,provider_recipe_id,input_sha256,requested_by,state) VALUES($1,$2,$3,$4,$5,$6,$7,'fast-h3-trim-5step-vsa20-b1',$8,$9,'proposal')`,
        [revisionId,target.id,revisionNo.rows[0]!.n,body.prompt,start.id,endBoundary,body.planningMode,inputDigest,actor]);
    }
    await client.query(`INSERT INTO sloptogether.proposals(id,election_id,segment_revision_id,author_twitch_user_id,proposal_kind,prompt,start_boundary_revision_id,end_boundary_revision_id,input_screen_id,state,planning_mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[proposalId,election,revisionId,actor,uploaded||uploadedEnd?"anchor_pair":"prompt",body.prompt,start?.id??null,endBoundary,screenRow.id,state,body.planningMode]);
    await client.query("UPDATE sloptogether.segments SET state='voting' WHERE id=$1",[target.id]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,policy_revision,after_state)
      VALUES($1,$2,'proposal.create','proposal',$3,$4,$5::jsonb)`,[channel.twitch_channel_id,actor,proposalId,channel.policy_revision,JSON.stringify({state,revisionId,inputScreenId:screenRow.id,screen:screen.decision})]);
    const consumed=await client.query("UPDATE sloptogether.proposal_rate_reservations SET state='consumed' WHERE id=$1 AND state='reserved' AND expires_at>now()",[reservationId]);
    if(!consumed.rowCount)throw new ApiError(409,"proposal_rate_reservation_expired");
    return {proposalId,segmentId:target.id,electionId:election,revisionId,state,screen:screen.decision,awaitingUpstreamBoundary:!start};
  });
  reservationConsumed=true;
  return result;
  }finally{
    if(!reservationConsumed)await query("UPDATE sloptogether.proposal_rate_reservations SET state='released' WHERE id=$1 AND state='reserved'",[reservationId]).catch(()=>undefined);
  }
}

async function openElection(client:PoolClient,segmentId:string,startImmediately:boolean) {
  const result=await client.query<{id:string}>("SELECT id FROM sloptogether.elections WHERE segment_id=$1 AND state='open' AND closes_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[segmentId]);
  if(result.rows[0])return result.rows[0].id;
  await client.query("UPDATE sloptogether.elections SET state='closed' WHERE segment_id=$1 AND state='open' AND closes_at<=now()",[segmentId]);
  const created=await client.query<{id:string}>(`INSERT INTO sloptogether.elections(segment_id,closes_at,rule_snapshot,state)
    VALUES($1,now()+interval '120 seconds',$2::jsonb,$3) RETURNING id`,[segmentId,JSON.stringify({ballotsPerLinkedTwitchIdentity:1,editableUntilClose:true,tieBreak:"earliest_eligible_proposal"}),startImmediately?"open":"closed"]);
  return created.rows[0]!.id;
}
