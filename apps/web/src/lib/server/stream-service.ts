import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction, query } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { findChannel, requireStreamerController } from "./channels";
import { requestPrincipal } from "./principals";

export interface StreamRow {
  id: string;
  twitch_channel_id: string;
  slug: string;
  display_name: string;
  is_default: boolean;
  created_at?: Date;
}

const streamInput=z.object({
  slug:z.string().trim().min(1).max(48).regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName:z.string().trim().min(1).max(80),
}).strict();

export async function getStream(channelId:string,slug:string,client?:PoolClient):Promise<StreamRow>{
  const result=client
    ?await client.query<StreamRow>("SELECT id,twitch_channel_id,slug,display_name,is_default,created_at FROM sloptogether.streams WHERE twitch_channel_id=$1 AND slug=$2",[channelId,slug])
    :await query<StreamRow>("SELECT id,twitch_channel_id,slug,display_name,is_default,created_at FROM sloptogether.streams WHERE twitch_channel_id=$1 AND slug=$2",[channelId,slug]);
  const stream=result.rows[0];
  if(!stream)throw new ApiError(404,"stream_not_found");
  return stream;
}

export async function getDefaultStreamId(channelId:string,client?:PoolClient):Promise<string>{
  const result=client
    ?await client.query<{id:string}>("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[channelId])
    :await query<{id:string}>("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[channelId]);
  if(!result.rows[0])throw new ApiError(404,"stream_not_found");
  return result.rows[0].id;
}

export async function getStreamById(channelId:string,id:string):Promise<StreamRow>{
  const result=await query<StreamRow>("SELECT id,twitch_channel_id,slug,display_name,is_default,created_at FROM sloptogether.streams WHERE twitch_channel_id=$1 AND id=$2",[channelId,id]);
  const stream=result.rows[0];if(!stream)throw new ApiError(404,"stream_not_found");return stream;
}

export async function listStreams(locator:string){
  const channel=await findChannel(locator);
  const result=await query<StreamRow>(`SELECT id,twitch_channel_id,slug,display_name,is_default,created_at
    FROM sloptogether.streams WHERE twitch_channel_id=$1 ORDER BY is_default DESC,created_at,id`,[channel.twitch_channel_id]);
  return {channel:{twitchLogin:channel.twitch_login,displayName:channel.display_name},streams:result.rows.map(stream=>({
    id:stream.id,slug:stream.slug,displayName:stream.display_name,isDefault:stream.is_default,createdAt:stream.created_at?.toISOString()??null,
  }))};
}

export async function createStream(locator:string,request:Request){
  assertSameOrigin(request);
  const channel=await findChannel(locator);
  const principal=await requestPrincipal(request);
  const actor=await requireStreamerController(channel,principal);
  const body=await readJson(request,streamInput);
  return transaction(async client=>{
    await client.query("SELECT twitch_channel_id FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    const existing=await client.query("SELECT 1 FROM sloptogether.streams WHERE twitch_channel_id=$1 AND slug=$2",[channel.twitch_channel_id,body.slug]);
    if(existing.rowCount)throw new ApiError(409,"stream_slug_taken");
    const created=await client.query<StreamRow>(`INSERT INTO sloptogether.streams(twitch_channel_id,slug,display_name,is_default,created_by)
      VALUES($1,$2,$3,false,$4) RETURNING id,twitch_channel_id,slug,display_name,is_default,created_at`,[channel.twitch_channel_id,body.slug,body.displayName,actor]);
    const stream=created.rows[0]!;
    const branch=await client.query<{id:string}>(`INSERT INTO sloptogether.branches(twitch_channel_id,stream_id,name,is_selected,created_by)
      VALUES($1,$2,$3,true,$4) RETURNING id`,[channel.twitch_channel_id,stream.id,body.displayName,actor]);
    await client.query("INSERT INTO sloptogether.segments(twitch_channel_id,branch_id,ordinal,state) VALUES($1,$2,0,'open')",[channel.twitch_channel_id,branch.rows[0]!.id]);
    await client.query("INSERT INTO sloptogether.playback_sessions(twitch_channel_id,stream_id) VALUES($1,$2)",[channel.twitch_channel_id,stream.id]);
    await client.query("INSERT INTO sloptogether.program_manifests(twitch_channel_id,stream_id,program_epoch,manifest_revision) VALUES($1,$2,1,0)",[channel.twitch_channel_id,stream.id]);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'stream.create','stream',$3,$4::jsonb)`,[channel.twitch_channel_id,actor,stream.id,JSON.stringify({slug:stream.slug,displayName:stream.display_name})]);
    return {id:stream.id,slug:stream.slug,displayName:stream.display_name,isDefault:false,createdAt:stream.created_at?.toISOString()??null};
  });
}
