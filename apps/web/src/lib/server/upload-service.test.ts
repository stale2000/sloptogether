import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),principal:vi.fn(),findChannel:vi.fn(),isBanned:vi.fn(),canContribute:vi.fn(),canReview:vi.fn(),sign:vi.fn(),signRead:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction,DatabaseUnavailable:class extends Error{}}));
vi.mock("./principals",()=>({requestPrincipal:mocks.principal}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,isBanned:mocks.isBanned,canContribute:mocks.canContribute,canReviewContent:mocks.canReview,principalTwitchId:()=>"42"}));
vi.mock("./crypto",()=>({signUploadTicket:mocks.sign,constantTimeEqual:vi.fn()}));
vi.mock("./storage",()=>({createQuarantineObjectKey:()=>"incoming/123/attempt/video.mp4",signedDirectUploadUrl:vi.fn(),copyToImmutableSnapshot:vi.fn(),signedPrivateReadUrl:mocks.signRead}));
import { getApprovedMediaAsset,issueAssetUpload } from "./upload-service";

const id="123e4567-e89b-42d3-a456-426614174000";
const attempt=()=>({id,job_id:id,fence:"1",state:"running",job_state:"running",worker_device_id:null,execution_binding_id:id,output_asset_id:null,lease_expires_at:new Date(Date.now()+60_000),attempt_deadline_at:new Date(Date.now()+600_000),twitch_channel_id:"123",stage:"video_upscale",key_id:"key",binding_revoked_at:null,input_screen_id:id,input_state:"clear",interrupt_actor_id:null});
const request=()=>new Request(`https://www.clips.gg/sloptogether/api/v1/workers/leases/${id}/uploads`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fence:1,contentType:"video/mp4",fileName:"clip.mp4",byteSize:5,sha256:"a".repeat(64)})});

describe("worker upload screening admission",()=>{
  beforeEach(()=>{
    vi.stubEnv("SLOPTOGETHER_UPLOAD_WORKER_ORIGIN","https://uploads.clips.gg");
    mocks.sign.mockReturnValue("signed.ticket");mocks.signRead.mockResolvedValue("https://private-media.example/frame?signature=short-lived");mocks.findChannel.mockResolvedValue({twitch_channel_id:"123",policy_revision:7});mocks.isBanned.mockResolvedValue(false);mocks.canContribute.mockResolvedValue(true);mocks.canReview.mockResolvedValue(false);
    mocks.principal.mockResolvedValue({kind:"worker-key",worker:{keyId:"key",channelId:"123",scopes:["worker:upscale"],paired:false}});
    mocks.query.mockResolvedValue({rows:[attempt()]});
    const client={query:vi.fn(async(sql:string)=>sql.includes("SELECT policy_revision")?{rows:[{policy_revision:7}],rowCount:1}:sql.includes("SELECT a.id FROM")?{rows:[{id}],rowCount:1}:sql.includes("SELECT count(*)")?{rows:[{n:"0"}],rowCount:1}:{rows:[],rowCount:1})};
    mocks.transaction.mockImplementation(async(fn:(c:typeof client)=>Promise<unknown>)=>fn(client));
  });
  afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()});
  it("admits a clear nonexpiring input screen",async()=>{
    const result=await issueAssetUpload(id,request());
    expect(result.uploadUrl).toContain("https://uploads.clips.gg/uploads/");
    const sql=String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("(s.expires_at IS NULL OR s.expires_at>now())");
    expect(sql).toContain("s.twitch_channel_id=j.twitch_channel_id");
    expect(sql).toContain("s.id::text=(j.planning_payload->>'inputScreenId')");
  });
  it.each(["pending","held","rejected",null])("rejects an input screen in state %s",async input_state=>{
    mocks.query.mockResolvedValue({rows:[{...attempt(),input_state}]});
    await expect(issueAssetUpload(id,request())).rejects.toMatchObject({status:409,code:"input_screen_not_clear"});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("Extension previews for approved future start frames",()=>{
  beforeEach(()=>{
    mocks.signRead.mockResolvedValue("https://private-media.example/frame?signature=short-lived");
    mocks.findChannel.mockResolvedValue({twitch_channel_id:"123",policy_revision:7});
    mocks.isBanned.mockResolvedValue(false);
    mocks.canReview.mockResolvedValue(false);
    mocks.principal.mockResolvedValue({kind:"extension",extension:{channelId:"123",role:"viewer",linkedTwitchUserId:null,opaqueUserId:"U-viewer",linkedTwitchLogin:null,expiresAt:Date.now()/1000+60}});
    mocks.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{storage_key:"private/start.png",content_type:"image/png",twitch_channel_id:"123",uploaded_by_twitch_user_id:null,media_kind:"image",status:"approved",extension_preview:true}]});
  });
  afterEach(()=>vi.clearAllMocks());

  it("grants a short signed preview only for an approved candidate frame in the same channel",async()=>{
    const result=await getApprovedMediaAsset(id,new Request("https://www.clips.gg/sloptogether/api/v1/media/"+id+"/preview"));
    expect(result).toMatchObject({url:"https://private-media.example/frame?signature=short-lived",contentType:"image/png",extensionScopedPreview:true});
    expect(mocks.signRead).toHaveBeenCalledWith("private/start.png",60);
    const sql=String(mocks.query.mock.calls[1]?.[0]);
    expect(sql).toContain("i.approved_candidate_revision=i.candidate_revision");
    expect(sql).toContain("boundary.asset_id=a.id");
  });

  it("does not share candidate frames across Twitch channels",async()=>{
    mocks.principal.mockResolvedValue({kind:"extension",extension:{channelId:"999",role:"viewer",linkedTwitchUserId:null,opaqueUserId:"U-viewer",linkedTwitchLogin:null,expiresAt:Date.now()/1000+60}});
    await expect(getApprovedMediaAsset(id,new Request("https://www.clips.gg/sloptogether/api/v1/media/"+id+"/preview")))
      .rejects.toMatchObject({status:404,code:"media_not_found"});
    expect(mocks.signRead).not.toHaveBeenCalled();
  });
});
