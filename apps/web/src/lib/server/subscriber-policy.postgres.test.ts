import { createHmac,randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { lifecyclePool,pool,transaction } from "./db";
import { persistSubscriberSettings } from "./subscriber-service";
import { handleEventSubWebhook } from "./eventsub-webhook";
import { isSafeTrustedPolicyAudit } from "./trusted-policy";

vi.mock("server-only",()=>({}));

const url=process.env.SLOPTOGETHER_POLICY_TEST_DATABASE_URL;
const testDatabase=url?describe:describe.skip;
const channelId=String(800000000000000n+BigInt(`0x${randomBytes(4).toString("hex")}`));
const ownerId=channelId;
const secret="local-policy-eventsub-test-secret";
const keyId=randomUUID();
const settings={enabled:true,newSubscriptions:true,resubscriptionMessages:false,giftMode:"off",minimumGapSeconds:60,eventMaxAgeSeconds:180,hourlySpendCapUsd:1,fallback:"skip"} as const;
let created=false;

function revocation(messageId:string,type:"channel.subscribe"|"channel.chat.message",subscriptionId:string){
  const timestamp=new Date().toISOString();
  const condition=type==="channel.chat.message"?{broadcaster_user_id:channelId,user_id:ownerId}:{broadcaster_user_id:channelId};
  const body=JSON.stringify({subscription:{id:subscriptionId,type,version:"1",status:"authorization_revoked",condition,transport:{method:"webhook"}}});
  const signature=createHmac("sha256",secret).update(messageId+timestamp).update(body).digest("hex");
  return new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",headers:{
    "Content-Type":"application/json","Twitch-Eventsub-Message-Id":messageId,"Twitch-Eventsub-Message-Timestamp":timestamp,
    "Twitch-Eventsub-Message-Signature":`sha256=${signature}`,"Twitch-Eventsub-Message-Type":"revocation",
  },body});
}

function signedSubscribe(messageId:string){
  const timestamp=new Date().toISOString();
  const event={broadcaster_user_id:channelId,user_id:"9001",user_login:"viewer_9001",user_name:"Local Viewer",is_anonymous:false,is_gift:false};
  const body=Buffer.from(JSON.stringify({subscription:{id:"local-subscription",type:"channel.subscribe",version:"1",condition:{broadcaster_user_id:channelId},transport:{method:"webhook"}},event}));
  const signature=createHmac("sha256",secret).update(Buffer.concat([Buffer.from(messageId+timestamp),body])).digest("hex");
  return new Request("http://127.0.0.1:3000/sloptogether/api/v1/webhooks/eventsub",{method:"POST",body,headers:{
    "Content-Type":"application/json","Twitch-Eventsub-Message-Id":messageId,"Twitch-Eventsub-Message-Timestamp":timestamp,
    "Twitch-Eventsub-Message-Signature":`sha256=${signature}`,"Twitch-Eventsub-Message-Type":"notification",
  }});
}

