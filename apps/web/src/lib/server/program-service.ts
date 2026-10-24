import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { findChannel, isBanned, requireStreamerController } from "./channels";
import { requestPrincipal, type RequestPrincipal } from "./principals";

type Packet = {
  item_id:string; item_kind:"story"|"subscriber_interrupt"; segment_id:string|null; interrupt_id:string|null;
  interrupt_state:string|null;
  source_pts_start:string|null; item_order:string; media_asset_id:string; duration_seconds:string;
  discontinuity_before:boolean; item_discontinuity:boolean; media_sequence:number;
};
type Snapshot = {epoch:number;revision:number;packets:Packet[]};

async function currentManifest(client:PoolClient,channelId:string){
  const result=await client.query<{program_epoch:string;manifest_revision:string}>(
    "SELECT program_epoch,manifest_revision FROM sloptogether.program_manifests WHERE twitch_channel_id=$1 ORDER BY program_epoch DESC LIMIT 1",
    [channelId],
  );
  const row=result.rows[0];
  return {epoch:Number(row?.program_epoch??1),revision:Number(row?.manifest_revision??0)};
}

async function snapshot(channelId:string):Promise<Snapshot>{
  return transaction(async client=>{
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const manifest=await currentManifest(client,channelId);
    if(!manifest.revision)return {...manifest,packets:[]};
    // Version 3 playlists require MPEG-TS packets. fMP4 is admitted only after
    // a future schema version can bind each packet to its immutable init map.
    const packets=await client.query<Packet>(
      `SELECT pi.id AS item_id,pi.item_kind,pi.segment_id,pi.interrupt_id,ir.program_state AS interrupt_state,pi.source_pts_start,
          pi.item_order,ms.media_asset_id,ms.duration_seconds,ms.discontinuity_before,
          pi.discontinuity_before AS item_discontinuity,ms.media_sequence
       FROM sloptogether.program_items pi
       LEFT JOIN sloptogether.interrupt_requests ir ON ir.id=pi.interrupt_id
       JOIN sloptogether.assets parent ON parent.id=pi.asset_id AND parent.status='published'
       JOIN sloptogether.program_media_segments ms ON ms.program_item_id=pi.id
       JOIN sloptogether.assets media ON media.id=ms.media_asset_id AND media.status='published'
         AND media.media_kind='hls_segment' AND media.sha256=ms.sha256 AND media.content_type='video/mp2t'
       WHERE pi.twitch_channel_id=$1 AND pi.program_epoch=$2 AND pi.committed_at IS NOT NULL
         AND (SELECT aa.decision FROM sloptogether.artifact_approvals aa
              WHERE aa.asset_id=parent.id AND aa.sha256=parent.sha256 ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1)='approved'
       ORDER BY pi.item_order,ms.media_sequence`,
      [channelId,manifest.epoch],
    );
    if(packets.rows.length){
      // Never silently remove a bad or partly published item: doing that would
      // shift every later browser-time mapping inside an existing epoch.
      const invalid=await client.query(
        `SELECT 1 FROM sloptogether.program_items pi JOIN sloptogether.assets parent ON parent.id=pi.asset_id
         WHERE pi.twitch_channel_id=$1 AND pi.program_epoch=$2 AND pi.committed_at IS NOT NULL AND (
           parent.status<>'published' OR
           (SELECT aa.decision FROM sloptogether.artifact_approvals aa WHERE aa.asset_id=parent.id AND aa.sha256=parent.sha256 ORDER BY aa.created_at DESC,aa.id DESC LIMIT 1) IS DISTINCT FROM 'approved' OR
           NOT EXISTS(SELECT 1 FROM sloptogether.program_media_segments ms WHERE ms.program_item_id=pi.id) OR
           EXISTS(SELECT 1 FROM sloptogether.program_media_segments ms LEFT JOIN sloptogether.assets media ON media.id=ms.media_asset_id
             WHERE ms.program_item_id=pi.id AND (media.id IS NULL OR media.status<>'published' OR media.media_kind<>'hls_segment' OR media.sha256 IS DISTINCT FROM ms.sha256 OR media.content_type IS DISTINCT FROM 'video/mp2t'))
         ) LIMIT 1`,[channelId,manifest.epoch]);
      if(invalid.rowCount)throw new ApiError(503,"program_repackaging_required","The continuous source is waiting for a complete validated publication.");
      let itemId:string|undefined;let sequence:number|undefined;
      for(const packet of packets.rows){
        if(packet.item_id!==itemId){itemId=packet.item_id;sequence=packet.media_sequence;}
        else{if(packet.media_sequence!==sequence!+1)throw new ApiError(503,"program_packet_sequence_invalid");sequence=packet.media_sequence;}
      }
    }
    return {...manifest,packets:packets.rows};
  });
}

