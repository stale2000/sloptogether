import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),findChannel:vi.fn(),requestPrincipal:vi.fn(),requireStreamerController:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:vi.fn()}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,requireStreamerController:mocks.requireStreamerController,isBanned:vi.fn()}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));
vi.mock("./preflight",()=>({screenPromptAndImages:vi.fn()}));
vi.mock("./storage",()=>({signedPrivateReadUrl:vi.fn()}));
vi.mock("./subscriber-service",()=>({cancelPendingInterrupts:vi.fn()}));
vi.mock("./worker-revocation",()=>({abandonStoryProducerPlans:vi.fn(),lockRevokedWorkerSegments:vi.fn(),retireRevokedWorkerJobs:vi.fn()}));

import { listOverrideCandidates } from "./override-service";

describe("streamer override candidates",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    mocks.findChannel.mockResolvedValue({twitch_channel_id:"123"});
    mocks.requestPrincipal.mockResolvedValue({kind:"session",session:{twitchUserId:"42"}});
    mocks.requireStreamerController.mockResolvedValue("42");
    mocks.query.mockResolvedValue({rows:[{proposal_id:"proposal",segment_revision_id:"revision",start_boundary_revision_id:"boundary",start_frame_asset_id:"asset",election_id:"election",prompt:"A fox finds a map",state:"eligible",votes:"3"}]});
  });
  afterEach(()=>vi.unstubAllEnvs());

  it("loads eligible reviewed proposals for the streamer-selected scene",async()=>{
    const result=await listOverrideCandidates("channel",new Request("https://clips.gg/sloptogether/api/v1/channels/channel/timeline/override-candidates?segmentId=00000000-0000-4000-8000-000000000001"));

    expect(result.candidates).toEqual([{proposalId:"proposal",segmentRevisionId:"revision",startBoundaryRevisionId:"boundary",startFrameAssetId:"asset",electionId:"election",title:"A fox finds a map",votes:3,state:"eligible"}]);
    const [sql,values]=mocks.query.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain("JOIN sloptogether.segment_revisions sr ON sr.id=p.segment_revision_id");
    expect(sql).toContain("JOIN sloptogether.boundary_revisions bnd ON bnd.id=sr.start_boundary_revision_id");
    expect(sql).toContain("JOIN sloptogether.assets a ON a.id=bnd.asset_id");
    expect(sql).toContain("sr.state IN ('proposal','selected')");
    expect(sql).toContain("GROUP BY p.id,e.id,sr.start_boundary_revision_id,a.id");
    expect(values).toEqual(["123","00000000-0000-4000-8000-000000000001"]);
  });
});
