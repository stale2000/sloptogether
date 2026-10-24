import type { PoolClient } from "pg";

/** Retire uncommitted content attempts whose trusted worker was disabled before upload. */
export async function retireRevokedWorkerJobs(client:PoolClient,jobIds:string[],reason:string){
  if(!jobIds.length)return;
  await client.query(`UPDATE sloptogether.funding_authorizations SET state='consumed_failed',consumed_at=coalesce(consumed_at,now()),settled_at=now()
    WHERE id IN (SELECT coalesce(a.funding_id,j.funding_id) FROM sloptogether.jobs j LEFT JOIN sloptogether.job_attempts a ON a.job_id=j.id
      WHERE j.id=ANY($1::uuid[]) AND j.stage='video_base') AND state IN ('reserved','consumed_uncertain')`,[jobIds]);
  const alerts=await client.query<{id:string}>("SELECT interrupt_id AS id FROM sloptogether.jobs WHERE id=ANY($1::uuid[]) AND interrupt_id IS NOT NULL",[jobIds]);
  const interruptIds=alerts.rows.map(row=>row.id);
  if(interruptIds.length){
    await client.query("UPDATE sloptogether.interrupt_requests SET program_state='failed' WHERE id=ANY($1::uuid[]) AND program_state NOT IN ('played','cancelled','expired','skipped')",[interruptIds]);
    await client.query("UPDATE sloptogether.subscription_events SET state='failed' WHERE interrupt_id=ANY($1::uuid[]) AND state NOT IN ('played','cancelled','expired')",[interruptIds]);
  }
  const rows=await client.query<{revision_id:string;segment_id:string}>(`SELECT DISTINCT r.id AS revision_id,s.id AS segment_id
    FROM sloptogether.jobs j JOIN sloptogether.segment_revisions r ON r.id=j.segment_revision_id
    JOIN sloptogether.segments s ON s.id=r.segment_id
    WHERE j.id=ANY($1::uuid[]) AND j.stage='video_base' AND s.selected_revision_id=r.id
      AND s.state NOT IN ('played','retired')
      AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`,[jobIds]);
  for(const row of rows.rows){
    await client.query("UPDATE sloptogether.proposals SET state='rejected',reviewed_at=now(),review_reason=$2 WHERE segment_revision_id=$1 AND state='selected'",[row.revision_id,reason]);
    await client.query("UPDATE sloptogether.elections SET state='closed',winner_proposal_id=NULL,closed_by=NULL WHERE segment_id=$1 AND state='selected'",[row.segment_id]);
    await client.query("UPDATE sloptogether.segment_revisions SET state='superseded' WHERE id=$1 AND state NOT IN ('played','superseded')",[row.revision_id]);
    await client.query(`UPDATE sloptogether.segments s SET state='open',selected_revision_id=NULL,protected_at=NULL
      WHERE s.id=$1 AND s.selected_revision_id=$2 AND s.state NOT IN ('played','retired')
        AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)`,[row.segment_id,row.revision_id]);
  }
}

export async function lockRevokedWorkerSegments(client:PoolClient,bindingIds:string[],channelId:string){
  if(!bindingIds.length)return;
  await client.query(`SELECT s.id FROM sloptogether.segments s JOIN sloptogether.segment_revisions r ON r.segment_id=s.id
    JOIN sloptogether.jobs j ON j.segment_revision_id=r.id JOIN sloptogether.job_attempts a ON a.job_id=j.id
    WHERE s.twitch_channel_id=$1 AND j.stage='video_base' AND a.execution_binding_id=ANY($2::uuid[])
      AND s.selected_revision_id=r.id AND s.state NOT IN ('played','retired')
      AND NOT EXISTS(SELECT 1 FROM sloptogether.program_items pi WHERE pi.segment_id=s.id AND pi.committed_at IS NOT NULL)
    ORDER BY s.id FOR UPDATE OF s`,[channelId,bindingIds]);
}

