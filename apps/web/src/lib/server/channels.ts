import type { PoolClient, QueryResultRow } from "pg";
import { contributionModeSchema } from "@sloptogether/contracts";
import { ApiError } from "./http";
import { query } from "./db";
import { getModeratedChannelIds } from "./twitch-subs";
import type { RequestPrincipal,WorkerGrant } from "./principals";
import { requireKeyScope } from "./principals";

export interface ChannelRow extends QueryResultRow {
  twitch_channel_id:string;
  owner_twitch_user_id:string;
  twitch_login:string;
  display_name:string;
  visibility:"public"|"unlisted"|"private";
  is_enabled:boolean;
  policy_revision:number;
  contribution_mode:string;
  contributor_whitelist:string[];
  reviewer_whitelist:string[];
  upload_approval_bypass_ids:string[];
  role_based_upload_bypass:string[];
  subscriber_interrupt_policy:Record<string,unknown>;
  story_world_prompt:string;
  h3_style_profile:string;
  owner_budget_cap_usd:string;
  layout_revision:number;
  chat_voting_enabled:boolean;
  preair_upscale_enabled:boolean;
  preair_upscale_wait_seconds:number;
}

export function principalTwitchId(principal:RequestPrincipal|null):string|null{
  if(!principal)return null;
  if(principal.kind==="session")return principal.session.twitchUserId;
  if(principal.kind==="extension")return principal.extension.linkedTwitchUserId;
  if(principal.kind==="chat")return principal.twitchUserId;
  if(principal.kind==="worker-key")return principal.worker.issuingTwitchUserId;
  return principal.twitchUserId;
}

export async function findChannel(locator:string,requireEnabled=true):Promise<ChannelRow>{
  const key=locator.trim().toLowerCase();
  const result=await query<ChannelRow>(
    `SELECT twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,visibility,is_enabled,
      policy_revision,contribution_mode,contributor_whitelist,reviewer_whitelist,
      upload_approval_bypass_ids,role_based_upload_bypass,subscriber_interrupt_policy,
      story_world_prompt,h3_style_profile,owner_budget_cap_usd,layout_revision,chat_voting_enabled,
      preair_upscale_enabled,preair_upscale_wait_seconds
     FROM sloptogether.channels
     WHERE twitch_login=$1 OR twitch_channel_id=$2
     LIMIT 1`,[key,locator],
  );
  const channel=result.rows[0];
  if(!channel || (requireEnabled&&!channel.is_enabled))throw new ApiError(404,"channel_not_found");
  if(channel.visibility==="private")throw new ApiError(404,"channel_not_found");
  return channel;
}

export async function listPublicChannels(limit=30){
  const bounded=Math.max(1,Math.min(100,Math.trunc(limit)));
  const result=await query<{twitch_channel_id:string;twitch_login:string;display_name:string}>(
    `SELECT c.twitch_channel_id,c.twitch_login,c.display_name
     FROM sloptogether.channels c
     WHERE c.is_enabled=true AND c.visibility='public'
     ORDER BY c.updated_at DESC LIMIT $1`,[bounded],
  );
  return {channels:result.rows.map(channel=>({twitchChannelId:channel.twitch_channel_id,twitchLogin:channel.twitch_login,displayName:channel.display_name}))};
}

export async function isBanned(channelId:string,userId:string,client?:PoolClient):Promise<boolean>{
  const sql=
    `SELECT 1 FROM sloptogether.bans WHERE twitch_user_id=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) AND (scope='global' OR twitch_channel_id=$2) LIMIT 1`;
  const values=[userId,channelId];
  const result=client?await client.query(sql,values):await query(sql,values);
  return (result.rowCount??0)>0;
}

export async function canModerate(channel:ChannelRow,principal:RequestPrincipal):Promise<boolean>{
  const userId=principalTwitchId(principal);
  if(!userId)return false;
  if(await isBanned(channel.twitch_channel_id,userId))return false;
  if(principal.kind==="session"&&userId===channel.owner_twitch_user_id)return true;
  if(principal.kind==="worker-key")return principal.worker.channelId===channel.twitch_channel_id&&principal.worker.issuingTwitchUserId===channel.owner_twitch_user_id&&principal.worker.scopes.includes("streamer:control");
  if(principal.kind==="extension"){
    return principal.extension.channelId===channel.twitch_channel_id&&principal.extension.linkedTwitchUserId!==null&&(principal.extension.role==="broadcaster"||principal.extension.role==="moderator");
  }
  if(principal.kind==="chat")return false;
  if(principal.kind==="worker-device")return false;
  if(!principal.session.scopes.includes("user:read:moderated_channels"))return false;
  const moderated=await getModeratedChannelIds(principal.session.accessToken,principal.session.twitchUserId);
  return moderated.has(channel.twitch_channel_id);
}

export async function canReviewContent(channel:ChannelRow,principal:RequestPrincipal):Promise<boolean>{
  const userId=principalTwitchId(principal);
  if(userId&&(principal.kind==="session"||(principal.kind==="extension"&&principal.extension.channelId===channel.twitch_channel_id))
    &&channel.reviewer_whitelist.includes(userId))return !await isBanned(channel.twitch_channel_id,userId);
  return canModerate(channel,principal);
}

export async function requireContentReviewer(channel:ChannelRow,principal:RequestPrincipal|null):Promise<string>{
  if(!principal)throw new ApiError(401,"login_required","Connect Twitch to continue.");
  const userId=principalTwitchId(principal);if(!userId)throw new ApiError(403,"linked_identity_required");
  if(!await canReviewContent(channel,principal))throw new ApiError(403,"content_reviewer_required");
  return userId;
}

