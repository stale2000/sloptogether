import { NextRequest,NextResponse } from "next/server";
import { ApiError,assertSameOrigin,readJson } from "@/lib/server/http";
import { requestPrincipal } from "@/lib/server/principals";
import { findChannel,listPublicChannels } from "@/lib/server/channels";
import { sessionOverview,publicChannel,createOwnedChannel,readChannelSettings,updateChannelSettings,listReviewQueue,decideReview,decideArtifactReview,resolveReviewInput,resolveGeneratedEndpointInput,issueWorkerKey,listWorkerKeys,revokeWorkerKey,reaffirmWorkerTrust } from "@/lib/server/channel-service";
import { getPublicTimeline } from "@/lib/server/timeline";
import { castBallot } from "@/lib/server/voting-service";
import { getProgramManifest, getProgramPlaylist, heartbeatPlayback,claimPlaybackController } from "@/lib/server/program-service";
import { submitProposal } from "@/lib/server/proposal-service";
import { applyStreamerOverride,listOverrideCandidates,listActiveBans,createChannelBan,revokeChannelBan } from "@/lib/server/override-service";
import { issueAssetUpload,completeAssetUpload,getApprovedMediaAsset,authorizeUploadGateway } from "@/lib/server/upload-service";
import { handleSubscriberSettings,getExtensionState,handleEventSubWebhook,registerExtensionBitsEventSub } from "@/lib/server/subscriber-service";
import { getExtensionBitsState,createExtensionBitsIntent,getExtensionPromptLockState,getExtensionBitsEventSubTestState,createExtensionPromptLockIntent,recordExtensionBitsReceipt,cancelExtensionBitsIntent,getExtensionBitsIntentStatus,requestBitsReceiptReconciliation,reconcilePaidBitsReceipt } from "@/lib/server/paid-bits-service";
import { cancelComfyGeneration,createComfyFrameGeneration,createComfyPromptGeneration,getComfyFrameGenerationImage,getComfyGeneration,getComfyPromptGenerationText,listComfyGenerations } from "@/lib/server/comfy-frame-service";
import { listWindowsWorkerRelease,recordWorkerProviderRequest,claimStoryProducer,submitStoryProposal,downloadWorkerAsset,failWorkerLease,requestClipUpscale } from "@/lib/server/worker-service";
import { jsonError,jsonOk } from "@/lib/server/http";
import { createStream,getStream,listStreams } from "@/lib/server/stream-service";
import { createStoryBatch,listStoryBatches } from "@/lib/server/story-batch-service";
import { approveStoryCandidate,listStoryCandidateFrames,rejectStoryCandidate,replanStoryCandidate,retryStoryCandidateScreen } from "@/lib/server/story-candidate-service";
import { addStreamSeedFrame } from "@/lib/server/stream-seed-frame-service";
import { submitOwnerCandidate } from "@/lib/server/owner-candidate-service";

type Context={params:Promise<{path:string[]}>};

