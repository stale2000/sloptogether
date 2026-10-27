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

import { listOverrideCandidates, schedulePulledGeneration } from "./override-service";
import type { PoolClient } from "pg";

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

  it("records the low-resolution profile when an override schedules a new generation",async()=>{
    const client={query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT segment_id,planning_mode,provider_recipe_id"))return {rows:[{segment_id:"segment",planning_mode:"continuation",provider_recipe_id:"fast-h3-trim-5step-vsa20-b1",input_sha256:Buffer.alloc(32),start_boundary_revision_id:"boundary",requested_end_boundary_revision_id:null}],rowCount:1};
      if(sql.includes("SELECT 1 FROM sloptogether.input_screens"))return {rows:[{}],rowCount:1};
      if(sql.includes("SELECT count(*)::text AS count FROM sloptogether.boundary_revisions"))return {rows:[{count:"1"}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    await schedulePulledGeneration(client as unknown as PoolClient,"123","revision","42","screen",false);
    const insert=client.query.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO sloptogether.jobs"));
    expect(insert).toBeDefined();
    const values=(insert as unknown as [string,unknown[]])[1];
    expect(JSON.parse(String(values[9]))).toMatchObject({inputScreenId:"screen",outputWidth:512,outputHeight:288});
  });
});
