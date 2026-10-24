import { ApiError } from "./http";
import { type RequestPrincipal } from "./principals";
import { isBanned, principalTwitchId } from "./channels";
import { transaction } from "./db";

export async function castBallot(electionId:string,choiceId:string,principal:RequestPrincipal,sourceSurface:"extension"|"chat"|"website",messageId?:string){
  if(principal.kind!=="session"&&principal.kind!=="extension"&&principal.kind!=="chat")throw new ApiError(403,"voter_identity_required");
  const userId=principalTwitchId(principal);if(!userId)throw new ApiError(403,"linked_identity_required");
  return transaction(async(client)=>{
    const result=await client.query<{id:string;closes_at:Date;state:string;twitch_channel_id:string}>(
      "SELECT e.id,e.closes_at,e.state,s.twitch_channel_id FROM sloptogether.elections e JOIN sloptogether.segments s ON s.id=e.segment_id WHERE e.id=$1 FOR UPDATE OF e",
      [electionId]);
    const election=result.rows[0];if(!election)throw new ApiError(404,"election_not_found");
    if(principal.kind==="chat"&&principal.channelId!==election.twitch_channel_id)throw new ApiError(403,"chat_channel_mismatch");
    if(principal.kind==="extension"&&principal.extension.channelId!==election.twitch_channel_id)throw new ApiError(403,"extension_channel_mismatch");
    if(election.state!=="open"||election.closes_at.getTime()<=Date.now())throw new ApiError(409,"election_closed");
    if(await isBanned(election.twitch_channel_id,userId))throw new ApiError(403,"channel_ban_active");
    const choice=await client.query(
      `SELECT 1 FROM sloptogether.proposals p JOIN sloptogether.input_screens s ON s.id=p.input_screen_id
       WHERE p.id=$1 AND p.election_id=$2 AND p.state='eligible' AND p.segment_revision_id IS NOT NULL
         AND s.effective_state='clear' AND (s.expires_at IS NULL OR s.expires_at>now())
       AND NOT EXISTS(SELECT 1 FROM sloptogether.bans b WHERE b.twitch_user_id=p.author_twitch_user_id AND b.revoked_at IS NULL
         AND (b.expires_at IS NULL OR b.expires_at>now()) AND (b.scope='global' OR b.twitch_channel_id=$3))`,[choiceId,electionId,election.twitch_channel_id]);
    if(!choice.rowCount)throw new ApiError(409,"choice_not_eligible");
    if(sourceSurface==="chat"&&messageId){
      const receipt=await client.query(
        "INSERT INTO sloptogether.chat_event_receipts(twitch_message_id,broadcaster_twitch_id,chatter_twitch_user_id,normalized_command,event_at,processed_at,result_code) VALUES($1,$2,$3,$4,now(),now(),'ballot') ON CONFLICT(twitch_message_id) DO NOTHING RETURNING twitch_message_id",
        [messageId,election.twitch_channel_id,userId,"vote "+choiceId]);
      if(!receipt.rowCount)return {electionId,choiceId,state:"duplicate_event"};
    }
    const ballot=await client.query<{revision:number}>(
      "INSERT INTO sloptogether.ballots(election_id,twitch_user_id,proposal_id,source_surface) VALUES($1,$2,$3,$4) ON CONFLICT(election_id,twitch_user_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id,source_surface=EXCLUDED.source_surface,revision=sloptogether.ballots.revision+1,updated_at=now() RETURNING revision",
      [electionId,userId,choiceId,sourceSurface]);
    await client.query(
      "INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state) VALUES($1,$2,'election.ballot','election',$3,$4::jsonb)",
      [election.twitch_channel_id,userId,electionId,JSON.stringify({choiceId,sourceSurface,revision:ballot.rows[0]?.revision})]);
    return {electionId,choiceId,state:"recorded"};
  });
}
