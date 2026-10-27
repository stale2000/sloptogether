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
import {approveStoryCandidate,listStoryCandidateFrames,rejectStoryCandidate,replanStoryCandidate,retryStoryCandidateScreen} from "./story-candidate-service";

const url=process.env.SLOPTOGETHER_POLICY_TEST_DATABASE_URL;
const integration=url?describe:describe.skip;
let database:ReturnType<typeof pool>|undefined;
let channelId="", streamId="", branchId="", initialBoundaryId="", credential="";
const frame=Buffer.from("synthetic story frame");
const framesByKey=new Map<string,Buffer>();
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
    const firstKey=`batch/${channelId}/first.png`;framesByKey.set(firstKey,frame);
    await database.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status)
      VALUES($1,$2,$3,$4,'image','image/png',$5,'approved')`,[assetId,channelId,firstKey,createHash("sha256").update(frame).digest(),frame.length]);
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
      const bytes=framesByKey.get(decodeURIComponent(target.pathname.slice(1)));
      if(!bytes)throw new Error("story_batch_unexpected_private_image");
      return new Response(Uint8Array.from(bytes),{status:200,headers:{"Content-Type":"image/png"}});
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

  it("plans four candidates without rendering, and leases each only after adjacent approvals",async()=>{
    const session={id:channelId,twitchUserId:channelId,twitchLogin:`batch_${channelId}`,displayName:"Local Owner",accessToken:"local-test",
      scopes:["openid"],expiresAt:new Date(Date.now()+60_000)};
    let sessionSpy:ReturnType<typeof vi.spyOn>|undefined;
    const asOwner=()=>{ sessionSpy?.mockRestore(); sessionSpy=vi.spyOn(principalModule,"requestPrincipal").mockResolvedValue({kind:"session",session}); };
    const asWorker=()=>{ sessionSpy?.mockRestore(); sessionSpy=undefined; };
    const readRequest=()=>new Request("http://localhost:3000/sloptogether/api/v1/channels/test/streams/main/story-batches");
    const approveRequest=(boundaryRevisionId:string,expectedCandidateRevision:number)=>new Request("http://localhost:3000/sloptogether/api/v1/channels/test/streams/main/story-candidates/item/approve",{
      method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},
      body:JSON.stringify({boundaryRevisionId,expectedCandidateRevision}),
    });
    const decisionRequest=(body:unknown)=>new Request("http://localhost:3000/sloptogether/api/v1/channels/test/streams/main/story-candidates/item/decision",{
      method:"POST",headers:{Origin:"http://localhost:3000","Content-Type":"application/json"},body:JSON.stringify(body),
    });
    const claim=()=>claimStoryProducer(channelId,workerRequest("channels/test/streams/main/story-producer/leases"));
    const workerPoll=()=>claimWorkerLease(workerRequest("workers/leases?role=generation",{supportedRecipes:["fast-h3-trim-5step-vsa20-b1"]}));
    try {
      // A live producer creates nothing without a request.
      asWorker();
      await expect(claim()).resolves.toEqual({status:"empty"});
      asOwner();
      sessionSpy!.mockResolvedValueOnce({kind:"session",session:{...session,twitchUserId:(BigInt(channelId)+1n).toString()}});
      await expect(createStoryBatch(channelId,ownerRequest(randomUUID()))).rejects.toMatchObject({status:403,code:"streamer_control_required"});
      const requestId=randomUUID();
      const [first,duplicate]=await Promise.all([createStoryBatch(channelId,ownerRequest(requestId)),createStoryBatch(channelId,ownerRequest(requestId))]);
      expect(first).toMatchObject({requested:4,scheduled:0,pending:4});
      expect(duplicate.batchId).toBe(first.batchId);
      const batchId=first.batchId;
      const listing=await listStoryBatches(channelId,readRequest());
      expect(listing.batches).toHaveLength(1);
      expect(listing.batches[0]?.items).toHaveLength(4);
      expect(listing.batches[0]?.items.map(item=>item.state)).toEqual(["pending","pending","pending","pending"]);
      asWorker();
      for(let position=0;position<4;position++){
        const producer=await claim();
        if(!("leaseId" in producer)||!producer.leaseId)throw new Error("candidate_claim_missing");
        const result=await submitStoryProposal(channelId,workerRequest("channels/test/streams/main/story-proposals",{
          leaseId:producer.leaseId,fence:producer.fence,sequence:producer.sequence,
          idempotencyKey:producer.idempotencyKey,claimToken:producer.claimToken,plan:scene,
          compiledH3Prompt:compileH3StoryPrompt(scene),plannerUsage:{provider:"template",inputTokens:0,outputTokens:0},
        }));
        expect(result).toMatchObject({accepted:true,state:"planned"});
      }
      await expect(claim()).resolves.toEqual({status:"empty"});
      const planned=await database!.query<{id:string;position:number;candidate_revision:string}>(
        "SELECT id,position,candidate_revision::text FROM sloptogether.story_batch_items WHERE batch_id=$1 ORDER BY position",[batchId]);
      expect(planned.rows.map(item=>item.position)).toEqual([0,1,2,3]);
      expect(planned.rows.every(item=>item.candidate_revision==="1")).toBe(true);
      expect((await database!.query("SELECT 1 FROM sloptogether.jobs WHERE twitch_channel_id=$1",[channelId])).rowCount).toBe(0);
      expect((await database!.query("SELECT 1 FROM sloptogether.funding_authorizations WHERE twitch_channel_id=$1",[channelId])).rowCount).toBe(0);
      asOwner();
      const visible=await listStoryBatches(channelId,readRequest());
      expect(visible.batches[0]?.items).toHaveLength(4);
      expect(visible.batches[0]?.items.every(item=>item.state==="planned"&&item.prompt===scene.visualAction)).toBe(true);
      const frames=await listStoryCandidateFrames(channelId,readRequest());
      expect(frames.frames.some(item=>item.boundaryRevisionId===initialBoundaryId)).toBe(true);
      // Give each candidate its own approved frame without generating a video.
      // Archived revisions tie the frames to this stream for the picker.
      const boundaries=[initialBoundaryId];
      const initialSegment=(await database!.query<{id:string}>("SELECT segment_id AS id FROM sloptogether.segment_revisions WHERE requested_end_boundary_revision_id=$1 LIMIT 1",[initialBoundaryId])).rows[0]!.id;
      for(let index=1;index<5;index++){
        const asset=randomUUID(),boundary=randomUUID();
        const key=`batch/${channelId}/anchor-${index}.png`,bytes=Buffer.from(`synthetic story frame ${index}`);
        framesByKey.set(key,bytes);
        await database!.query(`INSERT INTO sloptogether.assets(id,twitch_channel_id,storage_key,sha256,media_kind,content_type,byte_size,status)
          VALUES($1,$2,$3,$4,'image','image/png',$5,'approved')`,[asset,channelId,key,createHash("sha256").update(bytes).digest(),bytes.length]);
        await database!.query("INSERT INTO sloptogether.boundary_revisions(id,twitch_channel_id,asset_id,created_by) VALUES($1,$2,$3,$2)",[boundary,channelId,asset]);
        await database!.query(`INSERT INTO sloptogether.segment_revisions(segment_id,revision,prompt,start_boundary_revision_id,requested_end_boundary_revision_id,
          planning_mode,provider_recipe_id,input_sha256,requested_by,state)
          VALUES($1,$2,'Prior approved image',$3,$3,'planned_anchors','fast-h3-trim-5step-vsa20-b1',$4,$5,'superseded')`,
          [initialSegment,index+1,boundary,Buffer.alloc(32,index+1),channelId]);
        boundaries.push(boundary);
      }
      // Approving the final item before any successor is legitimate and must not schedule it.
      await expect(approveStoryCandidate(channelId,planned.rows[3]!.id,approveRequest(boundaries[3]!,1))).resolves.toMatchObject({approved:true});
      const lastApproved=await listStoryBatches(channelId,readRequest());
      expect(lastApproved.batches[0]?.items[3]).toMatchObject({position:3,state:"planned",candidateApproved:true,endFrameUrl:null});
      await expect(rejectStoryCandidate(channelId,planned.rows[3]!.id,decisionRequest({expectedCandidateRevision:2,reason:"review"}))).rejects.toMatchObject({status:409,code:"story_candidate_already_approved"});
      asWorker();
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      // A single approved candidate is not enough; its successor must be approved too.
      asOwner();
      await expect(approveStoryCandidate(channelId,planned.rows[0]!.id,approveRequest(boundaries[0]!,1))).resolves.toMatchObject({approved:true});
      asWorker();
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      asOwner();
      await expect(approveStoryCandidate(channelId,planned.rows[1]!.id,approveRequest(boundaries[1]!,1))).resolves.toMatchObject({approved:true});
      const endAsset=(await database!.query<{asset_id:string}>("SELECT asset_id FROM sloptogether.boundary_revisions WHERE id=$1",[boundaries[1]])).rows[0]!.asset_id;
      const firstPair=await listStoryBatches(channelId,readRequest());
      expect(firstPair.batches[0]?.items[0]).toMatchObject({candidateApproved:true,candidateRevision:2,endFrameUrl:`/sloptogether/api/v1/media/${endAsset}/preview`});
      asWorker();
      // A held screening must not loop or incur repeated screening calls.
      const beforeHeld=preflight.screenPromptAndImages.mock.calls.length;
      preflight.screenPromptAndImages.mockImplementationOnce(async()=>({decision:"held"}));
      await expect(claim()).resolves.toEqual({status:"empty"});
      await expect(claim()).resolves.toEqual({status:"empty"});
      expect(preflight.screenPromptAndImages.mock.calls.length-beforeHeld).toBe(1);
      expect((await database!.query("SELECT 1 FROM sloptogether.jobs WHERE twitch_channel_id=$1",[channelId])).rowCount).toBe(0);
      asOwner();
      const heldView=await listStoryBatches(channelId,readRequest());
      expect(heldView.batches[0]?.items[0]).toMatchObject({screenBlocked:true,canRetryScreen:true,candidateApproved:true});
      const retryId=randomUUID();
      const retry=()=>retryStoryCandidateScreen(channelId,planned.rows[0]!.id,decisionRequest({expectedCandidateRevision:2,requestId:retryId}));
      await retry(); await retry();
      asWorker();
      // An abandoned screening claim is not automatically retried: the
      // original provider request may already have incurred a charge.
      await database!.query("UPDATE sloptogether.story_batch_items SET pair_screen_token=$2,pair_screen_expires_at=now()-interval '1 second' WHERE id=$1",[planned.rows[0]!.id,randomUUID()]);
      const beforeAbandoned=preflight.screenPromptAndImages.mock.calls.length;
      await expect(claim()).resolves.toEqual({status:"empty"});
      await expect(claim()).resolves.toEqual({status:"empty"});
      expect(preflight.screenPromptAndImages.mock.calls.length).toBe(beforeAbandoned);
      expect((await database!.query<{pair_screen_blocked:boolean}>("SELECT pair_screen_blocked FROM sloptogether.story_batch_items WHERE id=$1",[planned.rows[0]!.id])).rows[0]?.pair_screen_blocked).toBe(true);
      asOwner();
      await retryStoryCandidateScreen(channelId,planned.rows[0]!.id,decisionRequest({expectedCandidateRevision:2,requestId:randomUUID()}));
      asWorker();
      // Concurrent producer polls share one in-flight screening claim.
      let release!:()=>void,entered!:()=>void;
      const gate=new Promise<void>(resolve=>{release=resolve;});
      const started=new Promise<void>(resolve=>{entered=resolve;});
      const original=preflight.screenPromptAndImages.getMockImplementation();
      if(!original)throw new Error("screen_fixture_missing");
      preflight.screenPromptAndImages.mockImplementationOnce(async(input:unknown)=>{entered();await gate;return original(input);});
      const beforeConcurrent=preflight.screenPromptAndImages.mock.calls.length;
      const inFlight=claim();
      try{
        await started;
        await expect(claim()).resolves.toEqual({status:"empty"});
        expect(preflight.screenPromptAndImages.mock.calls.length-beforeConcurrent).toBe(1);
      }finally{release();}
      await inFlight;
      // A legacy one-frame continuation tied to a batch must never be leased,
      // even if its candidate rows have since been approved.
      const firstJob=(await database!.query<{job_id:string}>("SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position=0",[batchId])).rows[0]!;
      await database!.query("UPDATE sloptogether.segment_revisions SET planning_mode='continuation',requested_end_boundary_revision_id=NULL WHERE id=(SELECT segment_revision_id FROM sloptogether.jobs WHERE id=$1)",[firstJob.job_id]);
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      await database!.query("UPDATE sloptogether.segment_revisions SET planning_mode='planned_anchors',requested_end_boundary_revision_id=$2 WHERE id=(SELECT segment_revision_id FROM sloptogether.jobs WHERE id=$1)",[firstJob.job_id,boundaries[1]]);
      asOwner();
      await expect(approveStoryCandidate(channelId,planned.rows[2]!.id,approveRequest(boundaries[2]!,1))).resolves.toMatchObject({approved:true});
      asWorker();
      // Polling the producer schedules approved adjacent pairs without needing any video output.
      await claim();
      await claim();
      const ready=await database!.query<{position:number;state:string;requested_end_boundary_revision_id:string|null;start_boundary_revision_id:string|null}>(
        `SELECT i.position,j.state,r.requested_end_boundary_revision_id,r.start_boundary_revision_id
         FROM sloptogether.story_batch_items i LEFT JOIN sloptogether.jobs j ON j.id=i.job_id
         LEFT JOIN sloptogether.segment_revisions r ON r.id=j.segment_revision_id
         WHERE i.batch_id=$1 ORDER BY i.position`,[batchId]);
      for(const position of [0,1,2])expect(ready.rows[position]).toMatchObject({state:"ready",start_boundary_revision_id:boundaries[position],requested_end_boundary_revision_id:boundaries[position+1]});
      expect(ready.rows[3]!.state).toBeNull();
      await expect(claim()).resolves.toEqual({status:"empty"});
      expect((await database!.query("SELECT 1 FROM sloptogether.jobs WHERE twitch_channel_id=$1",[channelId])).rowCount).toBe(3);
      // Corrupt cross-stream item references cannot expose the selected job's data.
      const originalItem=(await database!.query<{job_id:string;segment_id:string}>("SELECT job_id,segment_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position=0",[batchId])).rows[0]!;
      // A tampered job payload must never override the approved prompt or
      // anchors, or consume funding before those exact inputs are screened.
      const originalJob=(await database!.query<{planning_payload:Record<string,unknown>;input_sha256:Buffer}>(
        "SELECT planning_payload,input_sha256 FROM sloptogether.jobs WHERE id=$1",[originalItem.job_id])).rows[0]!;
      await database!.query("UPDATE sloptogether.jobs SET state='cancelled' WHERE id IN (SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position IN (1,2))",[batchId]);
      const replacementAsset=(await database!.query<{asset_id:string}>("SELECT asset_id FROM sloptogether.boundary_revisions WHERE id=$1",[boundaries[2]])).rows[0]!.asset_id;
      for(const change of [{prompt:"Unapproved injected prompt"},{startBoundaryRevisionId:boundaries[2]},{startFrameAssetId:replacementAsset}]){
        await database!.query("UPDATE sloptogether.jobs SET planning_payload=$2::jsonb WHERE id=$1",[originalItem.job_id,JSON.stringify({...originalJob.planning_payload,...change})]);
        await expect(workerPoll()).resolves.toEqual({status:"empty"});
        const unspent=await database!.query<{state:string;claimed_at:Date|null;funding_state:string}>(`SELECT j.state,a.claimed_at,f.state AS funding_state FROM sloptogether.jobs j
          JOIN sloptogether.job_attempts a ON a.job_id=j.id JOIN sloptogether.funding_authorizations f ON f.id=j.funding_id WHERE j.id=$1`,[originalItem.job_id]);
        expect(unspent.rows[0]).toMatchObject({state:"ready",claimed_at:null,funding_state:"reserved"});
      }
      await database!.query("UPDATE sloptogether.jobs SET planning_payload=$2::jsonb,input_sha256=$3 WHERE id=$1",[originalItem.job_id,JSON.stringify(originalJob.planning_payload),Buffer.alloc(32,77)]);
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      await database!.query("UPDATE sloptogether.jobs SET input_sha256=$2 WHERE id=$1",[originalItem.job_id,originalJob.input_sha256]);
      const screenId=originalJob.planning_payload.inputScreenId;
      if(typeof screenId!=="string")throw new Error("screen_fixture_missing");
      const originalScreen=(await database!.query<{input_sha256:Buffer;prompt_sha256:Buffer;image_sha256s:string[]}>(
        "SELECT input_sha256,prompt_sha256,image_sha256s FROM sloptogether.input_screens WHERE id=$1",[screenId])).rows[0]!;
      expect(originalScreen.image_sha256s).toHaveLength(2);
      expect(originalScreen.image_sha256s[0]).not.toBe(originalScreen.image_sha256s[1]);
      for(const [column,value] of [["input_sha256",Buffer.alloc(32,78)],["prompt_sha256",Buffer.alloc(32,79)],
        ["image_sha256s",[...originalScreen.image_sha256s].reverse()]] as const){
        // The column name is a fixed test constant, never user input.
        await database!.query(`UPDATE sloptogether.input_screens SET ${column}=$2 WHERE id=$1`,[screenId,value]);
        await expect(workerPoll()).resolves.toEqual({status:"empty"});
        const unspent=await database!.query<{claimed_at:Date|null;funding_state:string}>(`SELECT a.claimed_at,f.state AS funding_state
          FROM sloptogether.jobs j JOIN sloptogether.job_attempts a ON a.job_id=j.id
          JOIN sloptogether.funding_authorizations f ON f.id=j.funding_id WHERE j.id=$1`,[originalItem.job_id]);
        expect(unspent.rows[0]).toMatchObject({claimed_at:null,funding_state:"reserved"});
        await database!.query(`UPDATE sloptogether.input_screens SET ${column}=$2 WHERE id=$1`,[screenId,originalScreen[column]]);
      }
      await database!.query("UPDATE sloptogether.jobs SET state='ready' WHERE id IN (SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position IN (1,2))",[batchId]);
      const otherStream=(await database!.query<{id:string}>(`INSERT INTO sloptogether.streams(twitch_channel_id,slug,display_name,created_by)
        VALUES($1,'other','Other',$1) RETURNING id`,[channelId])).rows[0]!.id;
      const otherBatch=(await database!.query<{id:string}>(`INSERT INTO sloptogether.story_batches(twitch_channel_id,stream_id,requested_by,request_id)
        VALUES($1,$2,$1,$3) RETURNING id`,[channelId,otherStream,randomUUID()])).rows[0]!.id;
      const corrupt=(await database!.query<{id:string}>("INSERT INTO sloptogether.story_batch_items(batch_id,position,state,segment_id,job_id) VALUES($1,0,'scheduled',$2,$3) RETURNING id",[otherBatch,originalItem.segment_id,originalItem.job_id])).rows[0]!;
      await database!.query("INSERT INTO sloptogether.story_batch_items(batch_id,position) SELECT $1,position FROM generate_series(1,3) AS position",[otherBatch]);
      asOwner();
      const isolated=await listStoryBatches(channelId,readRequest(),"other");
      expect(isolated.batches[0]?.items[0]).toMatchObject({state:"superseded",prompt:null,dialogue:null,startFrameUrl:null,endFrameUrl:null});
      await expect(approveStoryCandidate(channelId,corrupt.id,approveRequest(boundaries[0]!,1),"other")).rejects.toMatchObject({status:404});
      await expect(rejectStoryCandidate(channelId,corrupt.id,decisionRequest({expectedCandidateRevision:1,reason:"review"}),"other")).rejects.toMatchObject({status:404});
      await expect(replanStoryCandidate(channelId,corrupt.id,decisionRequest({expectedCandidateRevision:1,requestId:randomUUID()}),"other")).rejects.toMatchObject({status:404});
      asWorker();
      const lease=await workerPoll();
      expect(lease).toMatchObject({status:"leased",job:{recipeId:"fast-h3-trim-5step-vsa20-b1",frameCount:362,
        requestedEndBoundaryRevisionId:boundaries[1],endFrameAssetId:expect.any(String),startFrameAssetId:expect.any(String)}});
      if (!("job" in lease) || !lease.job || typeof lease.leaseId!=="string" || typeof lease.fence!=="number") throw new Error("worker_job_not_leased");
      const expectedAssets=await database!.query<{id:string;asset_id:string}>("SELECT id,asset_id FROM sloptogether.boundary_revisions WHERE id=ANY($1::uuid[])",[boundaries.slice(0,2)]);
      const assetFor=(id:string)=>expectedAssets.rows.find(row=>row.id===id)!.asset_id;
      expect(lease.job.startFrameAssetId).toBe(assetFor(boundaries[0]!));
      expect(lease.job.endFrameAssetId).toBe(assetFor(boundaries[1]!));
      const granted:Array<{assetId:string;grant:{url:string;ticket:string};frame:string}>=[];
      for(const [index,assetId] of [lease.job.startFrameAssetId,lease.job.endFrameAssetId].entries()){
        if(!assetId)throw new Error("worker_anchor_missing");
        const request=new Request(`http://127.0.0.1:3000/sloptogether/api/v1/workers/leases/${lease.leaseId}/asset/${assetId}`,{
          headers:{Authorization:`SlopWorker ${credential}`,"X-Lease-Fence":String(lease.fence)},
        });
        const grant=await downloadWorkerAsset(lease.leaseId,assetId,request);
        expect(grant.url).toBe("https://uploads.clips.gg/worker-media");
        expect(JSON.parse(Buffer.from(grant.ticket.split(".")[0]!,"base64url").toString())).toMatchObject({
          purpose:"worker_asset_read",leaseId:lease.leaseId,assetId,fence:lease.fence,
        });
        const bytes=index===0?frame:Buffer.from("synthetic story frame 1");
        granted.push({assetId,grant,frame:bytes.toString("base64")});
      }
      // Parse the real server payload with the shared Python worker, without
      // running Comfy or contacting a provider.
      const parsed=JSON.parse(execFileSync("python3.12",["-c",`
import base64,io,json,pathlib,sys,tempfile
from types import SimpleNamespace
from unittest.mock import Mock
from sloptogether_worker.client import Lease,WorkerApi
from sloptogether_worker.models import WorkerJob
payload=json.load(sys.stdin)
job=WorkerJob.from_payload(payload['job'])
config=SimpleNamespace(api_base_url='https://www.clips.gg/sloptogether/api/v1',request_timeout_seconds=3,
                       worker_key=None,allowed_upload_hosts=(),local_s3_endpoint=None)
api=WorkerApi(config)
class Response:
    def __init__(self,data): self.data=data;self.headers={'Content-Length':str(len(data))}
    def __enter__(self): self.buffer=io.BytesIO(self.data);return self
    def __exit__(self,*args): return None
    def read(self,size): return self.buffer.read(size)
with tempfile.TemporaryDirectory() as folder:
    for index,part in enumerate(payload['grants']):
        data=base64.b64decode(part['frame'])
        api._request=Mock(return_value=(part['grant'],{}))
        api.media_opener=SimpleNamespace(open=Mock(return_value=Response(data)))
        path=str(pathlib.Path(folder)/f'frame-{index}.png')
        api.download_asset(Lease(job.lease_id,job.fence,{}),part['assetId'],path,1024)
        assert pathlib.Path(path).read_bytes()==data
        request=api.media_opener.open.call_args.args[0]
        assert request.get_header('X-worker-artifact-ticket')==part['grant']['ticket']
        assert request.get_header('Authorization') is None
print(json.dumps({'start':job.start_frame_asset_id,'end':job.end_frame_asset_id,'frames':job.frame_count}))
`],{input:JSON.stringify({job:lease.job,grants:granted}),encoding:"utf8",env:{...process.env,PYTHONPATH:resolve(process.cwd(),"../../workers/runtime/src")}}));
      expect(parsed).toEqual({start:assetFor(boundaries[0]!),end:assetFor(boundaries[1]!),frames:362});
      // A second click adds another four; only its first approved candidate unlocks prior #4.
      asOwner();
      const second=await createStoryBatch(channelId,ownerRequest(randomUUID()));
      asWorker();
      for(let position=0;position<4;position++){
        const next=await claim();
        if(!("leaseId" in next)||!next.leaseId)throw new Error("next_batch_claim_missing");
        await submitStoryProposal(channelId,workerRequest("channels/test/streams/main/story-proposals",{
          leaseId:next.leaseId,fence:next.fence,sequence:next.sequence,idempotencyKey:next.idempotencyKey,
          claimToken:next.claimToken,plan:scene,compiledH3Prompt:compileH3StoryPrompt(scene),
          plannerUsage:{provider:"template",inputTokens:0,outputTokens:0},
        }));
      }
      const nextItems=await database!.query<{id:string;position:number}>("SELECT id,position FROM sloptogether.story_batch_items WHERE batch_id=$1 ORDER BY position",[second.batchId]);
      const nextItem=nextItems.rows[0]!;
      asOwner();
      await approveStoryCandidate(channelId,nextItem.id,approveRequest(boundaries[4]!,1));
      const acrossBatches=await listStoryBatches(channelId,readRequest());
      const lastEnd=(await database!.query<{asset_id:string}>("SELECT asset_id FROM sloptogether.boundary_revisions WHERE id=$1",[boundaries[4]])).rows[0]!.asset_id;
      expect(acrossBatches.batches.find(batch=>batch.batchId===batchId)?.items[3]).toMatchObject({candidateApproved:true,endFrameUrl:`/sloptogether/api/v1/media/${lastEnd}/preview`});
      asWorker();
      await claim();
      const fourth=await database!.query<{job_id:string|null}>("SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position=3",[batchId]);
      expect(fourth.rows[0]?.job_id).not.toBeNull();
      const total=await database!.query<{count:string}>("SELECT count(*)::text AS count FROM sloptogether.jobs WHERE twitch_channel_id=$1",[channelId]);
      expect(total.rows[0]?.count).toBe("4");
      // An expired never-claimed job keeps its approved candidate; its unused
      // reservation is released only when a compatible worker next polls.
      const oldFourth=(await database!.query<{id:string;funding_id:string;segment_id:string;revision_id:string}>("SELECT j.id,j.funding_id,i.segment_id,j.segment_revision_id AS revision_id FROM sloptogether.story_batch_items i JOIN sloptogether.jobs j ON j.id=i.job_id WHERE i.batch_id=$1 AND i.position=3",[batchId])).rows[0]!;
      await database!.query("UPDATE sloptogether.jobs SET result_deadline_at=now()-interval '1 second' WHERE id=$1",[oldFourth.id]);
      await database!.query("UPDATE sloptogether.job_attempts SET attempt_deadline_at=now()-interval '1 second' WHERE job_id=$1",[oldFourth.id]);
      await claim(); // idle producer cannot recycle a job
      let oldState=await database!.query<{state:string}>("SELECT state FROM sloptogether.jobs WHERE id=$1",[oldFourth.id]);
      expect(oldState.rows[0]?.state).toBe("ready");
      const assertNotRecovered=async()=>{
        const current=await database!.query<{job_state:string;funding_state:string;item_state:string}>(`SELECT j.state AS job_state,f.state AS funding_state,i.state AS item_state
          FROM sloptogether.story_batch_items i JOIN sloptogether.jobs j ON j.id=i.job_id
          JOIN sloptogether.funding_authorizations f ON f.id=j.funding_id WHERE i.batch_id=$1 AND i.position=3`,[batchId]);
        expect(current.rows[0]).toMatchObject({job_state:"ready",funding_state:"reserved",item_state:"scheduled"});
      };
      await expect(claimWorkerLease(workerRequest("workers/leases?role=generation",{supportedRecipes:[]}))).resolves.toEqual({status:"empty"});
      await assertNotRecovered();
      await database!.query("UPDATE sloptogether.trusted_executions SET recipe_ids=ARRAY['other-recipe'] WHERE twitch_channel_id=$1 AND execution_role='generation'",[channelId]);
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      await assertNotRecovered();
      await database!.query("UPDATE sloptogether.trusted_executions SET recipe_ids=ARRAY[]::text[] WHERE twitch_channel_id=$1 AND execution_role='generation'",[channelId]);
      await database!.query(`UPDATE sloptogether.job_attempts SET state='leased',lease_expires_at=now()+interval '1 hour',
        attempt_deadline_at=now()+interval '1 hour',execution_binding_id=(SELECT id FROM sloptogether.trusted_executions
          WHERE twitch_channel_id=$2 AND execution_role='generation' LIMIT 1)
        WHERE job_id=(SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position=1)`,[batchId,channelId]);
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      await assertNotRecovered();
      await database!.query(`UPDATE sloptogether.job_attempts SET state='ready',lease_expires_at=NULL,execution_binding_id=NULL
        WHERE job_id=(SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position=1)`,[batchId]);
      // Keep unrelated synthetic ready jobs from being claimed while testing
      // the expired candidate's funding and override safeguards.
      await database!.query("UPDATE sloptogether.jobs SET state='cancelled' WHERE id IN (SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position IN (1,2))",[batchId]);
      for(const [consumed,cost] of [[true,0],[false,0.01]] as const){
        await database!.query("UPDATE sloptogether.funding_authorizations SET consumed_at=CASE WHEN $2 THEN now() ELSE NULL END,actual_cost_usd=$3 WHERE id=$1",[oldFourth.funding_id,consumed,cost]);
        await expect(workerPoll()).resolves.toEqual({status:"empty"});
        await assertNotRecovered();
      }
      await database!.query("UPDATE sloptogether.funding_authorizations SET consumed_at=NULL,actual_cost_usd=NULL WHERE id=$1",[oldFourth.funding_id]);
      const otherUser=(BigInt(channelId)+1000n).toString(),otherKeyId=randomUUID();
      const otherCredential=`slw_${otherKeyId}.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-`;
      await database!.query(`INSERT INTO sloptogether.application_keys(key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles)
        VALUES($1,$2,$3,$4,$5,'Other local worker',ARRAY['worker:generation'],ARRAY['generation'])`,[otherKeyId,hashWorkerSecret(otherCredential),`slw_${otherKeyId}`,otherUser,channelId]);
      await database!.query(`INSERT INTO sloptogether.trusted_executions(twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,policy_revision)
        SELECT $1,$2,$3,'generation',policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1`,[channelId,otherKeyId,otherUser]);
      const otherPoll=()=>new Request("http://127.0.0.1:3000/sloptogether/api/v1/workers/leases?role=generation",{method:"POST",
        headers:{Authorization:`SlopWorker ${otherCredential}`,"Content-Type":"application/json"},
        body:JSON.stringify({supportedRecipes:["fast-h3-trim-5step-vsa20-b1"]})});
      const ban=async(user:string)=>database!.query<{id:string}>("INSERT INTO sloptogether.bans(twitch_user_id,twitch_channel_id,scope,issued_by) VALUES($1,$2,'channel',$2) RETURNING id",[user,channelId]);
      for(const user of [otherUser,channelId]){
        const created=await ban(user);
        await expect(claimWorkerLease(otherPoll())).resolves.toEqual({status:"empty"});
        await assertNotRecovered();
        await database!.query("UPDATE sloptogether.bans SET revoked_at=now() WHERE id=$1",[created.rows[0]!.id]);
      }
      const override=randomUUID();
      await database!.query(`INSERT INTO sloptogether.segment_revisions(id,segment_id,revision,prompt,start_boundary_revision_id,requested_end_boundary_revision_id,
        planning_mode,provider_recipe_id,input_sha256,requested_by,state)
        SELECT $1,segment_id,revision+1,'Streamer override',start_boundary_revision_id,requested_end_boundary_revision_id,
          planning_mode,provider_recipe_id,input_sha256,requested_by,'locked' FROM sloptogether.segment_revisions WHERE id=$2`,[override,oldFourth.revision_id]);
      await database!.query("UPDATE sloptogether.segments SET selected_revision_id=$2 WHERE id=$1",[oldFourth.segment_id,override]);
      await expect(workerPoll()).resolves.toEqual({status:"empty"});
      await assertNotRecovered();
      await database!.query("UPDATE sloptogether.segments SET selected_revision_id=$2 WHERE id=$1",[oldFourth.segment_id,oldFourth.revision_id]);
      await database!.query("UPDATE sloptogether.jobs SET state='ready' WHERE id IN (SELECT job_id FROM sloptogether.story_batch_items WHERE batch_id=$1 AND position IN (1,2))",[batchId]);
      await workerPoll();
      oldState=await database!.query<{state:string}>("SELECT state FROM sloptogether.jobs WHERE id=$1",[oldFourth.id]);
      expect(oldState.rows[0]?.state).toBe("expired");
      const afterExpiry=await database!.query<{state:string;approved:boolean;funding:string}>(`SELECT i.state,(i.approved_at IS NOT NULL) AS approved,f.state AS funding
        FROM sloptogether.story_batch_items i JOIN sloptogether.funding_authorizations f ON f.id=$3 WHERE i.batch_id=$1 AND i.position=$2`,[batchId,3,oldFourth.funding_id]);
      expect(afterExpiry.rows[0]).toEqual({state:"planned",approved:true,funding:"released"});
      // Moderators can reject and replan an unapproved candidate idempotently;
      // this neither consumes a render nor authorizes an adjacent job.
      asOwner();
      const rejected=nextItems.rows[3]!;
      await expect(rejectStoryCandidate(channelId,rejected.id,decisionRequest({expectedCandidateRevision:1,reason:"not suitable"}))).resolves.toMatchObject({rejected:true,candidateRevision:2});
      const rejectionView=await listStoryBatches(channelId,readRequest());
      expect(rejectionView.batches.find(batch=>batch.batchId===second.batchId)?.items[3]).toMatchObject({candidateRejected:true,canReplan:true,canApprove:false});
      const redoId=randomUUID();
      await expect(replanStoryCandidate(channelId,rejected.id,decisionRequest({expectedCandidateRevision:2,requestId:redoId}))).resolves.toMatchObject({state:"pending"});
      await expect(replanStoryCandidate(channelId,rejected.id,decisionRequest({expectedCandidateRevision:2,requestId:redoId}))).resolves.toMatchObject({state:"pending"});
      asWorker();
      await database!.query("UPDATE sloptogether.job_attempts SET attempt_deadline_at=now()-interval '1 second',lease_expires_at=now()-interval '1 second' WHERE job_id=$1",[originalItem.job_id]);
      await workerPoll();
      const spent=await database!.query<{item_state:string;job_state:string;funding_state:string}>(`SELECT i.state AS item_state,j.state AS job_state,f.state AS funding_state
        FROM sloptogether.story_batch_items i JOIN sloptogether.jobs j ON j.id=i.job_id
        JOIN sloptogether.funding_authorizations f ON f.id=j.funding_id WHERE i.batch_id=$1 AND i.position=0`,[batchId]);
      expect(spent.rows[0]).toMatchObject({item_state:"scheduled",job_state:"failed",funding_state:"consumed_failed"});
    } finally {sessionSpy?.mockRestore();}
  },30_000);
});
