import type { QueryResultRow } from "pg";
import type { PublicChannelSummary } from "@sloptogether/contracts";
import type { ChannelRow } from "./channels";
import { principalTwitchId } from "./channels";
import type { RequestPrincipal } from "./principals";
import { query } from "./db";
import { ApiError } from "./http";

interface SegmentRow extends QueryResultRow {
  id: string;
  ordinal: string;
  prompt: string;
  state: string;
  duration_seconds: string | null;
  asset_id: string | null;
  item_kind: string | null;
  program_item_id: string | null;
  upscale_asset_id: string | null;
  subscriber_label: string | null;
  vote_count: string;
  my_choice_id: string | null;
}

const electionSql = [
  "SELECT e.id,e.segment_id,e.state,e.closes_at,p.id AS choice_id,",
  "       coalesce(p.prompt,'Scene proposal') AS choice_title,count(b.twitch_user_id)::text AS vote_count,",
  "       bool_or(b.twitch_user_id=$2) AS my_choice",
  "FROM sloptogether.elections e",
  "JOIN sloptogether.proposals p ON p.election_id=e.id AND p.state='eligible' AND p.segment_revision_id IS NOT NULL",
  "JOIN sloptogether.input_screens isc ON isc.id=p.input_screen_id AND isc.effective_state='clear' AND (isc.expires_at IS NULL OR isc.expires_at>now())",
  "AND NOT EXISTS(SELECT 1 FROM sloptogether.bans pb WHERE pb.twitch_user_id=p.author_twitch_user_id AND pb.revoked_at IS NULL AND (pb.expires_at IS NULL OR pb.expires_at>now()) AND (pb.scope='global' OR pb.twitch_channel_id=$1))",
  "LEFT JOIN sloptogether.ballots b ON b.election_id=e.id AND b.proposal_id=p.id",
  "WHERE e.state='open' AND e.closes_at>now() AND EXISTS",
  " (SELECT 1 FROM sloptogether.segments s WHERE s.id=e.segment_id AND s.twitch_channel_id=$1)",
  "GROUP BY e.id,e.segment_id,e.state,e.closes_at,p.id,p.prompt ORDER BY e.closes_at,p.created_at",
].join("\n");

const segmentsSql = [
  "SELECT s.id,s.ordinal,s.state,coalesce(sr.prompt,'') AS prompt,",
  "       coalesce(base_asset.duration_seconds,public_asset.duration_seconds) AS duration_seconds,",
  "       coalesce(base_asset.id,public_asset.id) AS asset_id,",
  "       public_asset.program_item_id,",
  "       (SELECT derivative.id FROM sloptogether.jobs uj JOIN sloptogether.job_attempts uja ON uja.job_id=uj.id",
  "         JOIN sloptogether.assets derivative ON derivative.id=uja.output_asset_id AND derivative.status='approved'",
  "         JOIN LATERAL(SELECT decision FROM sloptogether.artifact_approvals ua WHERE ua.asset_id=derivative.id AND ua.sha256=derivative.sha256 ORDER BY ua.created_at DESC,ua.id DESC LIMIT 1) approval ON approval.decision='approved'",
  "         WHERE uj.parent_asset_id=public_asset.id AND uj.stage='video_upscale' AND uj.state='succeeded' ORDER BY uj.completed_at DESC LIMIT 1) AS upscale_asset_id,",
  "       current_interrupt.interrupt_id AS subscriber_interrupt_id,current_interrupt.item_kind,",
  "       coalesce(votes.count,0)::text AS vote_count,my_ballot.proposal_id AS my_choice_id",
  "FROM sloptogether.segments s",
  "LEFT JOIN sloptogether.segment_revisions sr ON sr.id=s.selected_revision_id",
  "LEFT JOIN LATERAL (",
  "  SELECT a.id,a.duration_seconds FROM sloptogether.jobs j",
  "  JOIN sloptogether.job_attempts ja ON ja.job_id=j.id AND ja.state IN ('succeeded','rejected')",
  "  JOIN sloptogether.assets a ON a.id=ja.output_asset_id AND a.status IN ('approved','published')",
  "  JOIN sloptogether.artifact_approvals aa ON aa.asset_id=a.id AND aa.sha256=a.sha256 AND aa.decision='approved'",
  "  WHERE j.segment_revision_id=sr.id AND j.stage='video_base'",
  "  ORDER BY ja.finished_at DESC LIMIT 1",
  ") base_asset ON true",
  "LEFT JOIN LATERAL (",
  "  SELECT pi.id AS program_item_id,a.id,a.duration_seconds FROM sloptogether.program_items pi",
  "  JOIN sloptogether.assets a ON a.id=pi.asset_id AND a.status='published'",
  "  WHERE pi.segment_id=s.id AND pi.twitch_channel_id=s.twitch_channel_id AND pi.committed_at IS NOT NULL",
  "  ORDER BY pi.program_epoch DESC,pi.item_order DESC LIMIT 1",
  ") public_asset ON true",
  "LEFT JOIN LATERAL (",
  "  SELECT pi.interrupt_id,pi.item_kind FROM sloptogether.program_items pi",
  "  WHERE pi.segment_id=s.id ORDER BY pi.program_epoch DESC,pi.item_order DESC LIMIT 1",
  ") current_interrupt ON true",
  "LEFT JOIN LATERAL (",
  "  SELECT count(*) AS count FROM sloptogether.elections e",
  "  JOIN sloptogether.proposals p ON p.election_id=e.id AND p.state='eligible'",
  "  JOIN sloptogether.ballots b ON b.election_id=e.id AND b.proposal_id=p.id",
  "  WHERE e.segment_id=s.id AND e.state='open'",
  ") votes ON true",
  "LEFT JOIN LATERAL (",
  "  SELECT b.proposal_id FROM sloptogether.ballots b",
  "  JOIN sloptogether.elections e ON e.id=b.election_id",
  "  WHERE e.segment_id=s.id AND e.state='open' AND b.twitch_user_id=$2 LIMIT 1",
  ") my_ballot ON true",
  "WHERE s.twitch_channel_id=$1 AND s.state<>'retired'",
  "ORDER BY s.ordinal LIMIT 80",
].join("\n");