async function dispatch(request:NextRequest,path:string[]){
  const method=request.method.toUpperCase();const p=path;
  if(p.join("/")==="webhooks/eventsub"&&method==="POST")return handleEventSubWebhook(request);
  if(p.join("/")==="health"&&method==="GET")return jsonOk({service:"sloptogether",status:"online"});
  if(p.join("/")==="auth/session"&&method==="GET")return jsonOk(await sessionOverview(request));
  if(p.join("/")==="auth/logout"&&method==="POST"){
    assertSameOrigin(request);
    const {revokeRequestSession}=await import("@/lib/server/session");
    await revokeRequestSession(request);
    return jsonOk({signedOut:true});
  }
  if(p.join("/")==="channels"&&method==="GET")return jsonOk(await listPublicChannels());
  if(p.join("/")==="channels"&&method==="POST")return jsonOk(await createOwnedChannel(request),{status:201});
  if(p.join("/")==="extension/state"&&method==="GET")return jsonOk(await getExtensionState(request));
  if(p.join("/")==="extension/bits/state"&&method==="GET")return jsonOk(await getExtensionBitsState(request));
  if(p.join("/")==="extension/bits/intents"&&method==="POST")return jsonOk(await createExtensionBitsIntent(request),{status:201});
  if(p.join("/")==="extension/bits/prompt-lock/state"&&method==="GET")return jsonOk(await getExtensionPromptLockState(request));
  if(p.join("/")==="extension/bits/eventsub-test/state"&&method==="GET")return jsonOk(await getExtensionBitsEventSubTestState(request));
  if(p.join("/")==="extension/bits/prompt-lock/intents"&&method==="POST")return jsonOk(await createExtensionPromptLockIntent(request),{status:201});
  if(p.join("/")==="extension/bits/receipt"&&method==="POST")return jsonOk(await recordExtensionBitsReceipt(request));
  if(p[0]==="extension"&&p[1]==="bits"&&p[2]==="intents"&&p[3]&&p.length===4&&method==="GET")return jsonOk(await getExtensionBitsIntentStatus(p[3]!,request));
  if(p[0]==="extension"&&p[1]==="bits"&&p[2]==="intents"&&p[3]&&p[4]==="reconcile"&&p.length===5&&method==="POST")return jsonOk(await requestBitsReceiptReconciliation(p[3]!,request));
  if(p[0]==="extension"&&p[1]==="bits"&&p[2]==="intents"&&p[3]&&p[4]==="cancel"&&p.length===5&&method==="POST")return jsonOk(await cancelExtensionBitsIntent(p[3]!,request));
  if(p.join("/")==="worker/releases/windows"&&method==="GET"){
    return jsonOk(await listWindowsWorkerRelease());
  }

  if(p[0]==="channels"&&p.length>=2){
    const locator=p[1]!;
    if(p.length===2&&method==="GET")return jsonOk(await publicChannel(locator));
    if(p[2]==="streams"&&p.length===3&&method==="GET")return jsonOk(await listStreams(locator));
    if(p[2]==="streams"&&p.length===3&&method==="POST")return jsonOk(await createStream(locator,request),{status:201});
    if(p[2]==="streams"&&p[3]&&p.length>=5){
      const channel=await findChannel(locator);const stream=await getStream(channel.twitch_channel_id,p[3]!);
      if(p[4]==="timeline"&&p.length===5&&method==="GET"){
        const timeline=await getPublicTimeline(channel,await requestPrincipal(request),stream.id);
        return jsonOk({...timeline,activeElection:timeline.elections[0]??null,subscriberInterrupts:await import("@/lib/server/subscriber-service").then(m=>m.getPublicSubscriberState(channel.twitch_channel_id))});
      }
      if(p[4]==="program"&&p.length===5&&method==="GET")return jsonOk(await getProgramManifest(locator,stream.slug));
      if(p[4]==="program"&&p[5]==="playlist.m3u8"&&p.length===6&&method==="GET"){
        const epochRaw=new URL(request.url).searchParams.get("epoch");const epoch=epochRaw===null?undefined:Number(epochRaw);
        if(epochRaw!==null&&(!Number.isSafeInteger(epoch)||epoch!<1))throw new ApiError(400,"program_epoch_invalid");
        const result=await getProgramPlaylist(locator,epoch,stream.slug);
        return new NextResponse(result.body,{status:200,headers:{"Content-Type":"application/vnd.apple.mpegurl","Cache-Control":"no-store, no-cache, must-revalidate","Access-Control-Allow-Origin":"*","X-Content-Type-Options":"nosniff"}});
      }
      if(p[4]==="proposals"&&p.length===5&&method==="POST")return jsonOk(await submitProposal(locator,request,stream.id),{status:201});
      if(p[4]==="story-proposals"&&p.length===5&&method==="POST")return jsonOk(await submitStoryProposal(locator,request,stream.slug),{status:201});
      if(p[4]==="story-batches"&&p.length===5&&method==="POST")return jsonOk(await createStoryBatch(locator,request,stream.slug),{status:201});
      if(p[4]==="story-batches"&&p.length===5&&method==="GET")return jsonOk(await listStoryBatches(locator,request,stream.slug));
      if(p[4]==="upscale"&&p.length===5&&method==="POST")return jsonOk(await requestClipUpscale(locator,request,stream.slug),{status:202});
      if(p[4]==="story-candidates"&&p[5]==="frames"&&p.length===6&&method==="GET")return jsonOk(await listStoryCandidateFrames(locator,request,stream.slug));
      if(p[4]==="story-candidates"&&p[5]==="frames"&&p.length===6&&method==="POST")return jsonOk(await addStreamSeedFrame(locator,request,stream.slug),{status:201});
      if(p[4]==="story-candidates"&&p[5]&&p[6]==="approve"&&p.length===7&&method==="POST")return jsonOk(await approveStoryCandidate(locator,p[5]!,request,stream.slug));
      if(p[4]==="story-candidates"&&p[5]&&p[6]==="owner-submit"&&p.length===7&&method==="POST")return jsonOk(await submitOwnerCandidate(locator,p[5]!,request,stream.slug));
      if(p[4]==="story-candidates"&&p[5]&&p[6]==="reject"&&p.length===7&&method==="POST")return jsonOk(await rejectStoryCandidate(locator,p[5]!,request,stream.slug));
      if(p[4]==="story-candidates"&&p[5]&&p[6]==="replan"&&p.length===7&&method==="POST")return jsonOk(await replanStoryCandidate(locator,p[5]!,request,stream.slug));
      if(p[4]==="story-candidates"&&p[5]&&p[6]==="retry-screen"&&p.length===7&&method==="POST")return jsonOk(await retryStoryCandidateScreen(locator,p[5]!,request,stream.slug));
      if(p[4]==="elections"&&p[5]&&p[6]==="ballots"&&p.length===7&&method==="POST"){
        const principal=await requestPrincipal(request);if(!principal)throw new ApiError(401,"login_required");
        const parsed=await readJson(request,await import("@sloptogether/contracts").then(x=>x.voteRequestSchema));
        return jsonOk(await castBallot(p[5]!,parsed.choiceId,principal,principal.kind==="extension"?"extension":"website",undefined,stream.id));
      }
      if(p[4]==="playback"&&p[5]==="controller"&&p.length===6&&method==="POST")return jsonOk(await claimPlaybackController(locator,request,stream.slug));
      if(p[4]==="playback"&&p[5]==="position"&&p.length===6&&method==="POST")return jsonOk(await heartbeatPlayback(locator,request,stream.slug));
      if(p[4]==="moderation"&&p[5]==="queue"&&p.length===6&&method==="GET")return jsonOk(await listReviewQueue(locator,request,stream.id));
      if(p[4]==="story-producer"&&p[5]==="leases"&&p.length===6&&method==="POST")return jsonOk(await claimStoryProducer(locator,request,stream.slug));
    }
    if(p[2]==="timeline"&&p.length===3&&method==="GET"){
      const channel=await findChannel(locator);const timeline=await getPublicTimeline(channel,await requestPrincipal(request));
      return jsonOk({...timeline,activeElection:timeline.elections[0]??null,subscriberInterrupts:await import("@/lib/server/subscriber-service").then(m=>m.getPublicSubscriberState(channel.twitch_channel_id))});
    }
    if(p[2]==="program"&&p.length===3&&method==="GET")return jsonOk(await getProgramManifest(locator));
    if(p[2]==="program"&&p[3]==="playlist.m3u8"&&method==="GET"){
      const epochRaw=new URL(request.url).searchParams.get("epoch");
      const epoch=epochRaw===null?undefined:Number(epochRaw);
      if(epochRaw!==null&&(!Number.isSafeInteger(epoch)||epoch!<1))throw new ApiError(400,"program_epoch_invalid");
      const result=await getProgramPlaylist(locator,epoch);
      return new NextResponse(result.body,{status:200,headers:{"Content-Type":"application/vnd.apple.mpegurl","Cache-Control":"no-store, no-cache, must-revalidate","Access-Control-Allow-Origin":"*","X-Content-Type-Options":"nosniff"}});
    }
    if(p[2]==="settings"&&p.length===3&&method==="GET")return jsonOk(await readChannelSettings(locator,request));
    if(p[2]==="settings"&&p.length===3&&method==="PATCH")return jsonOk(await updateChannelSettings(locator,request));
    if(p[2]==="bits-eventsub"&&p.length===3&&method==="POST")return jsonOk(await registerExtensionBitsEventSub(locator,request));
    if(p[2]==="worker-keys"&&p.length===3&&method==="POST")return jsonOk(await issueWorkerKey(locator,request),{status:201});
    if(p[2]==="worker-keys"&&p.length===3&&method==="GET")return jsonOk(await listWorkerKeys(locator,request));
    if(p[2]==="worker-keys"&&p[3]&&p[4]==="revoke"&&p.length===5&&method==="POST")return jsonOk(await revokeWorkerKey(locator,p[3]!,request));
    if(p[2]==="worker-keys"&&p[3]&&p[4]==="reaffirm-trust"&&p.length===5&&method==="POST")return jsonOk(await reaffirmWorkerTrust(locator,p[3]!,request));
    if(p[2]==="proposals"&&p.length===3&&method==="POST")return jsonOk(await submitProposal(locator,request),{status:201});
    if(p[2]==="assets"&&p[3]==="upload-ticket"&&method==="POST")return jsonOk(await issueAssetUpload(locator,request),{status:201});
    if(p[2]==="upload-grant"&&p.length===4&&method==="POST")return jsonOk(await issueAssetUpload(locator,request),{status:201});
    if(p[2]==="assets"&&p[3]==="upload-grant"&&method==="POST")return jsonOk(await issueAssetUpload(locator,request),{status:201});
    if(p[2]==="assets"&&p[3]==="moderate"&&p.length===4&&method==="GET")return jsonOk(await listReviewQueue(locator,request));
    if(p[2]==="moderation"&&p[3]==="queue"&&p.length===4&&method==="GET")return jsonOk(await listReviewQueue(locator,request));
    if(p[2]==="moderation"&&p[3]&&p[4]==="input-resolution"&&p.length===5&&method==="POST")return jsonOk(await resolveReviewInput(locator,p[3]!,request));
    if(p[2]==="moderation"&&p[3]==="endpoint-input"&&p[4]&&p.length===5&&method==="POST")return jsonOk(await resolveGeneratedEndpointInput(locator,p[4]!,request));
    if(p[2]==="moderation"&&p[3]==="assets"&&p[4]&&p.length===5&&method==="POST")return jsonOk(await decideArtifactReview(locator,p[4]!,request));
    if(p[2]==="moderation"&&p.length===4&&method==="POST")return jsonOk(await decideReview(locator,p[3]!,request));
    if(p[2]==="moderation"&&p[3]==="settings"&&method==="PUT")return jsonOk(await updateChannelSettings(locator,request));
    if(p[2]==="subscriber-interrupts"&&p.length===3&&method==="GET")return jsonOk(await handleSubscriberSettings(locator,request,"read"));
    if(p[2]==="subscriber-interrupts"&&p.length===3&&method==="PUT")return jsonOk(await handleSubscriberSettings(locator,request,"update"));
    if(p[2]==="timeline"&&p[3]==="overrides"&&p.length===4&&method==="POST")return jsonOk(await applyStreamerOverride(locator,request));
    if(p[2]==="timeline"&&p[3]==="override-candidates"&&p.length===4&&method==="GET")return jsonOk(await listOverrideCandidates(locator,request));
    if(p[2]==="playback"&&p[3]==="controller"&&p.length===4&&method==="POST")return jsonOk(await claimPlaybackController(locator,request));
    if(p[2]==="playback"&&p[3]==="position"&&p.length===4&&method==="POST")return jsonOk(await heartbeatPlayback(locator,request));
    if(p[2]==="story-producer"&&p[3]==="leases"&&p.length===4&&method==="POST")return jsonOk(await claimStoryProducer(locator,request));
    if(p[2]==="story-proposals"&&p.length===3&&method==="POST")return jsonOk(await submitStoryProposal(locator,request),{status:201});
    if(p[2]==="comfy-frame-generations"&&p.length===3&&method==="POST")return jsonOk(await createComfyFrameGeneration(locator,request),{status:202});
    if(p[2]==="comfy-prompt-generations"&&p.length===3&&method==="POST")return jsonOk(await createComfyPromptGeneration(locator,request),{status:202});
    if(p[2]==="comfy-generations"&&p.length===3&&method==="GET")return jsonOk(await listComfyGenerations(locator,request));
    if(p[2]==="comfy-generations"&&p[3]&&p[4]==="cancel"&&p.length===5&&method==="POST")return jsonOk(await cancelComfyGeneration(locator,p[3]!,request));
    if(p[2]==="comfy-generations"&&p[3]&&p.length===4&&method==="GET")return jsonOk(await getComfyGeneration(locator,p[3]!,request));
    if(p[2]==="comfy-generations"&&p[3]&&p[4]==="frame"&&p.length===5&&method==="GET"){
      const image=await getComfyFrameGenerationImage(locator,p[3]!,request);
      return new NextResponse(image.bytes,{status:200,headers:{"Content-Type":"image/png","Content-Length":String(image.bytes.length),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    if(p[2]==="comfy-generations"&&p[3]&&p[4]==="prompt"&&p.length===5&&method==="GET")return jsonOk(await getComfyPromptGenerationText(locator,p[3]!,request));
    if(p[2]==="upscale"&&p.length===3&&method==="POST")return jsonOk(await requestClipUpscale(locator,request),{status:202});
    if(p[2]==="bans"&&p.length===3&&method==="GET")return jsonOk(await listActiveBans(locator,request));
    if(p[2]==="bans"&&p.length===3&&method==="POST")return jsonOk(await createChannelBan(locator,request),{status:201});
    if(p[2]==="bans"&&p[3]&&p[4]==="revoke"&&p.length===5&&method==="POST")return jsonOk(await revokeChannelBan(locator,p[3]!,request));
    if(p[2]==="interrupts"&&p.length===3&&method==="GET")return jsonOk(await handleSubscriberSettings(locator,request,"read"));
    if(p[2]==="interrupts"&&p.length===3&&method==="POST")return jsonOk(await handleSubscriberSettings(locator,request,"update"));
  }

  if(p[0]==="elections"&&p[1]&&p[2]==="ballots"&&p.length===3&&method==="POST"){
    const principal=await requestPrincipal(request);
    if(!principal)throw new ApiError(401,"login_required");
    const parsed=await readJson(request,await import("@sloptogether/contracts").then(x=>x.voteRequestSchema));
    const surface=principal.kind==="extension"?"extension":"website";
    return jsonOk(await castBallot(p[1]!,parsed.choiceId,principal,surface));
  }

  if(p[0]==="uploads"&&p[1]&&p[2]==="complete"&&p.length===3&&method==="POST")return jsonOk(await completeAssetUpload(p[1]!,request));
  if(p.join("/")==="internal/bits/reconcile"&&method==="POST")return jsonOk(await reconcilePaidBitsReceipt(request));
  if(p[0]==="internal"&&p[1]==="uploads"&&p[2]&&p[3]==="authorize"&&p.length===4&&method==="POST")return jsonOk(await authorizeUploadGateway(p[2]!,request));
  if(p[0]==="channels"&&p[1]&&p[2]==="assets"&&p[3]&&p[4]==="complete"&&p.length===5&&method==="POST")return jsonOk(await completeAssetUpload(p[3]!,request));
  if(p[0]==="media"&&p[1]&&(p.length===2||(p.length===3&&p[2]==="preview"))&&method==="GET"){
    const result=await getApprovedMediaAsset(p[1]!,request);
    return NextResponse.redirect(result.url,302);
  }
  if(p[0]==="workers"&&p[1]==="pairings"&&p.length===2&&method==="POST")return jsonOk(await import("@/lib/server/worker-service").then(m=>m.createPairing(request)),{status:201});
  if(p[0]==="workers"&&p[1]==="pairings"&&p[2]&&p[3]==="approve"&&method==="POST")return jsonOk(await import("@/lib/server/worker-service").then(m=>m.approvePairing(p[2]!,request)));
  if(p[0]==="workers"&&p[1]==="pairings"&&p[2]&&p[3]==="poll"&&method==="POST")return jsonOk(await import("@/lib/server/worker-service").then(m=>m.pollPairing(p[2]!,request)));
  if(p[0]==="workers"&&p[1]==="sessions"&&p[2]==="exchange"&&method==="POST")return jsonOk(await import("@/lib/server/worker-service").then(m=>m.exchangeWorkerSession(request)));
  if(p[0]==="workers"&&p[1]==="leases"&&p.length===2&&method==="POST")return jsonOk(await import("@/lib/server/worker-service").then(m=>m.claimWorkerLease(request)));
  if(p[0]==="workers"&&p[1]==="leases"&&p[2]&&p[3]==="heartbeat"&&method==="POST")return jsonOk(await import("@/lib/server/worker-service").then(m=>m.heartbeatWorkerLease(p[2]!,request)));
  if(p[0]==="workers"&&p[1]==="leases"&&p[2]&&p[3]==="asset"&&p[4]&&p.length===5&&method==="GET"){
    const asset=await downloadWorkerAsset(p[2]!,p[4]!,request);
    return jsonOk(asset);
  }
  if(p[0]==="workers"&&p[1]==="leases"&&p[2]&&p[3]==="fail"&&p.length===4&&method==="POST")return jsonOk(await failWorkerLease(p[2]!,request));
  if(p[0]==="workers"&&p[1]==="leases"&&p[2]&&p[3]==="uploads"&&method==="POST")return jsonOk(await issueAssetUpload(p[2]!,request),{status:201});
  if(p[0]==="workers"&&p[1]==="leases"&&p[2]&&p[3]==="provider-request"&&method==="POST")return jsonOk(await recordWorkerProviderRequest(p[2]!,request));
  if(p[0]==="workers"&&p[1]==="uploads"&&p[2]&&p[3]==="complete"&&method==="POST")return jsonOk(await completeAssetUpload(p[2]!,request));
  if(p[0]==="channels"&&p[1]&&p[2]==="story-producer"&&p[3]==="leases"&&method==="POST")return jsonOk(await claimStoryProducer(p[1]!,request));
  throw new ApiError(404,"route_not_found");
}

function corsResponse(request:Request,response:Response){
  const origin=request.headers.get("origin");
  if(!origin)return response;
  const clientId=process.env.TWITCH_EXTENSION_CLIENT_ID;
  const allowed=(clientId&&origin==="https://"+clientId+".ext-twitch.tv")||origin==="https://www.twitch.tv";
  if(!allowed)return response;
  const headers=new Headers(response.headers);headers.set("Access-Control-Allow-Origin",origin);
  headers.set("Vary","Origin");headers.set("Access-Control-Allow-Methods","GET, POST, PATCH, PUT, OPTIONS");
  headers.set("Access-Control-Allow-Headers","Authorization, Content-Type, X-Extension-Jwt");headers.set("Access-Control-Max-Age","600");
  return new NextResponse(response.body,{status:response.status,headers});
}

async function handle(request:NextRequest,context:Context){
  let path:string[]=[];
  try{
    path=(await context.params).path;
    if(request.method==="OPTIONS")return corsResponse(request,new NextResponse(null,{status:204}));
    return corsResponse(request,await dispatch(request,path));
  }catch(error){
    if(path.join("/")==="webhooks/eventsub"&&error instanceof ApiError){
      console.warn(JSON.stringify({event:"eventsub_webhook_rejected",status:error.status,code:error.code}));
    }
    return corsResponse(request,jsonError(error));
  }
}

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=(request:NextRequest,context:Context)=>handle(request,context);
export const POST=(request:NextRequest,context:Context)=>handle(request,context);
export const PUT=(request:NextRequest,context:Context)=>handle(request,context);
export const PATCH=(request:NextRequest,context:Context)=>handle(request,context);
export const OPTIONS=(request:NextRequest,context:Context)=>handle(request,context);
