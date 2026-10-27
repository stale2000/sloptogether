import { createHmac,randomBytes } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { pool,transaction } from "./db";
import { cancelPendingInterrupts,handleEventSubWebhook } from "./subscriber-service";

vi.mock("server-only",()=>({}));

const run=process.env.SLOPTOGETHER_RUN_DB_INTEGRATION==="1";
const describeDatabase=run?describe:describe.skip;
const eventSubSecret="local-postgres-eventsub-integration-secret";
const channelId=String(BigInt(Date.now())*10_000n+BigInt(Math.floor(Math.random()*10_000)));
const ownerId=String(BigInt(channelId)+1n);
let fixtureCreated=false;
let database:ReturnType<typeof pool>|null=null;

function request(messageId:string){
  const timestamp=new Date().toISOString();
  const body=JSON.stringify({
    subscription:{id:"local-integration",type:"channel.subscribe",version:"1",condition:{broadcaster_user_id:channelId},transport:{method:"webhook"}},
    event:{broadcaster_user_id:channelId,user_id:String(BigInt(ownerId)+1n),user_login:"testsubscriber",user_name:"Test Subscriber",is_anonymous:false,is_gift:false},
  });
  const signature=createHmac("sha256",eventSubSecret).update(messageId+timestamp).update(body).digest("hex");
  return new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",headers:{
    "Content-Type":"application/json","Twitch-Eventsub-Message-Id":messageId,"Twitch-Eventsub-Message-Timestamp":timestamp,
    "Twitch-Eventsub-Message-Signature":`sha256=${signature}`,"Twitch-Eventsub-Message-Type":"notification",
  },body});
}

function verificationRequest(messageId:string){
  const timestamp=new Date().toISOString();
  const challenge="local-twitch-callback-challenge";
  const body=JSON.stringify({subscription:{id:"local-verification",type:"channel.subscribe",version:"1",
    condition:{broadcaster_user_id:channelId},transport:{method:"webhook"}},challenge});
  const signature=createHmac("sha256",eventSubSecret).update(messageId+timestamp).update(body).digest("hex");
  return new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",headers:{
    "Content-Type":"application/json","Twitch-Eventsub-Message-Id":messageId,"Twitch-Eventsub-Message-Timestamp":timestamp,
    "Twitch-Eventsub-Message-Signature":`sha256=${signature}`,"Twitch-Eventsub-Message-Type":"webhook_callback_verification",
  },body});
}

