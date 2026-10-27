import { z } from "zod";
import { compileH3StoryPrompt, h3StoryPromptPlanSchema } from "@sloptogether/contracts";
import { findChannel, isBanned, requireStreamerController } from "./channels";
import { transaction } from "./db";
import { ApiError, assertSameOrigin, readJson } from "./http";
import { screenPromptAndImages } from "./preflight";
import { requestPrincipal } from "./principals";
import { candidateStream, streamBoundary } from "./story-candidate-service";
import { getStream } from "./stream-service";
import { resolveCandidateElections } from "./candidate-election";

const input = z.object({
  prompt: z.string().trim().min(1).max(1000),
  boundaryRevisionId: z.string().uuid(),
  expectedCandidateRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

/** The broadcaster explicitly supplies and approves one screened future candidate. */
export async function submitOwnerCandidate(locator:string,itemId:string,request:Request,streamSlug:string) {
  assertSameOrigin(request);
  if (!z.string().uuid().safeParse(itemId).success) throw new ApiError(400,"story_candidate_id_invalid");
  const channel=await findChannel(locator);
  const principal=await requestPrincipal(request);
  // This is an interactive broadcaster action, not a worker or extension grant.
  if (!principal || principal.kind!=="session") throw new ApiError(403,"broadcaster_session_required");
  const actor=await requireStreamerController(channel,principal);
  const stream=await getStream(channel.twitch_channel_id,streamSlug);
  const body=await readJson(request,input);
  const plan=h3StoryPromptPlanSchema.parse({visualAction:body.prompt,camera:"One continuous shot follows the action.",
    speakerId:"S1",speakerCharacter:"a character in the scene",voiceDescription:"a playful clear voice",
    dialogue:"Here we go!",soundscape:"Environmental sounds matching the action.",music:"none"});
  const prompt=compileH3StoryPrompt(plan);
  const screen=await screenPromptAndImages({channelId:channel.twitch_channel_id,prompt,images:[]});
  if(screen.decision!=="clear") throw new ApiError(409,"input_screen_not_clear");
  // Resolve an expired vote first, without rolling its winner back if this
  // request turns out to carry a stale candidate revision.
  await transaction(async client=>{
    const lock=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!lock.rows[0] || lock.rows[0].policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(await isBanned(channel.twitch_channel_id,actor,client))throw new ApiError(403,"channel_ban_active");
    const candidate=await client.query<{segment_id:string}>(`SELECT i.segment_id FROM sloptogether.story_batch_items i
      JOIN sloptogether.story_batches b ON b.id=i.batch_id WHERE i.id=$1 AND b.twitch_channel_id=$2 AND b.stream_id=$3`,[itemId,channel.twitch_channel_id,stream.id]);
    if(candidate.rows[0]?.segment_id)await resolveCandidateElections(client,channel.twitch_channel_id,candidate.rows[0].segment_id);
  });
  return transaction(async client=>{
    const lock=await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND is_enabled FOR UPDATE",[channel.twitch_channel_id]);
    if(!lock.rows[0] || lock.rows[0].policy_revision!==channel.policy_revision)throw new ApiError(409,"channel_policy_changed");
    if(await isBanned(channel.twitch_channel_id,actor,client))throw new ApiError(403,"channel_ban_active");
    const item=await client.query<{segment_id:string;candidate_revision:string;candidate_plan:unknown;state:string;segment_state:string;approved_at:Date|null;rejected_at:Date|null;protected_at:Date|null;selected_revision_id:string|null}>(`SELECT i.segment_id,i.candidate_revision::text,i.candidate_plan,i.state,s.state AS segment_state,i.approved_at,i.rejected_at,s.protected_at,s.selected_revision_id
      FROM sloptogether.story_batch_items i JOIN sloptogether.story_batches batch ON batch.id=i.batch_id
      JOIN sloptogether.segments s ON s.id=i.segment_id
      WHERE i.id=$1 AND batch.twitch_channel_id=$2 AND batch.stream_id=$3 AND ${candidateStream} FOR UPDATE OF i,s`,[itemId,channel.twitch_channel_id,stream.id]);
    const current=item.rows[0];
    if(!current)throw new ApiError(404,"story_candidate_not_found");
    if(current.state!=="planned" || !["open","voting"].includes(current.segment_state) || !current.candidate_plan || current.approved_at || current.rejected_at || current.protected_at || current.selected_revision_id)throw new ApiError(409,"story_candidate_not_editable");
    if(Number(current.candidate_revision)!==body.expectedCandidateRevision)throw new ApiError(409,"story_candidate_changed");
    const election=await client.query("SELECT 1 FROM sloptogether.elections WHERE segment_id=$1 AND state='open' LIMIT 1",[current.segment_id]);
    if(election.rowCount)throw new ApiError(409,"story_candidate_vote_open");
    const frame=await client.query(`SELECT b.id FROM sloptogether.boundary_revisions b JOIN sloptogether.assets a ON a.id=b.asset_id
      WHERE b.twitch_channel_id=$1 AND b.retired_at IS NULL AND a.twitch_channel_id=$1
      AND a.media_kind='image' AND a.status IN ('approved','published') AND a.sha256 IS NOT NULL
      AND ${streamBoundary} AND b.id=$3 FOR SHARE OF b,a`,[channel.twitch_channel_id,stream.id,body.boundaryRevisionId]);
    if(!frame.rowCount)throw new ApiError(409,"story_start_frame_not_approved");
    const updated=await client.query<{candidate_revision:string}>(`UPDATE sloptogether.story_batch_items
      SET candidate_prompt=$2,candidate_plan=$6::jsonb,
        start_boundary_revision_id=$3,candidate_revision=candidate_revision+1,
        approved_by=$4,approved_at=now(),approved_candidate_revision=candidate_revision+1
      WHERE id=$1 AND candidate_revision=$5 AND state='planned' AND approved_at IS NULL AND rejected_at IS NULL
      RETURNING candidate_revision::text`,[itemId,prompt,body.boundaryRevisionId,actor,body.expectedCandidateRevision,JSON.stringify(plan)]);
    if(!updated.rows[0])throw new ApiError(409,"story_candidate_changed");
    const revision=Number(updated.rows[0].candidate_revision);
    await client.query(`INSERT INTO sloptogether.audit_log(twitch_channel_id,actor_twitch_user_id,action,target_kind,target_id,after_state)
      VALUES($1,$2,'story.candidate.owner_submitted','story_batch_item',$3,$4::jsonb)`,[channel.twitch_channel_id,actor,itemId,JSON.stringify({streamId:stream.id,candidateRevision:revision,startBoundaryRevisionId:body.boundaryRevisionId,inputScreenDigest:screen.digest})]);
    return {itemId,state:"planned",candidateRevision:revision,approved:true,startBoundaryRevisionId:body.boundaryRevisionId};
  });
}
