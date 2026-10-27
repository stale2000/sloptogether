import {createHash,randomBytes,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {compileH3StoryPrompt} from "@sloptogether/contracts";

const preflight=vi.hoisted(()=>({screenPromptAndImages:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./preflight",()=>preflight);
vi.mock("./storage",()=>({signedPrivateReadUrl:vi.fn(async(key:string)=>`http://private.test/${encodeURIComponent(key)}`)}));

import {pool} from "./db";
import {hashWorkerSecret} from "./crypto";
import * as principalModule from "./principals";
import {createStoryBatch,listStoryBatches} from "./story-batch-service";
import {claimStoryProducer,claimWorkerLease,downloadWorkerAsset,submitStoryProposal} from "./worker-service";

const url=process.env.SLOPTOGETHER_POLICY_TEST_DATABASE_URL;
const integration=url?describe:describe.skip;
let database:ReturnType<typeof pool>|undefined;
let channelId="", streamId="", branchId="", initialBoundaryId="", credential="";
const frame=Buffer.from("synthetic story frame");
const scene={visualAction:"A cartoon fox follows a glowing comet past a small moon.",
  camera:"One continuous playful cartoon shot.",speakerId:"S1",speakerCharacter:"a cartoon fox",
  voiceDescription:"a warm curious voice",dialogue:"Let's see where the comet goes!",soundscape:"Gentle wind and soft chimes.",music:"none" as const};

function ownerRequest(requestId:string){
  return new Request("http://localhost:3000/sloptogether/api/v1/channels/test/streams/main/story-batches",{
    method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify({requestId}),
  });
}
function workerRequest(path:string,body:unknown={}){
  return new Request(`http://127.0.0.1:3000/sloptogether/api/v1/${path}`,{method:"POST",headers:{
    Authorization:`SlopWorker ${credential}`,"Content-Type":"application/json",
  },body:JSON.stringify(body)});
}

integration("four-scene story batch PostgreSQL flow",()=>{
  beforeAll(async()=>{
    const target=new URL(url!);
    const marker=process.env.SLOPTOGETHER_EVENTSUB_TEST_GUARD_MARKER;
    if(process.env.NODE_ENV!=="test"||target.protocol!=="postgresql:"||target.hostname!=="127.0.0.1"||target.port!=="56432"
      ||target.username!=="postgres"||target.password||!/^\/sloptogether_preair_test_[a-f0-9]{16}$/.test(target.pathname)||target.search||target.hash
      ||!marker||!/^[a-f0-9]{48}$/.test(marker))throw new Error("story_batch_requires_guarded_scratch_database");
    vi.stubEnv("DATABASE_URL",url!);
    vi.stubEnv("SLOPTOGETHER_KEY_HASH_PEPPER","local-only-story-batch-pepper-0123456789");
    vi.stubEnv("SLOPTOGETHER_UPLOAD_TICKET_KEY","local-only-story-batch-ticket-key-0123456789");
    vi.stubEnv("SLOPTOGETHER_UPLOAD_WORKER_ORIGIN","https://uploads.clips.gg");
    vi.stubEnv("SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD","0.01");
    vi.stubEnv("PUBLIC_APP_URL","http://localhost:3000/sloptogether");
    database=pool();
    const identity=await database.query(`SELECT current_database() AS name,current_setting('data_directory') AS path,
      host(inet_server_addr()) AS host,inet_server_port() AS port,
      (SELECT marker FROM public.sloptogether_eventsub_test_guard LIMIT 1) AS marker`);
    if(identity.rows[0]?.name!==target.pathname.slice(1)||identity.rows[0]?.path!=="/tmp/sloptogether-pg"
      ||identity.rows[0]?.host!=="127.0.0.1"||Number(identity.rows[0]?.port)!==56432||identity.rows[0]?.marker!==marker)
      throw new Error("story_batch_database_identity_not_allowed");
    channelId=(BigInt("830000000000000")+BigInt(`0x${randomBytes(4).toString("hex")}`)).toString();
    await database.query(`INSERT INTO sloptogether.channels(twitch_channel_id,owner_twitch_user_id,twitch_login,display_name,owner_budget_cap_usd)
      VALUES($1,$1,$2,'Local story batch',1)`,[channelId,`batch_${channelId}`]);
    streamId=(await database.query<{id:string}>("SELECT id FROM sloptogether.streams WHERE twitch_channel_id=$1 AND is_default",[channelId])).rows[0]!.id;
    branchId=(await database.query<{id:string}>("SELECT id FROM sloptogether.branches WHERE stream_id=$1 AND is_selected AND archived_at IS NULL",[streamId])).rows[0]!.id;
    const assetId=randomUUID();
    await database.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status)
      VALUES($1,$2,$3,$4,'image','image/png',$5,'approved')`,[assetId,channelId,`batch/${channelId}/first.png`,createHash("sha256").update(frame).digest(),frame.length]);
    initialBoundaryId=(await database.query<{id:string}>("INSERT INTO sloptogether.boundary_revisions(twitch_channel_id,asset_id,created_by) VALUES($1,$2,$1) RETURNING id",[channelId,assetId])).rows[0]!.id;
    const segmentId=(await database.query<{id:string}>("SELECT id FROM sloptogether.segments WHERE branch_id=$1 AND ordinal=0",[branchId])).rows[0]!.id;
    const revisionId=randomUUID();
    await database.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,requested_end_boundary_revision_id,
      planning_mode,provider_recipe_id,input_sha256,requested_by,state)
      VALUES($1,$2,1,'Initial approved scene',$3,$3,'planned_anchors','fast-h3-trim-5step-vsa20-b1',$4,$5,'ready')`,
      [revisionId,segmentId,initialBoundaryId,Buffer.alloc(32,1),channelId]);
    await database.query("UPDATE sloptogether.segments SET selected_revision_id=$2,state='played' WHERE id=$1",[segmentId,revisionId]);
    const keyId=randomUUID();
    credential=`slw_${keyId}.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-`;
    await database.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,
      display_name,scopes,worker_roles) VALUES($1,$2,$3,$4,$4,'Local batch worker',ARRAY['story:write_future','worker:generation'],ARRAY['story-producer','generation'])`,
      [keyId,hashWorkerSecret(credential),`slw_${keyId}`,channelId]);
    await database.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision)
      SELECT $1,$2,$1,role,policy_revision FROM sloptogether.channels CROSS JOIN (VALUES('story_producer'),('generation')) roles(role)
      WHERE twitch_channel_id=$1`,[channelId,keyId]);
    vi.stubGlobal("fetch",async(input:RequestInfo|URL)=>{
      const target=new URL(String(input));if(target.hostname!=="private.test")throw new Error("story_batch_external_network_blocked");
      return new Response(frame,{status:200,headers:{"Content-Type":"image/png"}});
    });
    preflight.screenPromptAndImages.mockImplementation(async({prompt,images}:{prompt:string;images:Array<{bytes:Buffer}>})=>{
      const promptDigest=createHash("sha256").update(prompt).digest();
      const imageDigests=images.map(image=>createHash("sha256").update(image.bytes).digest());
      const digest=createHash("sha256").update(Buffer.concat([promptDigest,...imageDigests])).digest();
      await database!.query(`INSERT INTO sloptogether.input_screens(twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,
        moderation_policy_revision,automated_state,effective_state,expires_at) VALUES($1,$2,$3,$4,'local-test',1,'clear','clear',now()+interval '1 hour') ON CONFLICT DO NOTHING`,
        [channelId,digest,promptDigest,imageDigests.map(value=>value.toString("hex"))]);
      return {decision:"clear",digest:digest.toString("hex"),promptDigest:promptDigest.toString("hex"),imageDigests:imageDigests.map(value=>value.toString("hex")),model:"local-test"};
    });
  },20_000);
  afterAll(async()=>{await database?.end();globalThis.__sloptogetherPool=undefined;vi.unstubAllGlobals();vi.unstubAllEnvs();});

  it("queues four ordered jobs, waits for each approved end frame, and stops",async()=>{
    // A running producer must not create ordinary story jobs without a click.
    await expect(claimStoryProducer(channelId,workerRequest("channels/test/streams/main/story-producer/leases"))).resolves.toEqual({status:"empty"});
    const session={id:channelId,twitchUserId:channelId,twitchLogin:`batch_${channelId}`,displayName:"Local Owner",accessToken:"local-test",
      scopes:["openid"],expiresAt:new Date(Date.now()+60_000)};
    const spy=vi.spyOn(principalModule,"requestPrincipal").mockResolvedValue({kind:"session",session});
    const requestId=randomUUID();
    let batchId="";
    try{
      spy.mockResolvedValueOnce({kind:"session",session:{...session,twitchUserId:(BigInt(channelId)+1n).toString()}});
      await expect(createStoryBatch(channelId,ownerRequest(randomUUID()))).rejects.toMatchObject({status:403,code:"streamer_control_required"});
      const [first,duplicate]=await Promise.all([createStoryBatch(channelId,ownerRequest(requestId)),createStoryBatch(channelId,ownerRequest(requestId))]);
      expect(first).toMatchObject({requested:4,scheduled:0,pending:4});
      expect(duplicate.batchId).toBe(first.batchId);
      batchId=first.batchId;
      const listing=await listStoryBatches(channelId,new Request("http://localhost:3000/sloptogether/api/v1/channels/test/streams/main/story-batches"));
      expect(listing.batches).toHaveLength(1);
      const items=await database!.query<{position:number;state:string}>("SELECT position,state FROM sloptogether.story_batch_items WHERE batch_id=$1 ORDER BY position",[batchId]);
      expect(items.rows).toEqual([0,1,2,3].map(position=>({position,state:"pending"})));
    }finally{spy.mockRestore();}
    let previousBoundary=initialBoundaryId;
    for(let position=0;position<4;position++){
      const producer=await claimStoryProducer(channelId,workerRequest("channels/test/streams/main/story-producer/leases"));
      expect(producer).toMatchObject({leaseId:expect.any(String),sequence:position+1,storyContext:{taskKind:"story"}});
      const proposal=await submitStoryProposal(channelId,workerRequest("channels/test/streams/main/story-proposals",{
        leaseId:producer.leaseId,fence:producer.fence,sequence:producer.sequence,idempotencyKey:producer.idempotencyKey,claimToken:producer.claimToken,
        plan:scene,compiledH3Prompt:compileH3StoryPrompt(scene),plannerUsage:{provider:"template",inputTokens:0,outputTokens:0},
      }));
      expect(proposal).toMatchObject({accepted:true,jobScheduled:true});
      if(!("segmentId" in proposal))throw new Error("story_segment_not_scheduled");
      const item=await database!.query<{job_id:string;start_boundary_revision_id:string}>(`SELECT i.job_id,r.start_boundary_revision_id
        FROM sloptogether.story_batch_items i JOIN sloptogether.segments s ON s.id=i.segment_id
        JOIN sloptogether.segment_revisions r ON r.id=s.selected_revision_id WHERE i.batch_id=$1 AND i.position=$2`,[batchId,position]);
      expect(item.rows[0]!.start_boundary_revision_id).toBe(previousBoundary);
      const lease=await claimWorkerLease(workerRequest("workers/leases?role=generation",{supportedRecipes:["fast-h3-trim-5step-vsa20-b1"]}));
      expect(lease).toMatchObject({status:"leased",job:{jobId:item.rows[0]!.job_id,recipeId:"fast-h3-trim-5step-vsa20-b1",frameCount:362}});
      if (!("job" in lease) || !lease.job || typeof lease.leaseId !== "string" || typeof lease.fence !== "number") {
        throw new Error("worker_job_not_leased");
      }
      const assetId=lease.job.startFrameAssetId;
      if (!assetId) throw new Error("worker_start_frame_missing");
      const assetRequest=new Request(`http://127.0.0.1:3000/sloptogether/api/v1/workers/leases/${lease.leaseId}/asset/${assetId}`,{
        headers:{Authorization:`SlopWorker ${credential}`,"X-Lease-Fence":String(lease.fence)},
      });
      const assetGrant=await downloadWorkerAsset(lease.leaseId,assetId,assetRequest);
      expect(assetGrant.url).toBe("https://uploads.clips.gg/worker-media");
      expect(JSON.parse(Buffer.from(assetGrant.ticket.split(".")[0]!,"base64url").toString())).toMatchObject({
        purpose:"worker_asset_read",leaseId:lease.leaseId,assetId,fence:lease.fence,
      });
      // Exercise the actual shared Python worker's job decoder using the
      // server-produced lease, then download the authorized frame through a
      // fake HTTP opener. No model or external service is contacted.
      const parsed=JSON.parse(execFileSync("python3.12",["-c",`
import base64, io, json, pathlib, sys, tempfile
from types import SimpleNamespace
from unittest.mock import Mock
from sloptogether_worker.client import Lease, WorkerApi
from sloptogether_worker.models import WorkerJob
payload=json.load(sys.stdin)
job = WorkerJob.from_payload(payload['job'])
frame=base64.b64decode(payload['frame'])
class Response:
    headers={'Content-Length':str(len(frame))}
    def __enter__(self): self.buffer=io.BytesIO(frame); return self
    def __exit__(self,*args): return None
    def read(self,size): return self.buffer.read(size)
config=SimpleNamespace(api_base_url='https://www.clips.gg/sloptogether/api/v1',request_timeout_seconds=3,
                       worker_key=None,allowed_upload_hosts=(),local_s3_endpoint=None)
api=WorkerApi(config); api._request=Mock(return_value=(payload['grant'],{}))
api.media_opener=SimpleNamespace(open=Mock(return_value=Response()))
with tempfile.TemporaryDirectory() as directory:
    destination=str(pathlib.Path(directory)/'frame.png')
    api.download_asset(Lease(job.lease_id,job.fence,{}),job.start_frame_asset_id,destination,1024)
    assert pathlib.Path(destination).read_bytes()==frame
    request=api.media_opener.open.call_args.args[0]
    assert request.get_header('X-worker-artifact-ticket')==payload['grant']['ticket']
    assert request.get_header('Authorization') is None
print(json.dumps({"jobId": job.job_id, "stage": job.stage,
                  "startFrameAssetId": job.start_frame_asset_id,
                  "frameCount": job.frame_count, "prompt": job.prompt}))
`],{input:JSON.stringify({job:lease.job,grant:assetGrant,frame:frame.toString("base64")}),encoding:"utf8",env:{...process.env,PYTHONPATH:resolve(process.cwd(),"../../workers/runtime/src")}}));
      expect(parsed).toMatchObject({jobId:item.rows[0]!.job_id,stage:"generation",startFrameAssetId:expect.any(String),frameCount:362,
        prompt:compileH3StoryPrompt(scene)});
      if(position<3)await expect(claimStoryProducer(channelId,workerRequest("channels/test/streams/main/story-producer/leases"))).resolves.toEqual({status:"empty"});
      // Test fixture simulates a reviewed worker output and approved extracted end frame.
      const videoId=randomUUID(),frameId=randomUUID(),boundaryId=randomUUID();
      await database!.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,status,byte_size) VALUES
        ($1,$3,$4,$6,'video','video/mp4','approved',NULL),($2,$3,$5,$7,'image','image/png','approved',$8)`,
        [videoId,frameId,channelId,`batch/${channelId}/${position}.mp4`,`batch/${channelId}/${position}.png`,Buffer.alloc(32,position+2),createHash("sha256").update(frame).digest(),frame.length]);
      await database!.query("INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,created_by) VALUES($1,$2,$3,$2)",[boundaryId,channelId,frameId]);
      await database!.query(`INSERT INTO sloptogether.endpoint_resolutions(segment_revision_id,source_artifact_id,source_sha256,source_input_sha256,resolved_end_boundary_revision_id,approval_path)
        SELECT j.segment_revision_id,$2,$3,j.input_sha256,$4,'human_review' FROM sloptogether.jobs j WHERE j.id=$1`,[item.rows[0]!.job_id,videoId,Buffer.alloc(32,position+2),boundaryId]);
      await database!.query("UPDATE sloptogether.job_attempts SET state='succeeded' WHERE job_id=$1",[item.rows[0]!.job_id]);
      await database!.query("UPDATE sloptogether.jobs SET state='succeeded' WHERE id=$1",[item.rows[0]!.job_id]);
      await database!.query("UPDATE sloptogether.segment_revisions SET state='ready' WHERE segment_id=$1",[proposal.segmentId]);
      await database!.query("UPDATE sloptogether.segments SET state='ready' WHERE id=$1",[proposal.segmentId]);
      previousBoundary=boundaryId;
    }
    await expect(claimStoryProducer(channelId,workerRequest("channels/test/streams/main/story-producer/leases"))).resolves.toEqual({status:"empty"});
    const final=await database!.query<{scheduled:string;pending:string;jobs:string}>(`SELECT
      (SELECT count(*)::text FROM sloptogether.story_batch_items WHERE batch_id=$1 AND state='scheduled') AS scheduled,
      (SELECT count(*)::text FROM sloptogether.story_batch_items WHERE batch_id=$1 AND state='pending') AS pending,
      (SELECT count(*)::text FROM sloptogether.jobs WHERE twitch_channel_id=$2 AND stage='video_base') AS jobs`,[batchId,channelId]);
    expect(final.rows[0]).toEqual({scheduled:"4",pending:"0",jobs:"4"});
    const secondSpy=vi.spyOn(principalModule,"requestPrincipal").mockResolvedValue({kind:"session",session});
    try{
      const next=await createStoryBatch(channelId,ownerRequest(randomUUID()));
      expect(next).toMatchObject({requested:4,scheduled:0,pending:4});
      expect(next.batchId).not.toBe(batchId);
    }finally{secondSpy.mockRestore();}
    const afterSecondClick=await database!.query<{jobs:string}>("SELECT count(*)::text AS jobs FROM sloptogether.jobs WHERE twitch_channel_id=$1 AND stage='video_base'",[channelId]);
    expect(afterSecondClick.rows[0]).toEqual({jobs:"4"});
  },30_000);
});
