import { z } from "zod";

export const channelSlugSchema = z.string().min(1).max(25).regex(/^[a-z0-9_]+$/);
export const uuidSchema = z.string().uuid();

export const contributionModeSchema = z.enum([
  "any_non_banned_twitch_user",
  "broadcaster_and_moderators",
  "explicit_allowlist",
  "combined",
]);

export const workerStageSchema = z.enum([
  "story_plan",
  "generation",
  "upscale",
]);

const h3PlanFieldsSchema = z.object({
  visualAction: z.string().trim().min(1).max(1200),
  camera: z.string().trim().min(1).max(320),
  speakerId: z.string().regex(/^S[1-9][0-9]?$/),
  speakerCharacter: z.string().trim().min(1).max(120),
  voiceDescription: z.string().trim().min(1).max(180),
  dialogue: z.string().trim().min(1).max(360),
  soundscape: z.string().max(320),
  music: z.enum(["none", "channel_approved"]),
}).strict();

export const h3PlanSchema = h3PlanFieldsSchema.extend({
  kind: z.enum(["story", "subscriber_interrupt"]),
  durationSeconds: z.number().int().min(5).max(15),
  subscriberLabel: z.string().max(32).optional(),
}).strict().superRefine((plan,context)=>{
  if(plan.kind==="subscriber_interrupt"&&plan.durationSeconds!==10){
    context.addIssue({code:"custom",path:["durationSeconds"],message:"Subscriber interrupt clips must be 10 seconds."});
  }
});

export const h3StoryPromptPlanSchema = h3PlanFieldsSchema;
export type H3StoryPromptPlan = z.infer<typeof h3StoryPromptPlanSchema>;

export function compileH3StoryPrompt(plan:H3StoryPromptPlan):string{
  const dialogue=plan.dialogue.endsWith(".")||plan.dialogue.endsWith("?")||plan.dialogue.endsWith("!")?plan.dialogue:plan.dialogue+".";
  return `integrated_multimodal_description: [Shot 1] ${plan.visualAction} Camera: ${plan.camera} At the beginning of this shot, ${plan.speakerCharacter} (${plan.speakerId}), ${plan.voiceDescription}, says: <d>[English] ${dialogue}</d> Their mouth movements follow these exact words.\n\noverall_soundscape: ${plan.soundscape} Everyone stays silent after the single line.\n\nnon_diegetic_music: N/A`;
}

export const proposalRequestSchema = z.object({
  segmentId: uuidSchema.optional(),
  prompt: z.string().trim().min(1).max(1000),
  imageAssetId: uuidSchema.optional(),
  endFrameAssetId: uuidSchema.optional(),
  planningMode: z.enum(["planned_anchors", "continuation"]),
  boundaryRevisionId: uuidSchema.optional(),
}).strict();

export const voteRequestSchema = z.object({
  choiceId: uuidSchema,
}).strict();

export const storyProposalSchema = z.object({
  leaseId: uuidSchema,
  fence: z.number().int().positive(),
  sequence: z.number().int().positive(),
  idempotencyKey: uuidSchema,
  claimToken: uuidSchema,
  interruptId: uuidSchema.optional(),
  plan: h3StoryPromptPlanSchema,
  compiledH3Prompt: z.string().min(1).max(12_000),
  plannerUsage: z.record(z.string(),z.unknown()).optional(),
}).strict();

export const streamerOverrideSchema = z.object({
  timelineRevision: z.number().int().positive(),
  segmentRevisionId: uuidSchema.optional(),
  targetSegmentId: uuidSchema.optional(),
  action: z.enum([
    "select_proposal",
    "replace_future_prompt",
    "replace_future_boundary",
    "unlock_future",
    "hold",
    "resume",
    "approve_asset",
    "reject_asset",
    "skip_program_item",
    "seek_program_item",
  ]),
  reason: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(1200).optional(),
  boundaryRevisionId: uuidSchema.optional(),
  proposalId: uuidSchema.optional(),
  assetId: uuidSchema.optional(),
  itemId: uuidSchema.optional(),
  offsetSeconds: z.number().min(0).max(900).optional(),
  idempotencyKey: uuidSchema,
}).strict();

