import { describe,expect,it } from "vitest";
import { jobInputSchema,storyProposalSchema,voteRequestSchema } from "@sloptogether/contracts";

const id="123e4567-e89b-42d3-a456-426614174000";

describe("shared worker and vote contracts",()=>{
  it("accepts a bounded generation job but rejects client supplied trust flags",()=>{
    const job={
      jobId:id,channelId:"123456",segmentRevisionId:id,stage:"generation",executionMode:"pull_worker",
      recipeId:"fast-h3-trim-5step-vsa20-b1",recipeSha256:"a".repeat(64),inputSha256:"b".repeat(64),
      prompt:"A tiny cartoon ship flies through the clouds.",startFrameAssetId:id,requestedEndBoundaryRevisionId:id,
      endpointResolutionId:null,width:448,height:256,outputWidth:1280,outputHeight:720,fpsNum:24,fpsDen:1,frameCount:362,attemptId:id,
      fence:1,attemptDeadlineAt:"2026-10-23T12:00:00.000Z",
    };
    expect(jobInputSchema.safeParse(job).success).toBe(true);
    expect(jobInputSchema.safeParse({...job,trusted:true}).success).toBe(false);
  });

  it("accepts one linked-voter choice and rejects extra authority fields",()=>{
    expect(voteRequestSchema.safeParse({choiceId:id}).success).toBe(true);
    expect(voteRequestSchema.safeParse({choiceId:id,channelId:"999"}).success).toBe(false);
  });

  it("requires the current story-plan claim token for append submissions",()=>{
    const proposal={
      leaseId:id,fence:1,sequence:1,idempotencyKey:id,
      plan:{visualAction:"A tiny fox waves beside a glowing map.",camera:"One continuous wide shot.",speakerId:"S1",
        speakerCharacter:"a cartoon fox",voiceDescription:"a curious warm voice",dialogue:"Hello, stars!",soundscape:"Soft forest chimes.",music:"none"},
      compiledH3Prompt:"A canonical H3 prompt.",
    };
    expect(storyProposalSchema.safeParse(proposal).success).toBe(false);
    expect(storyProposalSchema.safeParse({...proposal,claimToken:id}).success).toBe(true);
    expect(storyProposalSchema.safeParse({...proposal,claimToken:id,platform:"linux"}).success).toBe(false);
  });
});
