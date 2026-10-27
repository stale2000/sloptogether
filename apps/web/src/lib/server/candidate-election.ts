import type { PoolClient } from "pg";
import { compileH3StoryPrompt, h3StoryPromptPlanSchema } from "@sloptogether/contracts";

/** Called under the channel lock; a winner changes a draft, never dispatches work. */
export async function resolveCandidateElections(client:PoolClient,channelId:string,segmentId?:string,streamId?:string) {
  const elections=await client.query<{id:string;segment_id:string;item_id:string}>(`SELECT e.id,e.segment_id,i.id AS item_id
    FROM sloptogether.elections e JOIN sloptogether.segments s ON s.id=e.segment_id
    JOIN sloptogether.story_batch_items i ON i.segment_id=s.id
    JOIN sloptogether.story_batches b ON b.id=i.batch_id AND b.twitch_channel_id=s.twitch_channel_id
    JOIN sloptogether.branches br ON br.id=s.branch_id AND br.stream_id=b.stream_id AND br.is_selected AND br.archived_at IS NULL
    WHERE s.twitch_channel_id=$1 AND ($2::uuid IS NULL OR s.id=$2) AND ($3::uuid IS NULL OR b.stream_id=$3) AND e.state='open' AND e.closes_at<=now()
    ORDER BY e.closes_at,e.id LIMIT 10 FOR UPDATE OF e,s,i SKIP LOCKED`,[channelId,segmentId??null,streamId??null]);
  for(const e of elections.rows){
    const candidate=await client.query<{state:string;approved_at:Date|null;rejected_at:Date|null;protected_at:Date|null;selected_revision_id:string|null;candidate_plan:Record<string,unknown>}>(`SELECT i.state,i.approved_at,i.rejected_at,s.protected_at,s.selected_revision_id,i.candidate_plan
      FROM sloptogether.story_batch_items i JOIN sloptogether.segments s ON s.id=i.segment_id WHERE i.id=$1`,[e.item_id]);
    const c=candidate.rows[0];
    const winner=c&&c.state==='planned'&&!c.approved_at&&!c.rejected_at&&!c.protected_at&&!c.selected_revision_id
      ? await client.query<{id:string;prompt:string}>(`SELECT p.id,p.prompt FROM sloptogether.proposals p JOIN sloptogether.input_screens isc ON isc.id=p.input_screen_id
        WHERE p.election_id=$1 AND p.state='eligible' AND p.segment_revision_id IS NULL AND p.prompt IS NOT NULL
          AND isc.effective_state='clear' AND (isc.expires_at IS NULL OR isc.expires_at>now())
          AND NOT EXISTS(SELECT 1 FROM sloptogether.bans ban WHERE ban.twitch_user_id=p.author_twitch_user_id AND ban.revoked_at IS NULL
            AND (ban.expires_at IS NULL OR ban.expires_at>now()) AND (ban.scope='global' OR ban.twitch_channel_id=$2))
        ORDER BY (SELECT count(*) FROM sloptogether.ballots v WHERE v.election_id=p.election_id AND v.proposal_id=p.id) DESC,p.created_at,p.id LIMIT 1`,[e.id,channelId]) : null;
    const selected=winner?.rows[0];
    if(!selected){await client.query("UPDATE sloptogether.elections SET state='closed' WHERE id=$1",[e.id]);continue;}
    // Do not carry character-specific dialogue or sound from the replaced
    // story action into an unrelated viewer suggestion.
    const plan=h3StoryPromptPlanSchema.safeParse({...c!.candidate_plan,visualAction:selected.prompt,
      camera:"One continuous shot follows the action.",speakerId:"S1",speakerCharacter:"a character in the scene",
      voiceDescription:"a playful clear voice",dialogue:"Here we go!",soundscape:"Environmental sounds matching the action.",music:"none"});
    if(!plan.success){await client.query("UPDATE sloptogether.elections SET state='closed' WHERE id=$1",[e.id]);continue;}
    // The selected action is compiled into a neutral H3 plan and the whole
    // prompt plus both anchors are screened again by pair admission.
    await client.query(`UPDATE sloptogether.story_batch_items SET candidate_prompt=$2,candidate_plan=$3::jsonb,
      candidate_revision=candidate_revision+1 WHERE id=$1 AND state='planned' AND approved_at IS NULL AND rejected_at IS NULL`,
      [e.item_id,compileH3StoryPrompt(plan.data),JSON.stringify(plan.data)]);
    await client.query("UPDATE sloptogether.elections SET state='selected',winner_proposal_id=$2 WHERE id=$1",[e.id,selected.id]);
    await client.query("UPDATE sloptogether.proposals SET state=CASE WHEN id=$2 THEN 'selected' WHEN state='eligible' THEN 'superseded' ELSE state END WHERE election_id=$1",[e.id,selected.id]);
    await client.query("INSERT INTO sloptogether.audit_log(twitch_channel_id,action,target_kind,target_id,after_state) VALUES($1,'story.candidate.vote_resolved','story_batch_item',$2,$3::jsonb)",[channelId,e.item_id,JSON.stringify({electionId:e.id,winnerProposalId:selected.id})]);
  }
}