testDatabase("subscriber trust policy PostgreSQL integration",()=>{
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname)||!parsed.pathname.startsWith("/sloptogether_preair_test_"))
      throw new Error("policy_test_requires_isolated_loopback_database");
    vi.stubEnv("DATABASE_URL",url!);vi.stubEnv("SLOPTOGETHER_DATABASE_SSL_CA","");vi.stubEnv("TWITCH_EVENTSUB_SECRET",secret);
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.25");
    await pool().query("INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,chat_voting_enabled,owner_budget_cap_usd) VALUES($1,$1,$2,'Policy integration',true,10)",[channelId,`policy_${channelId}`]);
    created=true;
    await pool().query(`INSERT INTO sloptogether.sessions(token_hash,twitch_user_id,twitch_login,display_name,access_token_encrypted,granted_scopes,token_expires_at,expires_at)
      VALUES($1,$2,'policy_owner','Policy Owner',$3,ARRAY['channel:read:subscriptions'],now()+interval '1 hour',now()+interval '1 hour')`,[randomBytes(32),ownerId,Buffer.from("test-token")]);
    await pool().query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles)
      VALUES($1,$2,$3,$4,$4,'trusted policy test',ARRAY['worker:generation','artifact:system_approve'],ARRAY['generation'])`,[keyId,randomBytes(32),`slw_${keyId}`,channelId]);
    await pool().query("INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision) VALUES($1,$2,$1,'generation',1)",[channelId,keyId]);
  },20_000);

  afterAll(async()=>{
    try{
      if(created){
        await pool().query("DELETE FROM sloptogether.outbox WHERE aggregate_id IN (SELECT id::text FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1)",[channelId]);
        await pool().query("UPDATE sloptogether.subscription_events SET interrupt_id=NULL WHERE broadcaster_twitch_id=$1",[channelId]);
        await pool().query("DELETE FROM sloptogether.interrupt_requests WHERE broadcaster_twitch_id=$1",[channelId]);
        await pool().query("DELETE FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1",[channelId]);
        await pool().query("DELETE FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1",[channelId]);
        await pool().query("DELETE FROM sloptogether.eventsub_config_fingerprints WHERE twitch_channel_id=$1",[channelId]);
        await pool().query("DELETE FROM sloptogether.audit_log WHERE twitch_channel_id=$1",[channelId]);
        await pool().query("DELETE FROM sloptogether.sessions WHERE twitch_user_id=$1",[ownerId]);
        await pool().query("DELETE FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
      }
    }finally{await pool().end();await lifecyclePool().end();vi.unstubAllEnvs();}
  },20_000);

  it("refuses to enable subscriber events without current broadcaster authorization",async()=>{
    await pool().query("UPDATE sloptogether.sessions SET revoked_at=now() WHERE twitch_user_id=$1",[ownerId]);
    try{
      await expect(transaction(client=>persistSubscriberSettings(client,channelId,ownerId,settings))).rejects.toMatchObject({status:409,code:"subscription_authorization_required"});
      const result=await pool().query<{channel_revision:number;binding_revision:number}>(`SELECT c.policy_revision AS channel_revision,te.policy_revision AS binding_revision
        FROM sloptogether.channels c JOIN sloptogether.trusted_executions te ON te.twitch_channel_id=c.twitch_channel_id
        WHERE c.twitch_channel_id=$1 AND te.key_id=$2`,[channelId,keyId]);
      expect(result.rows[0]).toEqual({channel_revision:1,binding_revision:1});
    }finally{await pool().query("UPDATE sloptogether.sessions SET revoked_at=NULL WHERE twitch_user_id=$1",[ownerId]);}
  },20_000);

  it("rechecks the settings actor's ban under the channel lock",async()=>{
    const moderatorId=String(BigInt(channelId)+3n);
    const ban=await pool().query<{id:string}>("INSERT INTO sloptogether.bans(twitch_user_id,twitch_channel_id,scope,issued_by) VALUES($1,$2,'channel',$3) RETURNING id",[moderatorId,channelId,ownerId]);
    try{
      await expect(transaction(client=>persistSubscriberSettings(client,channelId,moderatorId,{...settings,enabled:false}))).rejects.toMatchObject({status:403,code:"channel_ban_active"});
      const result=await pool().query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
      expect(result.rows[0]?.policy_revision).toBe(1);
    }finally{await pool().query("DELETE FROM sloptogether.bans WHERE id=$1",[ban.rows[0]!.id]);}
  },20_000);

  it("refuses subscriber activation until a render reservation fits both budget caps",async()=>{
    const initial=await pool().query<{policy_revision:number;subscriber_interrupt_policy:unknown}>(
      "SELECT policy_revision,subscriber_interrupt_policy FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","");
    await expect(transaction(client=>persistSubscriberSettings(client,channelId,ownerId,settings)))
      .rejects.toMatchObject({status:503,code:"subscriber_reservation_not_configured"});
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.25");
    await pool().query("UPDATE sloptogether.channels SET owner_budget_cap_usd=0 WHERE twitch_channel_id=$1",[channelId]);
    await expect(transaction(client=>persistSubscriberSettings(client,channelId,ownerId,settings)))
      .rejects.toMatchObject({status:409,code:"subscriber_budget_cap_too_low"});
    await pool().query("UPDATE sloptogether.channels SET owner_budget_cap_usd=10 WHERE twitch_channel_id=$1",[channelId]);
    await expect(transaction(client=>persistSubscriberSettings(client,channelId,ownerId,{...settings,hourlySpendCapUsd:0.1})))
      .rejects.toMatchObject({status:409,code:"subscriber_hourly_cap_too_low"});
    const unchanged=await pool().query<{policy_revision:number;subscriber_interrupt_policy:unknown}>(
      "SELECT policy_revision,subscriber_interrupt_policy FROM sloptogether.channels WHERE twitch_channel_id=$1",[channelId]);
    expect(unchanged.rows[0]).toEqual(initial.rows[0]);
  },20_000);

  it("carries trust across authorized subscriber enable and disable with revision-bound audits",async()=>{
    await transaction(client=>persistSubscriberSettings(client,channelId,ownerId,settings));
    await transaction(client=>persistSubscriberSettings(client,channelId,ownerId,{...settings,enabled:false}));
    const result=await pool().query<{channel_revision:number;binding_revision:number;enabled:boolean}>(`SELECT c.policy_revision AS channel_revision,te.policy_revision AS binding_revision,
      (c.subscriber_interrupt_policy->>'enabled')::boolean AS enabled FROM sloptogether.channels c JOIN sloptogether.trusted_executions te ON te.twitch_channel_id=c.twitch_channel_id
      WHERE c.twitch_channel_id=$1 AND te.key_id=$2`,[channelId,keyId]);
    expect(result.rows[0]).toEqual({channel_revision:3,binding_revision:3,enabled:false});
    const audits=await pool().query<{policy_revision:number;action:string;after_state:unknown}>("SELECT policy_revision,action,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='subscriber_interrupt.settings' ORDER BY policy_revision",[channelId]);
    expect(audits.rows.map(row=>row.policy_revision)).toEqual([2,3]);
    expect(audits.rows.every(row=>isSafeTrustedPolicyAudit(row.action,row.after_state))).toBe(true);
  },20_000);

  it("admits one signed subscription into the durable 10-second interrupt queue",async()=>{
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.25");
    await pool().query("UPDATE sloptogether.channels SET subscriber_interrupt_policy=$2::jsonb,owner_budget_cap_usd=10 WHERE twitch_channel_id=$1",
      [channelId,JSON.stringify(settings)]);
    const request=signedSubscribe(`local-eventsub-${randomUUID()}`);
    expect((await handleEventSubWebhook(request.clone())).status).toBe(204);
    expect((await handleEventSubWebhook(request)).status).toBe(204);
    const event=await pool().query<{state:string;interrupt_id:string}>("SELECT state,interrupt_id FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1 ORDER BY created_at DESC LIMIT 1",[channelId]);
    expect(event.rows[0]).toMatchObject({state:"queued"});
    expect(event.rows[0]?.interrupt_id).toBeTruthy();
    const queued=await pool().query<{program_state:string;subscriber_label:string;plan_payload:Record<string,unknown>;funding_state:string}> (
      `SELECT ir.program_state,ir.subscriber_label,ir.plan_payload,f.state AS funding_state FROM sloptogether.interrupt_requests ir
       JOIN sloptogether.funding_authorizations f ON f.id=ir.funding_id WHERE ir.id=$1`,[event.rows[0]!.interrupt_id]);
    expect(queued.rows[0]).toMatchObject({program_state:"queued",subscriber_label:"Local Viewer",funding_state:"reserved",
      plan_payload:{durationSeconds:10,frameCount:243,requireAudio:true}});
    const outbox=await pool().query("SELECT 1 FROM sloptogether.outbox WHERE event_kind='subscriber_interrupt.plan' AND aggregate_id=$1",[event.rows[0]!.interrupt_id]);
    expect(outbox.rowCount).toBe(1);
    expect((await pool().query("SELECT 1 FROM sloptogether.subscription_events WHERE broadcaster_twitch_id=$1",[channelId])).rowCount).toBe(1);
  },20_000);

  it("does not fence trust for a superseded EventSub registration",async()=>{
    await pool().query(`INSERT INTO sloptogether.eventsub_config_fingerprints(twitch_channel_id,registration_key,config_fingerprint,subscription_ids)
      VALUES($1,'subscriber-events',$2,ARRAY['sub-policy'])`,[channelId,randomBytes(32)]);
    expect((await handleEventSubWebhook(revocation("policy-revoke-old","channel.subscribe","old-sub-policy"))).status).toBe(204);
    const result=await pool().query<{channel_revision:number;binding_revision:number}>(`SELECT c.policy_revision AS channel_revision,te.policy_revision AS binding_revision
      FROM sloptogether.channels c JOIN sloptogether.trusted_executions te ON te.twitch_channel_id=c.twitch_channel_id WHERE c.twitch_channel_id=$1 AND te.key_id=$2`,[channelId,keyId]);
    expect(result.rows[0]).toEqual({channel_revision:3,binding_revision:3});
    const audit=await pool().query<{policy_revision:number|null;after_state:{currentRegistration:boolean}}>("SELECT policy_revision,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='eventsub.revoked' AND target_id='old-sub-policy'",[channelId]);
    expect(audit.rows[0]).toMatchObject({policy_revision:null,after_state:{currentRegistration:false}});
  },20_000);

  it("keeps signed current EventSub revocations as trust fences and records their revisions",async()=>{
    await pool().query(`INSERT INTO sloptogether.eventsub_config_fingerprints(twitch_channel_id,registration_key,config_fingerprint,subscription_ids)
      VALUES($1,'subscriber-events',$2,ARRAY['sub-policy']) ON CONFLICT(twitch_channel_id,registration_key) DO UPDATE SET subscription_ids=EXCLUDED.subscription_ids`,[channelId,randomBytes(32)]);
    const message="policy-revoke-subscriber";
    expect((await handleEventSubWebhook(revocation(message,"channel.subscribe","sub-policy"))).status).toBe(204);
    expect((await handleEventSubWebhook(revocation(message,"channel.subscribe","sub-policy"))).status).toBe(204);
    const result=await pool().query<{channel_revision:number;binding_revision:number;enabled:boolean}>(`SELECT c.policy_revision AS channel_revision,te.policy_revision AS binding_revision,
      (c.subscriber_interrupt_policy->>'enabled')::boolean AS enabled FROM sloptogether.channels c JOIN sloptogether.trusted_executions te ON te.twitch_channel_id=c.twitch_channel_id
      WHERE c.twitch_channel_id=$1 AND te.key_id=$2`,[channelId,keyId]);
    expect(result.rows[0]).toEqual({channel_revision:4,binding_revision:3,enabled:false});
    const audit=await pool().query<{policy_revision:number;action:string;after_state:unknown}>("SELECT policy_revision,action,after_state FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='eventsub.revoked' AND target_id='sub-policy'",[channelId]);
    expect(audit.rows).toHaveLength(1);expect(audit.rows[0]?.policy_revision).toBe(4);
    expect(isSafeTrustedPolicyAudit(audit.rows[0]!.action,audit.rows[0]!.after_state)).toBe(false);
    await transaction(client=>persistSubscriberSettings(client,channelId,ownerId,{...settings,enabled:false}));
    expect((await pool().query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.trusted_executions WHERE key_id=$1",[keyId])).rows[0]?.policy_revision).toBe(3);
  },20_000);

  it("records chat EventSub revocation without reviving stale trust",async()=>{
    await pool().query(`INSERT INTO sloptogether.eventsub_config_fingerprints(twitch_channel_id,registration_key,config_fingerprint,subscription_ids)
      VALUES($1,$2,$3,ARRAY['chat-policy'])`,[channelId,`chat:${ownerId}`,randomBytes(32)]);
    expect((await handleEventSubWebhook(revocation("policy-revoke-chat","channel.chat.message","chat-policy"))).status).toBe(204);
    const result=await pool().query<{channel_revision:number;binding_revision:number;chat_voting_enabled:boolean}>(`SELECT c.policy_revision AS channel_revision,te.policy_revision AS binding_revision,c.chat_voting_enabled
      FROM sloptogether.channels c JOIN sloptogether.trusted_executions te ON te.twitch_channel_id=c.twitch_channel_id WHERE c.twitch_channel_id=$1 AND te.key_id=$2`,[channelId,keyId]);
    expect(result.rows[0]).toEqual({channel_revision:6,binding_revision:3,chat_voting_enabled:false});
    const audit=await pool().query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.audit_log WHERE twitch_channel_id=$1 AND action='eventsub.revoked' AND target_id='chat-policy'",[channelId]);
    expect(audit.rows[0]?.policy_revision).toBe(6);
  },20_000);
});