function spansFor(packets:Packet[]){
  const spans:Array<{itemId:string;kind:"story"|"subscriber_interrupt";outputStartSeconds:number;outputEndSeconds:number;segmentId?:string;interruptId?:string;sourceStartSeconds:number;skipPlayback?:boolean}>=[];
  let duration=0;
  for(const packet of packets){
    const packetDuration=Number(packet.duration_seconds);
    if(!Number.isFinite(packetDuration)||packetDuration<=0)throw new ApiError(503,"program_packet_invalid");
    const last=spans.at(-1);
    if(last?.itemId===packet.item_id)last.outputEndSeconds+=packetDuration;
    else spans.push({itemId:packet.item_id,kind:packet.item_kind,outputStartSeconds:duration,outputEndSeconds:duration+packetDuration,
      ...(packet.segment_id?{segmentId:packet.segment_id}:{}),...(packet.interrupt_id?{interruptId:packet.interrupt_id}:{}),
      ...(packet.interrupt_state&&["played","cancelled","expired","skipped"].includes(packet.interrupt_state)?{skipPlayback:true}:{}),sourceStartSeconds:Number(packet.source_pts_start??0)});
    duration+=packetDuration;
  }
  return spans;
}

export async function getProgramManifest(locator:string){
  const channel=await findChannel(locator);
  const program=await snapshot(channel.twitch_channel_id);
  const session=await (await import("./db")).query<{active_item_id:string|null;item_offset_seconds:string;controller_epoch:string;event_sequence:string}>(
    "SELECT active_item_id,item_offset_seconds,controller_epoch,event_sequence FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1",[channel.twitch_channel_id]);
  const marker=session.rows[0];const span=marker?.active_item_id?spansFor(program.packets).find(row=>row.itemId===marker.active_item_id):undefined;
  return {
    playlistUrl:program.packets.length?`/sloptogether/api/v1/channels/${encodeURIComponent(channel.twitch_login)}/program/playlist.m3u8?epoch=${program.epoch}`:null,
    mimeType:"application/vnd.apple.mpegurl" as const,epoch:program.epoch,manifestRevision:program.revision,
    programSpans:spansFor(program.packets),controller:{canControl:false},
    playhead:span?{itemId:span.itemId,outputSeconds:span.outputStartSeconds+Number(marker!.item_offset_seconds),controllerEpoch:Number(marker!.controller_epoch),sequence:Number(marker!.event_sequence)}:null,
    continuousSourceState:program.packets.length?"ready":"waiting_for_packaging",
  };
}