/** Release abandoned story-plan claims and requeue fresh, still-funded subscriber plans. */
export async function abandonStoryProducerPlans(client:PoolClient,producerIds:string[]){
  if(!producerIds.length)return {planIds:[] as string[],interruptIds:[] as string[]};
  const plans=await client.query<{id:string;interrupt_id:string|null;owner_reservation_id:string|null}>(`SELECT id,input_payload->>'interruptId' AS interrupt_id,owner_reservation_id
    FROM sloptogether.story_plan_attempts WHERE producer_id=ANY($1::uuid[]) AND status='planning' FOR UPDATE`,[producerIds]);
  const planIds=plans.rows.map(row=>row.id);
  if(planIds.length)await client.query(`UPDATE sloptogether.story_plan_attempts SET status='failed',claim_token=NULL,claim_expires_at=NULL,updated_at=now()
    WHERE id=ANY($1::uuid[]) AND status='planning'`,[planIds]);
  const reservations=plans.rows.map(row=>row.owner_reservation_id).filter((id):id is string=>Boolean(id));
  const interruptIds=[...new Set(plans.rows.map(row=>row.interrupt_id).filter((id):id is string=>Boolean(id)))];
  if(!interruptIds.length){
    if(reservations.length)await client.query(`UPDATE sloptogether.funding_authorizations f SET state='released',settled_at=now()
      WHERE f.id=ANY($1::uuid[]) AND f.state='reserved'
        AND NOT EXISTS(SELECT 1 FROM sloptogether.job_attempts a WHERE a.funding_id=f.id AND a.claimed_at IS NOT NULL)`,[reservations]);
    return {planIds,interruptIds};
  }
  const interrupts=await client.query<{id:string;funding_id:string|null;expires_at:Date;enabled:boolean;funding_state:string|null;owner_authorized:boolean}>(`SELECT ir.id,ir.funding_id,ir.expires_at,
      coalesce((c.subscriber_interrupt_policy->>'enabled')::boolean,false) AS enabled,f.state AS funding_state,
      EXISTS(SELECT 1 FROM sloptogether.sessions s WHERE s.twitch_user_id=c.owner_twitch_user_id AND s.revoked_at IS NULL AND s.expires_at>now()
        AND s.granted_scopes @> ARRAY['channel:read:subscriptions']::text[]) AS owner_authorized
    FROM sloptogether.interrupt_requests ir JOIN sloptogether.channels c ON c.twitch_channel_id=ir.broadcaster_twitch_id
    LEFT JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id
    WHERE ir.id=ANY($1::uuid[]) AND ir.program_state='planning' FOR UPDATE OF ir`,[interruptIds]);
  const byState:{queued:string[];expired:string[];cancelled:string[];failed:string[]}={queued:[],expired:[],cancelled:[],failed:[]};
  const releaseFunding:string[]=[];
  for(const row of interrupts.rows){
    const state=row.expires_at.getTime()<=Date.now()?"expired":!row.enabled||!row.owner_authorized?"cancelled":row.funding_state!=="reserved"?"failed":"queued";
    byState[state].push(row.id);
    if(state!=="queued"&&row.funding_id&&row.funding_state==="reserved")releaseFunding.push(row.funding_id);
  }
  for(const [state,ids] of Object.entries(byState))if(ids.length){
    await client.query("UPDATE sloptogether.interrupt_requests SET program_state=$2 WHERE id=ANY($1::uuid[]) AND program_state='planning'",[ids,state]);
    await client.query("UPDATE sloptogether.subscription_events SET state=$2 WHERE interrupt_id=ANY($1::uuid[]) AND state IN ('queued','planned')",[ids,state]);
  }
  const requeuedFunding=new Set(interrupts.rows.filter(row=>byState.queued.includes(row.id)).map(row=>row.funding_id).filter((id):id is string=>Boolean(id)));
  const reservationsToRelease=[...new Set([...reservations.filter(id=>!requeuedFunding.has(id)),...releaseFunding])];
  if(reservationsToRelease.length)await client.query(`UPDATE sloptogether.funding_authorizations f SET state='released',settled_at=now()
    WHERE f.id=ANY($1::uuid[]) AND f.state='reserved'
      AND NOT EXISTS(SELECT 1 FROM sloptogether.job_attempts a WHERE a.funding_id=f.id AND a.claimed_at IS NOT NULL)`,[reservationsToRelease]);
  await client.query("UPDATE sloptogether.outbox SET delivered_at=now(),leased_until=NULL WHERE aggregate_id=ANY($1::text[]) AND event_kind='subscriber_interrupt.plan' AND delivered_at IS NULL",[interruptIds]);
  return {planIds,interruptIds};
}
