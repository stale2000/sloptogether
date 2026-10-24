import { beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),findChannel:vi.fn(),requestPrincipal:vi.fn(),requireChannelModerator:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:vi.fn(),transactionOnClient:vi.fn()}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,requireChannelModerator:mocks.requireChannelModerator}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));

import { readChannelSettings } from "./channel-service";

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
    mocks.query.mockResolvedValue({rows:[{committed:"0.5500"}],rowCount:1});
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
});