export const interruptSettingsSchema = z.object({
  enabled: z.boolean(),
  newSubscriptions: z.boolean(),
  resubscriptionMessages: z.boolean(),
  giftMode: z.enum(["off", "gifter_batch", "recipient_each"]),
  minimumGapSeconds: z.number().int().min(0).max(3600),
  eventMaxAgeSeconds: z.number().int().min(15).max(3600),
  hourlySpendCapUsd: z.number().min(0).max(500),
  fallback: z.literal("skip"),
}).strict();

export const workerKeyScopes = [
  "worker:generation",
  "worker:upscale",
  "story:write_future",
  "artifact:system_approve",
  "streamer:control",
] as const;
export type WorkerKeyScope = (typeof workerKeyScopes)[number];

export const jobInputSchema = z.object({
  jobId: uuidSchema,
  channelId: z.string().min(1).max(32),
  segmentRevisionId: uuidSchema,
  stage: workerStageSchema,
  kind: z.enum(["story", "subscriber_interrupt"]).nullable().optional(),
  requireAudio: z.boolean().optional(),
  executionMode: z.enum(["pull_worker", "provider_queue"]),
  recipeId: z.string().min(1).max(128),
  recipeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt: z.string().min(1).max(12000),
  startFrameAssetId: uuidSchema.nullable(),
  requestedEndBoundaryRevisionId: uuidSchema.nullable(),
  endFrameAssetId: uuidSchema.nullable().optional(),
  endpointResolutionId: uuidSchema.nullable(),
  sourceAssetId: uuidSchema.nullable().optional(),
  width: z.number().int().min(64).max(3840),
  height: z.number().int().min(64).max(2160),
  outputWidth: z.number().int().min(64).max(3840),
  outputHeight: z.number().int().min(64).max(2160),
  fpsNum: z.number().int().min(1).max(120),
  fpsDen: z.number().int().min(1).max(1001),
  frameCount: z.number().int().min(5).max(5000),
  attemptId: uuidSchema,
  fence: z.number().int().positive(),
  attemptDeadlineAt: z.string().datetime(),
}).strict().superRefine((value,context)=>{
  if(value.outputWidth*9!==value.outputHeight*16)context.addIssue({code:"custom",path:["outputWidth"],message:"Published media must be 16:9."});
});

export type ContributionMode = z.infer<typeof contributionModeSchema>;
export type H3Plan = z.infer<typeof h3PlanSchema>;
export type StoryProposal = z.infer<typeof storyProposalSchema>;
export type StreamerOverride = z.infer<typeof streamerOverrideSchema>;
export type InterruptSettings = z.infer<typeof interruptSettingsSchema>;
export type JobInput = z.infer<typeof jobInputSchema>;

export interface PublicTimelineSegment {
  id: string;
  ordinal: number;
  promptPreview: string;
  durationSeconds: number | null;
  state: "open" | "voting" | "selected" | "locked" | "ready" | "played";
  mediaUrl?: string;
  startPreviewUrl?: string;
  voteCount: number;
  kind: "story" | "subscriber_interrupt";
}

export interface PublicChannelSummary {
  twitchLogin: string;
  displayName: string;
  currentlyLive: boolean;
  currentProgramItemId: string | null;
  currentOffsetSeconds: number;
  segments: PublicTimelineSegment[];
}

export interface ProgramItem {
  id: string;
  kind: "story" | "subscriber_interrupt";
  assetUrl: string;
  durationSeconds: number;
  programEpoch?: number;
  itemOrder?: number;
}

export interface ElectionChoice {
  id: string;
  title: string;
  thumbnailUrl?: string;
  votes: number;
}
