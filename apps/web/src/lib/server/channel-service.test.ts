import { randomBytes,randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),clientQuery:vi.fn(),findChannel:vi.fn(),isBanned:vi.fn(),requestPrincipal:vi.fn(),requireChannelModerator:vi.fn(),requireStreamerController:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction,transactionOnClient:vi.fn()}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,isBanned:mocks.isBanned,requireChannelModerator:mocks.requireChannelModerator,requireStreamerController:mocks.requireStreamerController}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));

import { issueWorkerKey,readChannelSettings,updateChannelSettings,reaffirmWorkerTrust } from "./channel-service";

describe("channel settings owner budget summary",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    mocks.findChannel.mockResolvedValue({
      twitch_channel_id:"123",owner_twitch_user_id:"42",twitch_login:"channel",display_name:"Channel",contribution_mode:"any_non_banned_twitch_user",
      contributor_whitelist:[],reviewer_whitelist:[],upload_approval_bypass_ids:[],role_based_upload_bypass:[],subscriber_interrupt_policy:{enabled:false,newSubscriptions:true,resubscriptionMessages:false,giftMode:"off",minimumGapSeconds:60,eventMaxAgeSeconds:180,hourlySpendCapUsd:0,fallback:"skip"},
      story_world_prompt:"A safe story",h3_style_profile:"trim",owner_budget_cap_usd:"0.5500",policy_revision:2,chat_voting_enabled:false,
      preair_upscale_enabled:false,preair_upscale_wait_seconds:1200,
    });
    mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"42"}});
    mocks.requireChannelModerator.mockResolvedValue("42");
    mocks.requireStreamerController.mockResolvedValue("42");
    mocks.isBanned.mockResolvedValue(false);
    mocks.query.mockResolvedValue({rows:[{committed:"0.5500"}],rowCount:1});
    mocks.clientQuery.mockResolvedValue({rows:[],rowCount:1});
    mocks.transaction.mockImplementation(async(callback:(client:{query:typeof mocks.clientQuery})=>unknown)=>callback({query:mocks.clientQuery}));
    vi.stubEnv("PUBLIC_APP_URL","https://www.clips.gg/sloptogether");
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.25");
    vi.stubEnv("SLOPTOGETHER_KEY_HASH_PEPPER","test-worker-key-hash-pepper-0123456789");
  });

  it("returns the channel-scoped non-released owner reservations and remaining cap",async()=>{
    const settings=await readChannelSettings("channel",new Request("https://clips.gg/sloptogether/api/v1/channels/channel/settings"));
    expect(settings).toMatchObject({ownerBudgetCapUsd:0.55,ownerBudgetCommittedUsd:0.55,ownerBudgetRemainingUsd:0,subscriberAttemptReservationUsd:0.25,subscriberEventSubAuthorized:false});
    const [sql,values]=mocks.query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain("source='owner_budget'");
    expect(sql).toContain("state<>'released'");
    expect(sql).toContain("greatest(reserved_usd,coalesce(actual_cost_usd,0))");
    expect(values).toEqual(["123"]);
  });

  it("reports when subscriber attempt pricing is not configured",async()=>{
    vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","");
    const settings=await readChannelSettings("channel",new Request("https://clips.gg/sloptogether/api/v1/channels/channel/settings"));
    expect(settings.subscriberAttemptReservationUsd).toBeNull();
  });

  it("reports broadcaster subscription scope readiness without exposing the token",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>sql.includes("granted_scopes @> ARRAY['channel:read:subscriptions']")
      ?{rows:[{authorized:true}],rowCount:1}:{rows:[{committed:"0.5500"}],rowCount:1});
    const settings=await readChannelSettings("channel",new Request("https://clips.gg/sloptogether/api/v1/channels/channel/settings"));
    expect(settings.subscriberEventSubAuthorized).toBe(true);
    expect(settings).not.toHaveProperty("accessToken");
  });

  it("uses a distinct text parameter for the worker-key audit target",async()=>{
    const scopes=["worker:generation","artifact:system_approve"] as const;
    const result=await issueWorkerKey("channel",new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/worker-keys",{
      method:"POST",headers:{origin:"https://www.clips.gg","content-type":"application/json"},
      body:JSON.stringify({displayName:"Fal generation",scopes}),
    }));
    const [sql,values]=mocks.clientQuery.mock.calls.at(-1) as [string,unknown[]];
    expect(sql).toContain("'worker_key.issue','application_key',$5,$4::jsonb");
    expect(values).toEqual(["123","42",result.keyId,JSON.stringify({displayName:"Fal generation",scopes}),result.keyId]);
    expect(result.scopes).toEqual(scopes);
  });

  it("carries only current valid trusted grants across non-authority settings",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>sql.startsWith("UPDATE sloptogether.channels SET")
      ?{rows:[{policy_revision:3}],rowCount:1}:{rows:[],rowCount:1});
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/settings",{
      method:"PATCH",headers:{origin:"https://www.clips.gg","content-type":"application/json"},
      body:JSON.stringify({preairUpscaleEnabled:true,preairUpscaleWaitSeconds:1200}),
    });
    await updateChannelSettings("channel",request);
    const carry=mocks.clientQuery.mock.calls.find(([statement])=>String(statement).includes("UPDATE sloptogether.trusted_executions te SET policy_revision")) as [string,unknown[]];
    expect(carry[1]).toEqual(["123",3]);
    expect(carry[0]).toContain("te.policy_revision=$2-1");
    expect(carry[0]).toContain("te.revoked_at IS NULL");
    expect(carry[0]).toContain("k.revoked_at IS NULL");
    expect(carry[0]).toContain("k.expires_at>now()");
    expect(carry[0]).toContain("END=ANY(k.scopes)");
    expect(carry[0]).toContain("NOT EXISTS (SELECT 1 FROM sloptogether.bans");
  });

  it("does not carry trusted grants when an authority setting is included",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>sql.startsWith("UPDATE sloptogether.channels SET")
      ?{rows:[{policy_revision:3}],rowCount:1}:{rows:[],rowCount:1});
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/settings",{
      method:"PATCH",headers:{origin:"https://www.clips.gg","content-type":"application/json"},
      body:JSON.stringify({preairUpscaleEnabled:true,contributionMode:"broadcaster_and_moderators"}),
    });
    await updateChannelSettings("channel",request);
    expect(mocks.clientQuery.mock.calls.some(([statement])=>String(statement).includes("UPDATE sloptogether.trusted_executions te SET policy_revision"))).toBe(false);
  });

  it.skipIf(!process.env.SLOPTOGETHER_POLICY_TEST_DATABASE_URL)("carries only valid current bindings in PostgreSQL",async()=>{
    const url=new URL(process.env.SLOPTOGETHER_POLICY_TEST_DATABASE_URL!);
    if(!["localhost","127.0.0.1","::1"].includes(url.hostname)||!url.pathname.startsWith("/sloptogether_preair_test_"))
      throw new Error("policy_test_requires_isolated_loopback_database");
    const db=new Pool({connectionString:url.toString()});const client=await db.connect();
    const channelId=String(800000000000000n+BigInt(`0x${randomBytes(4).toString("hex")}`));
    const ownerId=channelId;const bannedId=String(BigInt(channelId)+1n);
    const cases=[
      {name:"current",revision:2,issuer:ownerId,revoked:false,expired:false,scopes:["worker:generation","artifact:system_approve"]},
      {name:"stale",revision:1,issuer:ownerId,revoked:false,expired:false,scopes:["worker:generation","artifact:system_approve"]},
      {name:"revoked",revision:2,issuer:ownerId,revoked:true,expired:false,scopes:["worker:generation","artifact:system_approve"]},
      {name:"expired",revision:2,issuer:ownerId,revoked:false,expired:true,scopes:["worker:generation","artifact:system_approve"]},
      {name:"banned",revision:2,issuer:bannedId,revoked:false,expired:false,scopes:["worker:generation","artifact:system_approve"]},
      {name:"wrong_scope",revision:2,issuer:ownerId,revoked:false,expired:false,scopes:["worker:upscale","artifact:system_approve"]},
    ];
    try{
      await client.query("BEGIN");
      await client.query("INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,policy_revision) VALUES($1,$2,$3,'Policy test',2)",[channelId,ownerId,`policy_${channelId}`]);
      await client.query("INSERT INTO sloptogether.bans(twitch_user_id,twitch_channel_id,scope,issued_by) VALUES($1,$2,'channel',$3)",[bannedId,channelId,ownerId]);
      for(const entry of cases){
        const keyId=randomUUID();
        await client.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles,recipe_ids,revoked_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY['generation'],ARRAY[]::text[],CASE WHEN $8 THEN now() END,CASE WHEN $9 THEN now()-interval '1 second' END)`,
          [keyId,randomBytes(32),`slw_${keyId}`,entry.issuer,channelId,entry.name,entry.scopes,entry.revoked,entry.expired]);
        await client.query("INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision) VALUES($1,$2,$3,'generation',$4)",[channelId,keyId,entry.issuer,entry.revision]);
      }
      mocks.findChannel.mockResolvedValue({twitch_channel_id:channelId,owner_twitch_user_id:ownerId,policy_revision:2,owner_budget_cap_usd:"0"});
      mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:ownerId}});
      mocks.transaction.mockImplementation(async(callback:(client:{query:typeof mocks.clientQuery})=>unknown)=>callback({query:mocks.clientQuery}));
      mocks.clientQuery.mockImplementation((sql:string,values?:unknown[])=>client.query(sql,values));
      mocks.query.mockImplementation((sql:string,values?:unknown[])=>client.query(sql,values));
      const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/settings",{
        method:"PATCH",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({preairUpscaleEnabled:true}),
      });
      await updateChannelSettings("channel",request);
      const rows=await client.query<{display_name:string;policy_revision:number}>(`SELECT k.display_name,te.policy_revision FROM sloptogether.trusted_executions te
        JOIN sloptogether.application_keys k ON k.key_id=te.key_id WHERE te.twitch_channel_id=$1`,[channelId]);
      expect(Object.fromEntries(rows.rows.map(row=>[row.display_name,row.policy_revision]))).toEqual({current:3,stale:1,revoked:2,expired:2,banned:2,wrong_scope:2});

      const reaffirmKey=randomUUID();
      await client.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles,recipe_ids)
        VALUES($1,$2,$3,$4,$5,'reaffirm',ARRAY['worker:generation','artifact:system_approve'],ARRAY['generation'],ARRAY[]::text[])`,[reaffirmKey,randomBytes(32),`slw_${reaffirmKey}`,ownerId,channelId]);
      await client.query("INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision) VALUES($1,$2,$3,'generation',2)",[channelId,reaffirmKey,ownerId]);
      await expect(reaffirmWorkerTrust("channel",reaffirmKey,reaffirmRequest())).resolves.toMatchObject({state:"reaffirmed"});
      expect((await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.trusted_executions WHERE key_id=$1",[reaffirmKey])).rows[0]?.policy_revision).toBe(3);
      await updateChannelSettings("channel",new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/settings",{
        method:"PATCH",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({contributionMode:"broadcaster_and_moderators"}),
      }));
      await expect(reaffirmWorkerTrust("channel",reaffirmKey,reaffirmRequest())).rejects.toMatchObject({status:409,code:"trusted_worker_reaffirmation_unavailable"});
      expect((await client.query<{policy_revision:number}>("SELECT policy_revision FROM sloptogether.trusted_executions WHERE key_id=$1",[reaffirmKey])).rows[0]?.policy_revision).toBe(3);
    }finally{
      await client.query("ROLLBACK");client.release();await db.end();
    }
  },20_000);

  function configureReaffirm(history:Array<{policy_revision:number;action?:string;after_state:unknown}>,keyScopes=["worker:generation","artifact:system_approve"]){
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.startsWith("SELECT owner_twitch_user_id,policy_revision"))return {rows:[{owner_twitch_user_id:"42",policy_revision:2}],rowCount:1};
      if(sql.startsWith("SELECT issuing_twitch_user_id,scopes"))return {rows:[{issuing_twitch_user_id:"42",scopes:keyScopes}],rowCount:1};
      if(sql.startsWith("SELECT id,execution_role,policy_revision"))return {rows:[{id:"00000000-0000-4000-8000-000000000002",execution_role:"generation",policy_revision:1,issuer_twitch_user_id:"42"}],rowCount:1};
      if(sql.startsWith("SELECT policy_revision,action,after_state"))return {rows:history.map(entry=>({action:"channel.settings.update",...entry})),rowCount:history.length};
      return {rows:[],rowCount:1};
    });
  }
  const reaffirmRequest=()=>new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/worker-keys/00000000-0000-4000-8000-000000000001/reaffirm-trust",{
    method:"POST",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({reason:"Broadcaster reviewed this trusted worker."}),
  });

  it("reaffirms an existing trusted worker after audited non-authority changes",async()=>{
    configureReaffirm([{policy_revision:2,after_state:{preairUpscaleEnabled:true,preairUpscaleWaitSeconds:1200}}]);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).resolves.toMatchObject({state:"reaffirmed"});
    const calls=mocks.clientQuery.mock.calls as Array<[string,unknown[]]>;
    const update=calls.find(([sql])=>sql.startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"));
    expect(update?.[1]).toEqual([["00000000-0000-4000-8000-000000000002"],2]);
    expect(calls.some(([sql])=>sql.includes("worker_key.trust_reaffirmed"))).toBe(true);
    expect(calls.some(([sql])=>sql.startsWith("UPDATE sloptogether.application_keys"))).toBe(false);
  });

  it("accepts a validated audited subscriber settings revision",async()=>{
    configureReaffirm([{policy_revision:2,action:"subscriber_interrupt.settings",after_state:{
      enabled:false,newSubscriptions:true,resubscriptionMessages:false,giftMode:"off",minimumGapSeconds:60,eventMaxAgeSeconds:180,hourlySpendCapUsd:0,fallback:"skip",
    }}]);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).resolves.toMatchObject({state:"reaffirmed"});
  });

  it("refuses to reaffirm across a verified EventSub revocation",async()=>{
    configureReaffirm([{policy_revision:2,action:"eventsub.revoked",after_state:{type:"channel.subscribe",currentRegistration:true}}]);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:409,code:"trusted_worker_reaffirmation_unavailable"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"))).toBe(false);
  });

  it.each([
    {history:[{policy_revision:2,after_state:{reviewerWhitelist:["99"]}}]},
    {history:[]},
    {history:[{policy_revision:2,after_state:{preairUpscaleEnabled:true}},{policy_revision:2,after_state:{preairUpscaleEnabled:true}}]},
  ])("rejects missing, duplicate, or authority-changing policy history",async({history})=>{
    configureReaffirm(history);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:409,code:"trusted_worker_reaffirmation_unavailable"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"))).toBe(false);
  });

  it("requires a broadcaster session rather than a controller key",async()=>{
    mocks.requestPrincipal.mockResolvedValue({kind:"worker-key",worker:{issuingTwitchUserId:"42",scopes:["streamer:control"]}});
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:403,code:"broadcaster_session_required"});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a different signed-in Twitch user",async()=>{
    mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"99"}});
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:403,code:"broadcaster_session_required"});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("cannot add trust to a key lacking the existing approval scope",async()=>{
    configureReaffirm([{policy_revision:2,after_state:{preairUpscaleEnabled:true}}],["worker:generation"]);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:404,code:"trusted_worker_key_not_found"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"))).toBe(false);
  });

  it("cannot reaffirm a binding whose worker role is no longer in the key scopes",async()=>{
    configureReaffirm([{policy_revision:2,after_state:{preairUpscaleEnabled:true}}],["worker:upscale","artifact:system_approve"]);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:409,code:"trusted_worker_binding_invalid"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"))).toBe(false);
  });

  it("does not reaffirm a revoked or expired key",async()=>{
    configureReaffirm([{policy_revision:2,after_state:{preairUpscaleEnabled:true}}]);
    const previous=mocks.clientQuery.getMockImplementation()!;
    mocks.clientQuery.mockImplementation(async(sql:string,...args:unknown[])=>sql.startsWith("SELECT issuing_twitch_user_id,scopes")
      ?{rows:[],rowCount:0}:previous(sql,...args));
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:404,code:"trusted_worker_key_not_found"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"))).toBe(false);
  });

  it("does not reaffirm a banned broadcaster or key issuer",async()=>{
    configureReaffirm([{policy_revision:2,after_state:{preairUpscaleEnabled:true}}]);
    mocks.isBanned.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(reaffirmWorkerTrust("channel","00000000-0000-4000-8000-000000000001",reaffirmRequest())).rejects.toMatchObject({status:403,code:"channel_ban_active"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE sloptogether.trusted_executions SET policy_revision"))).toBe(false);
  });

  it("fences pending pre-air jobs when a broadcaster disables the policy",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.startsWith("UPDATE sloptogether.channels SET"))return {rows:[{policy_revision:3}],rowCount:1};
      if(sql.includes("SELECT p.base_asset_id,"))return {rows:[{base_asset_id:"00000000-0000-4000-8000-000000000001",verified_job_id:"00000000-0000-4000-8000-000000000002"}],rowCount:1};
      return {rows:[],rowCount:1};
    });
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/settings",{method:"PATCH",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({preairUpscaleEnabled:false})});
    await updateChannelSettings("channel",request);
    const sql=mocks.clientQuery.mock.calls.map(([statement])=>String(statement)).join("\n");
    expect(sql).toContain("fence=fence+1");
    expect(sql).toContain("fallback_reason='policy_disabled'");
    expect(sql).toContain("event_kind='media.publish_requested'");
  });

  it("does not fence an unverified job when disabling the policy",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.startsWith("UPDATE sloptogether.channels SET"))return {rows:[{policy_revision:3}],rowCount:1};
      if(sql.includes("SELECT p.base_asset_id,"))return {rows:[{base_asset_id:"00000000-0000-4000-8000-000000000001",verified_job_id:null}],rowCount:1};
      return {rows:[],rowCount:1};
    });
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/channel/settings",{method:"PATCH",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({preairUpscaleEnabled:false})});
    await updateChannelSettings("channel",request);
    const sql=mocks.clientQuery.mock.calls.map(([statement])=>String(statement)).join("\n");
    expect(sql).not.toContain("UPDATE sloptogether.job_attempts SET state='cancelled'");
    expect(sql).toContain("fallback_reason='policy_disabled'");
  });
});