export async function getProgramPlaylist(locator:string,expectedEpoch?:number){
  const channel=await findChannel(locator);
  const program=await snapshot(channel.twitch_channel_id);
  if(expectedEpoch!==undefined&&expectedEpoch!==program.epoch)throw new ApiError(409,"program_epoch_stale");
  if(!program.packets.length)throw new ApiError(404,"continuous_program_not_ready","The continuous program is waiting for validated HLS media.");
  const target=Math.max(1,...program.packets.map(packet=>Math.ceil(Number(packet.duration_seconds))));
  const lines=["#EXTM3U","#EXT-X-VERSION:3",`#EXT-X-TARGETDURATION:${target}`,"#EXT-X-MEDIA-SEQUENCE:0","#EXT-X-PLAYLIST-TYPE:EVENT"];
  let previousItem:string|undefined;
  for(const packet of program.packets){
    if(packet.discontinuity_before||(previousItem!==undefined&&packet.item_id!==previousItem)||packet.item_discontinuity&&packet.item_id!==previousItem)lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${Number(packet.duration_seconds).toFixed(6)},`,`/sloptogether/api/v1/media/${encodeURIComponent(packet.media_asset_id)}`);
    previousItem=packet.item_id;
  }
  return {body:lines.join("\n")+"\n",epoch:program.epoch,manifestRevision:program.revision};
}

async function authorizeController(locator:string,request:Request){
  const channel=await findChannel(locator);
  const principal=await requestPrincipal(request);
  const actor=await requireStreamerController(channel,principal);
  if(await isBanned(channel.twitch_channel_id,actor))throw new ApiError(403,"channel_ban_active");
  if(principal?.kind==="session")assertSameOrigin(request);
  return {channel,principal:principal!,actor};
}

function keyId(principal:RequestPrincipal){return principal.kind==="worker-key"?principal.worker.keyId:null;}

export async function claimPlaybackController(locator:string,request:Request){
  const {channel,principal,actor}=await authorizeController(locator,request);
  const body=await readJson(request,z.object({clientInstanceId:z.string().uuid(),takeover:z.boolean().optional()}).strict());
  return transaction(async client=>{
    await client.query("INSERT INTO sloptogether.playback_sessions(twitch_channel_id) VALUES($1) ON CONFLICT(twitch_channel_id) DO NOTHING",[channel.twitch_channel_id]);
    const result=await client.query<{id:string;controller_user_id:string|null;controller_epoch:string;lease_expires_at:Date|null}>(
      "SELECT id,controller_user_id,controller_epoch,lease_expires_at FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1 FOR UPDATE",[channel.twitch_channel_id]);
    const current=result.rows[0]!;
    const latest=await client.query<{after_state:{clientInstanceId?:string}|null}>(
      "SELECT after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='playback.controller.claim' AND target_id=$2 ORDER BY id DESC LIMIT 1",[channel.twitch_channel_id,current.id]);
    const sameBrowser=current.controller_user_id===actor&&latest.rows[0]?.after_state?.clientInstanceId===body.clientInstanceId;
    if(current.lease_expires_at&&current.lease_expires_at.getTime()>Date.now()&&!sameBrowser&&!body.takeover){
      return {canControl:false,controllerEpoch:Number(current.controller_epoch),leaseExpiresAt:current.lease_expires_at.toISOString()};
    }
    const updated=await client.query<{controller_epoch:string;lease_expires_at:Date}>(
      "UPDATE sloptogether.playback_sessions SET controller_user_id=$2,controller_epoch=controller_epoch+1,event_sequence=0,lease_expires_at=now()+interval '25 seconds',updated_at=now() WHERE twitch_channel_id=$1 RETURNING controller_epoch,lease_expires_at",[channel.twitch_channel_id,actor]);
    const row=updated.rows[0]!;
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'playback.controller.claim','playback_session',$4,$5::jsonb)",
      [channel.twitch_channel_id,actor,keyId(principal),current.id,JSON.stringify({clientInstanceId:body.clientInstanceId,controllerEpoch:Number(row.controller_epoch),takeover:Boolean(body.takeover)})]);
    return {canControl:true,leaseId:current.id,controllerEpoch:Number(row.controller_epoch),leaseExpiresAt:row.lease_expires_at.toISOString()};
  });
}

export async function heartbeatPlayback(locator:string,request:Request){
  const {channel,principal,actor}=await authorizeController(locator,request);
  const body=await readJson(request,z.object({itemId:z.string().uuid(),offsetSeconds:z.number().min(0).max(1e9),controllerEpoch:z.number().int().positive(),programEpoch:z.number().int().positive(),manifestRevision:z.number().int().positive(),sequence:z.number().int().positive()}).strict());
  return transaction(async client=>{
    const session=await client.query<{id:string;controller_user_id:string|null;controller_epoch:string;event_sequence:string;lease_expires_at:Date|null;active_item_id:string|null}>(
      "SELECT id,controller_user_id,controller_epoch,event_sequence,lease_expires_at,active_item_id FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1 FOR UPDATE",[channel.twitch_channel_id]);
    const row=session.rows[0];
    if(!row||row.controller_user_id!==actor||Number(row.controller_epoch)!==body.controllerEpoch||!row.lease_expires_at||row.lease_expires_at.getTime()<=Date.now())throw new ApiError(409,"playback_controller_stale");
    if(body.sequence<=Number(row.event_sequence))throw new ApiError(409,"playback_sequence_stale");
    const manifest=await currentManifest(client,channel.twitch_channel_id);
    if(manifest.epoch!==body.programEpoch||body.manifestRevision>manifest.revision)throw new ApiError(409,"playback_manifest_stale");
    const item=await client.query<{id:string;segment_id:string|null;interrupt_id:string|null;source_pts_start:string|null;duration_seconds:string}>(
      `SELECT pi.id,pi.segment_id,pi.interrupt_id,pi.source_pts_start,sum(ms.duration_seconds)::text AS duration_seconds
       FROM sloptogether.program_items pi JOIN sloptogether.program_media_segments ms ON ms.program_item_id=pi.id
       WHERE pi.twitch_channel_id=$1 AND pi.program_epoch=$2 AND pi.committed_at IS NOT NULL
         AND (pi.id=$3 OR pi.segment_id=$3 OR pi.interrupt_id=$3)
       GROUP BY pi.id ORDER BY pi.item_order DESC LIMIT 1`,[channel.twitch_channel_id,body.programEpoch,body.itemId]);
    const target=item.rows[0];if(!target)throw new ApiError(404,"playback_item_not_committed");
    const localOffset=body.offsetSeconds-Number(target.source_pts_start??0);
    if(localOffset<0||localOffset>Number(target.duration_seconds)+0.5)throw new ApiError(422,"playback_position_out_of_range");
    await client.query("UPDATE sloptogether.playback_sessions SET active_item_id=$2,item_offset_seconds=$3,event_sequence=$4,lease_expires_at=now()+interval '25 seconds',updated_at=now() WHERE id=$1",[row.id,target.id,Math.min(localOffset,Number(target.duration_seconds)),body.sequence]);
    if(target.segment_id)await client.query("UPDATE sloptogether.segments SET state='played' WHERE id=$1 AND state='ready'",[target.segment_id]);
    if(target.interrupt_id)await client.query("UPDATE sloptogether.interrupt_requests SET program_state='playing' WHERE id=$1 AND program_state IN ('ready','scheduled')",[target.interrupt_id]);
    if(row.active_item_id&&row.active_item_id!==target.id){
      await client.query("UPDATE sloptogether.interrupt_requests SET program_state='played',played_at=coalesce(played_at,now()) WHERE id=(SELECT interrupt_id FROM sloptogether.program_items WHERE id=$1) AND program_state='playing'",[row.active_item_id]);
    }
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state) VALUES($1,$2,$3,'playback.position','program_item',$4,$5::jsonb)",
      [channel.twitch_channel_id,actor,keyId(principal),target.id,JSON.stringify({offsetSeconds:localOffset,controllerEpoch:body.controllerEpoch,programEpoch:body.programEpoch,manifestRevision:body.manifestRevision,sequence:body.sequence})]);
    return {accepted:true,itemId:target.id,offsetSeconds:localOffset,sequence:body.sequence,controllerEpoch:body.controllerEpoch};
  });
}