describeDatabase("subscriber EventSub PostgreSQL concurrency",()=>{
  beforeAll(async()=>{
    const url=new URL(process.env.DATABASE_URL??"");
    const expectedMarker=process.env.SLOPTOGETHER_EVENTSUB_TEST_GUARD_MARKER;
    if(process.env.NODE_ENV!=="test"||url.protocol!=="postgresql:"||url.hostname!=="127.0.0.1"||url.port!=="56432"
      ||url.username!=="postgres"||url.password||!/^\/sloptogether_preair_test_[a-f0-9]{16}$/.test(url.pathname)||url.search||url.hash
      ||!expectedMarker||!/^[a-f0-9]{48}$/.test(expectedMarker))
      throw new Error("subscriber_eventsub_test_requires_guarded_scratch_database");
    vi.stubEnv("TWITCH_EVENTSUB_SECRET",eventSubSecret);
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.25");
    database=pool();
    const identity=await database.query(`select current_database() as "databaseName",current_setting('data_directory') as "dataDirectory",
      host(inet_server_addr()) as "serverAddress",inet_server_port() as "serverPort",
      (select marker from public.sloptogether_eventsub_test_guard limit 1) as "guardMarker"`);
    if(identity.rows[0]?.databaseName!==url.pathname.slice(1)||identity.rows[0]?.dataDirectory!=="/tmp/sloptogether-pg"
      ||identity.rows[0]?.serverAddress!=="127.0.0.1"||Number(identity.rows[0]?.serverPort)!==56432||identity.rows[0]?.guardMarker!==expectedMarker)
      throw new Error("subscriber_eventsub_test_database_identity_not_allowed");
    await database.query(`INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,
      subscriber_interrupt_policy,owner_budget_cap_usd)
      VALUES($1,$2,$3,'Local EventSub integration',
        '{"enabled":true,"newSubscriptions":true,"resubscriptionMessages":false,"giftMode":"off","minimumGapSeconds":60,"eventMaxAgeSeconds":180,"hourlySpendCapUsd":1,"fallback":"skip"}'::jsonb,1)`,
    [channelId,ownerId,`st_${channelId.slice(-16)}`]);
    fixtureCreated=true;
    await database.query(`INSERT INTO sloptogether.sessions(token_hash,twitch_user_id,twitch_login,display_name,access_token_encrypted,
      granted_scopes,token_expires_at,expires_at)
      VALUES($1,$2,'local_eventsub_test','Local EventSub Test',$3,ARRAY['channel:read:subscriptions'],now()+interval '1 hour',now()+interval '1 hour')`,
    [randomBytes(32),ownerId,Buffer.from("test-only-encrypted-access-token")]);
  },20_000);

  afterAll(async()=>{
    try{
      if(database&&fixtureCreated){
        const db=database;
        await db.query("DELETE FROM sloptogether.outbox WHERE aggregate_id IN (SELECT id::text FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1)",[channelId]);
        await db.query("UPDATE sloptogether.subscription_events SET interrupt_id=NULL WHERE broadcaster_twitch_id=$1",[channelId]);
        await db.query("UPDATE sloptogether.interrupt_requests SET funding_id=NULL WHERE broadcaster_twitch_id=$1",[channelId]);
        await db.query("DELETE FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1 AND action_intent_id IN (SELECT id FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1)",[channelId]);
        await db.query("DELETE FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1",[channelId]);
        await db.query("DELETE FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1",[channelId]);
        await db.query("DELETE FROM sloptogether.audit_log WHERE twitch_channel_id=$1",[channelId]);
        await db.query("DELETE FROM sloptogether.sessions WHERE twitch_user_id=$1",[ownerId]);
        await db.query("DELETE FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
      }
    }finally{await database?.end();vi.unstubAllEnvs();}
  },20_000);

  it("serializes concurrent signed subscriptions so only one render is funded inside the gap",async()=>{
    const ids=[`local-concurrent-${channelId}-1`,`local-concurrent-${channelId}-2`];
    const responses=await Promise.all(ids.map(id=>handleEventSubWebhook(request(id))));
    expect(responses.map(response=>response.status)).toEqual([204,204]);
    const result=await pool().query<{events:string;queued:string;funded:string;gapRejected:string}>(
      `SELECT
        (SELECT count(*)::text FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1 AND twitch_message_id=ANY($2::text[])) AS events,
        (SELECT count(*)::text FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1 AND idempotency_key=ANY(ARRAY['subscriber-event:'||$3,'subscriber-event:'||$4])) AS queued,
        (SELECT count(*)::text FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1 AND action_intent_id IN
          (SELECT id FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1 AND idempotency_key=ANY(ARRAY['subscriber-event:'||$3,'subscriber-event:'||$4]))) AS funded,
        (SELECT count(*)::text FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='subscriber_interrupt.not_queued' AND reason='minimum_gap'
          AND idempotency_key IN ('subscriber-event:'||$3,'subscriber-event:'||$4)) AS "gapRejected"`,
      [channelId,ids,ids[0],ids[1]],
    );
    expect(result.rows[0]).toEqual({events:"2",queued:"1",funded:"1",gapRejected:"1"});

    const replayId=ids[0]!;
    const replayResponses=await Promise.all([handleEventSubWebhook(request(replayId)),handleEventSubWebhook(request(replayId))]);
    expect(replayResponses.map(response=>response.status)).toEqual([204,204]);
    const replay=await pool().query<{receipts:string;funded:string}>(
      `SELECT (SELECT count(*)::text FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1 AND twitch_message_id=$2) AS receipts,
        (SELECT count(*)::text FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1) AS funded`,
      [channelId,replayId],
    );
    expect(replay.rows[0]).toEqual({receipts:"1",funded:"1"});

    await pool().query(`UPDATE sloptogether.channels SET subscriber_interrupt_policy=
      jsonb_set(jsonb_set(subscriber_interrupt_policy,'{minimumGapSeconds}','0'::jsonb),'{hourlySpendCapUsd}','0.25'::jsonb)
      WHERE twitch_channel_id=$1`,[channelId]);
    const cappedId=`local-hourly-cap-${channelId}`;
    await expect(handleEventSubWebhook(request(cappedId))).resolves.toMatchObject({status:204});
    const cap=await pool().query<{receipts:string;funded:string;rejected:string}>(
      `SELECT (SELECT count(*)::text FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1 AND twitch_message_id=$2) AS receipts,
        (SELECT count(*)::text FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1) AS funded,
        (SELECT count(*)::text FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='subscriber_interrupt.not_queued'
          AND reason='hourly_spend_cap' AND idempotency_key='subscriber-event:'||$2) AS rejected`,
      [channelId,cappedId],
    );
    expect(cap.rows[0]).toEqual({receipts:"1",funded:"1",rejected:"1"});

    await transaction(client=>cancelPendingInterrupts(client,channelId));
    const settlement=await pool().query<{funding_state:string;program_state:string}>(
      `SELECT f.state AS funding_state,i.program_state FROM sloptogether.funding_authorizations f
       JOIN sloptogether.interrupt_requests i ON i.funding_id=f.id WHERE i.broadcaster_twitch_id=$1`,[channelId]);
    expect(settlement.rows[0]).toEqual({funding_state:"released",program_state:"cancelled"});
  },20_000);

  it("answers a correctly signed Twitch subscription callback challenge",async()=>{
    const response=await handleEventSubWebhook(verificationRequest(`local-verification-${channelId}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("local-twitch-callback-challenge");
  },20_000);
});
