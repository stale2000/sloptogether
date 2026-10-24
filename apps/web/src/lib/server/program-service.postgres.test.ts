import { createHash,randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { pool } from "./db";
import { claimPlaybackController,getProgramManifest,heartbeatPlayback } from "./program-service";

vi.mock("server-only",()=>({}));

const run=process.env.SLOPTOGETHER_RUN_DB_INTEGRATION==="1";
const describeDatabase=run?describe:describe.skip;
let database:ReturnType<typeof pool>|null=null;
let channelId:string|undefined;
let ownerId:string|undefined;
let keyId:string|undefined;
let segmentId:string|undefined;
let previousSegmentState:string|undefined;
let previousSession:{controller_user_id:string|null;controller_epoch:string;active_item_id:string|null;item_offset_seconds:string;event_sequence:string;lease_expires_at:Date|null}|null|undefined;

describeDatabase("playback controller PostgreSQL integration",()=>{
  beforeAll(async()=>{
    const url=new URL(process.env.DATABASE_URL??"");
    if(!["localhost","127.0.0.1","::1"].includes(url.hostname)||url.pathname!=="/sloptogether")
      throw new Error("integration_test_requires_loopback_sloptogether_database");
    const pepper=process.env.SLOPTOGETHER_KEY_HASH_PEPPER;
    if(!pepper||pepper.length<32)throw new Error("integration_test_requires_local_worker_pepper");
    database=pool();
    const channel=(await database.query<{twitch_channel_id:string;owner_twitch_user_id:string}>(
      "SELECT twitch_channel_id,owner_twitch_user_id FROM sloptogether.channels WHERE twitch_login='localdemo' AND is_enabled",
    )).rows[0];
    if(!channel)throw new Error("integration_test_requires_seeded_localdemo_channel");
    channelId=channel.twitch_channel_id;ownerId=channel.owner_twitch_user_id;
    previousSession=(await database.query<{controller_user_id:string|null;controller_epoch:string;active_item_id:string|null;item_offset_seconds:string;event_sequence:string;lease_expires_at:Date|null}>(
      "SELECT controller_user_id,controller_epoch,active_item_id,item_offset_seconds,event_sequence,lease_expires_at FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1",[channelId],
    )).rows[0]??null;
    if(previousSession&&(previousSession.controller_user_id||previousSession.active_item_id||previousSession.lease_expires_at&&previousSession.lease_expires_at.getTime()>Date.now()))
      throw new Error("integration_test_playback_session_is_in_use");
    const manifest=await getProgramManifest("localdemo");
    const span=manifest.programSpans[0];
    if(!span||span.kind!=="story"||!span.segmentId)throw new Error("integration_test_requires_committed_story_scene");
    segmentId=span.segmentId;
    const state=await database.query<{state:string}>("SELECT state FROM sloptogether.segments WHERE id=$1",[segmentId]);
    previousSegmentState=state.rows[0]?.state;
    if(!previousSegmentState)throw new Error("integration_test_segment_missing");
    keyId=randomUUID();
    const secret=`slw_${keyId}.${randomBytes(32).toString("base64url")}`;
    const hash=createHash("sha256").update(pepper).update("\0").update(secret).digest();
    await database.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles,recipe_ids)
      VALUES($1,$2,$3,$4,$5,'temporary playback integration',ARRAY['streamer:control'],ARRAY[]::text[],ARRAY[]::text[])`,
    [keyId,hash,`slw_${keyId}`,ownerId,channelId]);
    await database.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,recipe_ids,policy_revision)
      SELECT $1,$2,$3,'streamer_control',ARRAY[]::text[],policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1`,[channelId,keyId,ownerId]);
    vi.stubEnv("SLOPTOGETHER_PLAYBACK_INTEGRATION_KEY",secret);
  },20_000);

  afterAll(async()=>{
    try{
      if(database&&channelId&&ownerId){
        if(segmentId&&previousSegmentState)await database.query("UPDATE sloptogether.segments SET state=$2 WHERE id=$1",[segmentId,previousSegmentState]);
        if(previousSession){
          await database.query(`UPDATE sloptogether.playback_sessions SET controller_user_id=$2,controller_epoch=$3,active_item_id=$4,
            item_offset_seconds=$5,event_sequence=$6,lease_expires_at=$7 WHERE twitch_channel_id=$1`,
          [channelId,previousSession.controller_user_id,previousSession.controller_epoch,previousSession.active_item_id,previousSession.item_offset_seconds,previousSession.event_sequence,previousSession.lease_expires_at]);
        }else await database.query("DELETE FROM sloptogether.playback_sessions WHERE twitch_channel_id=$1",[channelId]);
        if(keyId){
          await database.query("DELETE FROM sloptogether.audit_log WHERE actor_key_id=$1",[keyId]);
          await database.query("DELETE FROM sloptogether.trusted_executions WHERE key_id=$1",[keyId]);
          await database.query("DELETE FROM sloptogether.application_keys WHERE key_id=$1",[keyId]);
        }
      }
    }finally{
      await database?.end();
      vi.unstubAllEnvs();
    }
  },20_000);

  it("claims the browser controller and writes a playhead visible in the program manifest",async()=>{
    const secret=process.env.SLOPTOGETHER_PLAYBACK_INTEGRATION_KEY;
    if(!channelId||!secret)throw new Error("integration_fixture_missing");
    const headers={Authorization:`SlopWorker ${secret}`,"Content-Type":"application/json"};
    const program=await getProgramManifest("localdemo");
    const span=program.programSpans[0]!;
    const claim=await claimPlaybackController("localdemo",new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/playback/controller",{
      method:"POST",headers,body:JSON.stringify({clientInstanceId:randomUUID()}),
    }));
    expect(claim).toMatchObject({canControl:true});
    const offset=Math.min(1,Math.max(0,span.outputEndSeconds-span.outputStartSeconds));
    await expect(heartbeatPlayback("localdemo",new Request("http://localhost:3000/sloptogether/api/v1/channels/localdemo/playback/position",{
      method:"POST",headers,body:JSON.stringify({itemId:span.itemId,offsetSeconds:offset,controllerEpoch:claim.controllerEpoch,
        programEpoch:program.epoch,manifestRevision:program.manifestRevision,sequence:1}),
    }))).resolves.toMatchObject({accepted:true,itemId:span.itemId,sequence:1});
    const updated=await getProgramManifest("localdemo");
    expect(updated.playhead).toMatchObject({itemId:span.itemId,outputSeconds:span.outputStartSeconds+offset});
  },20_000);
});