export async function getActiveElections(channelId: string, principal: RequestPrincipal | null) {
  const userId = principalTwitchId(principal);
  const result = await query<{
    id:string; segment_id:string; state:string; closes_at:Date;
    choice_id:string; choice_title:string; vote_count:string; my_choice:boolean;
  }>(electionSql,[channelId,userId]);
  const grouped = new Map<string,{
    id:string; segmentId:string; state:"open"; closesAt:string;
    choices:Array<{id:string;title:string;votes:number;voteCount:number}>; myChoiceId:string|null;myVote:{choiceId:string}|null;
  }>();
  for(const row of result.rows){
    let election=grouped.get(row.id);
    if(!election){
      election={id:row.id,segmentId:row.segment_id,state:"open",closesAt:row.closes_at.toISOString(),choices:[],myChoiceId:null,myVote:null};
      grouped.set(row.id,election);
    }
    election.choices.push({id:row.choice_id,title:row.choice_title,votes:Number(row.vote_count),voteCount:Number(row.vote_count)});
    if(row.my_choice){election.myChoiceId=row.choice_id;election.myVote={choiceId:row.choice_id};}
  }
  return [...grouped.values()];
}

export async function getPublicTimeline(channel:ChannelRow,principal:RequestPrincipal|null):Promise<{
  channel:{twitchChannelId:string;twitchLogin:string;displayName:string;visibility:string};
  segments:PublicChannelSummary["segments"] & Array<Record<string,unknown>>;
  elections:Awaited<ReturnType<typeof getActiveElections>>;
  currentProgramItem:{id:string;segmentId:string|null;kind:"story"|"subscriber_interrupt";assetUrl:string;upscaleUrl?:string;mimeType:string;subscriberLabel?:string;durationSeconds:number}|null;
  playback:{offsetSeconds:number;sequence:number;sourceController:"this_browser"|"another_browser"|"offline";controllerEpoch:number;programEpoch:number;manifestRevision:number;updatedAt:string|null};
  revision:number;
}>{
  const twitchUserId=principalTwitchId(principal);
  const [segmentsResult,elections,programResult,playbackResult,manifestResult]=await Promise.all([
    query<SegmentRow>(segmentsSql,[channel.twitch_channel_id,twitchUserId]),
    getActiveElections(channel.twitch_channel_id,principal),
    query<{id:string;segment_id:string|null;item_kind:string;asset_id:string;duration_seconds:string|null;subscriber_label:string|null;upscale_asset_id:string|null}>(
      `SELECT pi.id,pi.segment_id,pi.item_kind,pi.asset_id,a.duration_seconds,ir.subscriber_label,
       (SELECT derivative.id FROM sloptogether.jobs uj JOIN sloptogether.job_attempts uja ON uja.job_id=uj.id
         JOIN sloptogether.assets derivative ON derivative.id=uja.output_asset_id AND derivative.status='approved'
         JOIN LATERAL(SELECT decision FROM sloptogether.artifact_approvals ua WHERE ua.asset_id=derivative.id AND ua.sha256=derivative.sha256 ORDER BY ua.created_at DESC,ua.id DESC LIMIT 1) approval ON approval.decision='approved'
         WHERE uj.parent_asset_id=pi.asset_id AND uj.stage='video_upscale' AND uj.state='succeeded' ORDER BY uj.completed_at DESC LIMIT 1) AS upscale_asset_id `+
      "FROM sloptogether.playback_sessions ps JOIN sloptogether.program_items pi ON pi.id=ps.active_item_id "+
      "JOIN sloptogether.assets a ON a.id=pi.asset_id AND a.status='published' "+
      "LEFT JOIN sloptogether.interrupt_requests ir ON ir.id=pi.interrupt_id "+
      "WHERE ps.twitch_channel_id=$1 AND pi.committed_at IS NOT NULL LIMIT 1",[channel.twitch_channel_id]),
    query<{item_offset_seconds:string;event_sequence:string;controller_user_id:string|null;lease_expires_at:Date|null;controller_epoch:string}>(
      "SELECT item_offset_seconds,event_sequence,controller_user_id,lease_expires_at,controller_epoch "+
      "FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1",[channel.twitch_channel_id]),
    query<{program_epoch:string;manifest_revision:string}>("SELECT program_epoch,manifest_revision FROM sloptogether.program_manifests WHERE twitch_channel_id=$1 ORDER BY program_epoch DESC LIMIT 1",[channel.twitch_channel_id]),
  ]);
  const playback=playbackResult.rows[0];
  const items=segmentsResult.rows.map(row=>({
    id:row.id,ordinal:Number(row.ordinal),promptPreview:row.prompt.slice(0,180),
    durationSeconds:row.duration_seconds===null?null:Number(row.duration_seconds),programItemId:row.program_item_id,
    state:row.asset_id?(row.state==="played"?"played":"ready"):(row.state==="open"||row.state==="voting"?"voting":row.state) as PublicChannelSummary["segments"][number]["state"],
    mediaUrl:row.asset_id?"/sloptogether/api/v1/media/"+encodeURIComponent(row.asset_id):undefined,
    upscaleUrl:row.upscale_asset_id?"/sloptogether/api/v1/media/"+encodeURIComponent(row.upscale_asset_id):undefined,
    voteCount:Number(row.vote_count),myChoiceId:row.my_choice_id,
    kind:row.item_kind==="subscriber_interrupt"?"subscriber_interrupt":"story",
  }));
  const current=programResult.rows[0];
  const programEpoch=Number(manifestResult.rows[0]?.program_epoch??1);
  return {
    channel:{twitchChannelId:channel.twitch_channel_id,twitchLogin:channel.twitch_login,displayName:channel.display_name,visibility:channel.visibility},
    segments:items as PublicChannelSummary["segments"] & Array<Record<string,unknown>>,
    elections,
    currentProgramItem:current?{
      id:current.id,segmentId:current.segment_id,kind:current.item_kind==="subscriber_interrupt"?"subscriber_interrupt":"story",
      assetUrl:"/sloptogether/api/v1/media/"+encodeURIComponent(current.asset_id),
      upscaleUrl:current.upscale_asset_id?"/sloptogether/api/v1/media/"+encodeURIComponent(current.upscale_asset_id):undefined,
      mimeType:"video/mp4",subscriberLabel:current.subscriber_label??undefined,durationSeconds:Number(current.duration_seconds??0),
    }:null,
    playback:{
      offsetSeconds:Number(playback?.item_offset_seconds??0),sequence:Number(playback?.event_sequence??0),
      sourceController:playback?.lease_expires_at&&playback.lease_expires_at.getTime()>Date.now()?(playback.controller_user_id===twitchUserId?"this_browser":"another_browser"):"offline",
      controllerEpoch:Number(playback?.controller_epoch??1),programEpoch,manifestRevision:Number(manifestResult.rows[0]?.manifest_revision??0),updatedAt:playback?.lease_expires_at?.toISOString()??null,
    },
    revision:channel.layout_revision,
  };
}

export async function publishedAsset(channelId:string,assetId:string){
  const result=await query<{id:string;storage_key:string;content_type:string|null}>(
    "SELECT a.id,a.storage_key,a.content_type FROM sloptogether.assets a "+
    "WHERE a.id=$1 AND a.twitch_channel_id=$2 AND a.status='published' "+
    "AND EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.asset_id=a.id AND pi.twitch_channel_id=$2 AND pi.committed_at IS NOT NULL)",
    [assetId,channelId],
  );
  const row=result.rows[0];if(!row)throw new ApiError(404,"media_not_found");return row;
}