export async function requireChannelModerator(channel:ChannelRow,principal:RequestPrincipal|null):Promise<string>{
  if(!principal)throw new ApiError(401,"login_required","Connect Twitch to continue.");
  const userId=principalTwitchId(principal);if(!userId)throw new ApiError(403,"linked_identity_required");
  if(!await canModerate(channel,principal))throw new ApiError(403,"moderator_or_broadcaster_required");
  return userId;
}

async function refreshModeratorMembership(channel:ChannelRow,userId:string,principal:RequestPrincipal):Promise<boolean>{
  if(principal.kind==="extension")return principal.extension.channelId===channel.twitch_channel_id&&principal.extension.role==="moderator";
  let accessToken:string|undefined;
  if(principal.kind==="session"&&principal.session.scopes.includes("user:read:moderated_channels"))accessToken=principal.session.accessToken;
  else if(principal.kind==="worker-key"||principal.kind==="worker-device"){
    const sessions=await query<{access_token_encrypted:Buffer}>(`SELECT access_token_encrypted FROM sloptogether.sessions
      WHERE twitch_user_id=$1 AND revoked_at IS NULL AND expires_at>now() AND token_expires_at>now()
        AND granted_scopes @> ARRAY['user:read:moderated_channels']::text[] ORDER BY last_seen_at DESC LIMIT 1`,[userId]);
    if(sessions.rows[0]){
      const {decryptTwitchAccess}=await import("./twitch");
      accessToken=decryptTwitchAccess(sessions.rows[0].access_token_encrypted);
    }
  }
  if(!accessToken){
    await query("UPDATE sloptogether.memberships SET status='revoked',checked_at=now() WHERE twitch_user_id=$1 AND twitch_channel_id=$2 AND role='moderator' AND status='active'",[userId,channel.twitch_channel_id]);
    return false;
  }
  let moderator:boolean;
  try{moderator=(await getModeratedChannelIds(accessToken,userId)).has(channel.twitch_channel_id)}catch{
    await query("UPDATE sloptogether.memberships SET status='revoked',checked_at=now() WHERE twitch_user_id=$1 AND twitch_channel_id=$2 AND role='moderator' AND status='active'",[userId,channel.twitch_channel_id]);
    return false;
  }
  if(moderator)await query(`INSERT INTO sloptogether.memberships(twitch_user_id,twitch_channel_id,role,status,checked_at)
    VALUES($1,$2,'moderator','active',now()) ON CONFLICT(twitch_user_id,twitch_channel_id) DO UPDATE SET
      role=CASE WHEN sloptogether.memberships.role='broadcaster' THEN 'broadcaster' ELSE 'moderator' END,status='active',checked_at=now()`,[userId,channel.twitch_channel_id]);
  else await query("UPDATE sloptogether.memberships SET status='revoked',checked_at=now() WHERE twitch_user_id=$1 AND twitch_channel_id=$2 AND role='moderator' AND status='active'",[userId,channel.twitch_channel_id]);
  return moderator;
}

export async function canContribute(channel:ChannelRow,principal:RequestPrincipal){
  const userId=principalTwitchId(principal);
  if(!userId||await isBanned(channel.twitch_channel_id,userId))return false;
  if(principal.kind==="chat")return false;
  if(principal.kind==="extension"&&principal.extension.channelId!==channel.twitch_channel_id)return false;
  if(principal.kind==="worker-key"&&principal.worker.channelId!==channel.twitch_channel_id)return false;
  const parsed=contributionModeSchema.safeParse(channel.contribution_mode);
  const mode=parsed.success?parsed.data:"broadcaster_and_moderators";
  const listed=(channel.contributor_whitelist??[]).includes(userId);
  const broadcaster=userId===channel.owner_twitch_user_id;
  let moderator=principal.kind==="extension"&&principal.extension.role==="moderator";
  const roleBypassNeedsModerator=channel.role_based_upload_bypass.includes("moderator")&&!broadcaster&&!channel.upload_approval_bypass_ids.includes(userId);
  const contributionNeedsModerator=mode==="broadcaster_and_moderators"||(mode==="combined"&&!listed);
  if(!broadcaster&&(roleBypassNeedsModerator||contributionNeedsModerator))moderator=await refreshModeratorMembership(channel,userId,principal);
  if(mode==="any_non_banned_twitch_user")return true;
  if(mode==="explicit_allowlist")return listed||broadcaster;
  if(broadcaster||(mode==="combined"&&listed))return true;
  if(mode==="broadcaster_and_moderators")return broadcaster||moderator;
  return broadcaster||moderator||listed;
}

export function requireWorkerScope(grant:WorkerGrant,channelId:string,scope:string){
  if(grant.channelId!==channelId)throw new ApiError(403,"worker_channel_mismatch");
  requireKeyScope(grant,scope);
}

export async function requireStreamerController(channel:ChannelRow,principal:RequestPrincipal|null){
  const userId=principalTwitchId(principal);
  if(!principal||!userId)throw new ApiError(401,"login_required");
  if(await isBanned(channel.twitch_channel_id,userId))throw new ApiError(403,"channel_ban_active");
  if(principal.kind==="session"&&userId===channel.owner_twitch_user_id)return userId;
  if(principal.kind==="worker-key"&&principal.worker.channelId===channel.twitch_channel_id&&userId===channel.owner_twitch_user_id){
    requireKeyScope(principal.worker,"streamer:control");return userId;
  }
  if(principal.kind==="extension"&&principal.extension.channelId===channel.twitch_channel_id&&principal.extension.role==="broadcaster")return userId;
  throw new ApiError(403,"streamer_control_required");
}
