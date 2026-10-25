import { beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),clientQuery:vi.fn(),findChannel:vi.fn(),requestPrincipal:vi.fn(),requireChannelModerator:vi.fn(),requireStreamerController:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction,transactionOnClient:vi.fn()}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,requireChannelModerator:mocks.requireChannelModerator,requireStreamerController:mocks.requireStreamerController}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));

import { issueWorkerKey,readChannelSettings } from "./channel-service";

describe("channel settings owner budget summary",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    mocks.findChannel.mockResolvedValue({
      twitch_channel_id:"123",twitch_login:"channel",display_name:"Channel",contribution_mode:"any_non_banned_twitch_user",
      contributor_whitelist:[],reviewer_whitelist:[],upload_approval_bypass_ids:[],role_based_upload_bypass:[],subscriber_interrupt_policy:{},
      story_world_prompt:"A safe story",h3_style_profile:"trim",owner_budget_cap_usd:"0.5500",policy_revision:2,chat_voting_enabled:false,
    });
    mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"42"}});
    mocks.requireChannelModerator.mockResolvedValue("42");
    mocks.requireStreamerController.mockResolvedValue("42");
    mocks.query.mockResolvedValue({rows:[{committed:"0.5500"}],rowCount:1});
    mocks.clientQuery.mockResolvedValue({rows:[],rowCount:1});
    mocks.transaction.mockImplementation(async(callback:(client:{query:typeof mocks.clientQuery})=>unknown)=>callback({query:mocks.clientQuery}));
    vi.stubEnv("PUBLIC_APP_URL","https://www.clips.gg/sloptogether");
    vi.stubEnv("SLOPTOGETHER_KEY_HASH_PEPPER","test-worker-key-hash-pepper-0123456789");
  });

  it("returns the channel-scoped non-released owner reservations and remaining cap",async()=>{
    const settings=await readChannelSettings("channel",new Request("https://clips.gg/sloptogether/api/v1/channels/channel/settings"));
    expect(settings).toMatchObject({ownerBudgetCapUsd:0.55,ownerBudgetCommittedUsd:0.55,ownerBudgetRemainingUsd:0});
    const [sql,values]=mocks.query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain("source='owner_budget'");
    expect(sql).toContain("state<>'released'");
    expect(sql).toContain("greatest(reserved_usd,coalesce(actual_cost_usd,0))");
    expect(values).toEqual(["123"]);
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
});
