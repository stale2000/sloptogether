-- SlopTogether database. Deploy this schema to a dedicated Supabase project.
-- No public REST schema or anonymous table grants are required: the Next
-- server uses its private DATABASE_URL, never a browser service credential.
BEGIN;

CREATE SCHEMA IF NOT EXISTS sloptogether;
REVOKE ALL ON SCHEMA sloptogether FROM PUBLIC;

CREATE TABLE sloptogether.channels (
  twitch_channel_id text PRIMARY KEY,
  owner_twitch_user_id text NOT NULL,
  twitch_login text NOT NULL,
  display_name text NOT NULL,
  story_world_prompt text NOT NULL DEFAULT 'A playful, safe live animated story. Keep one clear visual action per short clip.',
  h3_style_profile text NOT NULL DEFAULT 'trim-5step-review-required',
  output_width integer NOT NULL DEFAULT 1280 CHECK (output_width > 0 AND output_width % 2 = 0),
  output_height integer NOT NULL DEFAULT 720 CHECK (output_height > 0 AND output_height % 2 = 0),
  output_fps_num integer NOT NULL DEFAULT 24 CHECK (output_fps_num > 0),
  output_fps_den integer NOT NULL DEFAULT 1 CHECK (output_fps_den > 0),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  is_enabled boolean NOT NULL DEFAULT true,
  policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  contribution_mode text NOT NULL DEFAULT 'any_non_banned_twitch_user'
    CHECK (contribution_mode IN ('any_non_banned_twitch_user','broadcaster_and_moderators','explicit_allowlist','combined')),
  contributor_whitelist text[] NOT NULL DEFAULT '{}',
  reviewer_whitelist text[] NOT NULL DEFAULT '{}',
  upload_approval_bypass_ids text[] NOT NULL DEFAULT '{}',
  role_based_upload_bypass text[] NOT NULL DEFAULT '{}'
    CHECK (role_based_upload_bypass <@ ARRAY['broadcaster','moderator']::text[]),
  subscriber_interrupt_policy jsonb NOT NULL DEFAULT '{"enabled":false,"newSubscriptions":true,"resubscriptionMessages":false,"giftMode":"off","minimumGapSeconds":60,"eventMaxAgeSeconds":180,"hourlySpendCapUsd":0,"fallback":"skip"}'::jsonb,
  owner_budget_cap_usd numeric(12,4) NOT NULL DEFAULT 0 CHECK (owner_budget_cap_usd >= 0),
  layout_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twitch_login),
  CHECK (output_width * 9 = output_height * 16)
);

CREATE TABLE sloptogether.memberships (
  twitch_user_id text NOT NULL,
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','moderator','reviewer','broadcaster')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (twitch_user_id,twitch_channel_id)
);

CREATE TABLE sloptogether.bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL,
  twitch_channel_id text REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('channel','global')),
  reason text NOT NULL DEFAULT '',
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  CHECK ((scope='channel' AND twitch_channel_id IS NOT NULL) OR (scope='global' AND twitch_channel_id IS NULL))
);
CREATE INDEX bans_active_user ON sloptogether.bans(twitch_user_id,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE sloptogether.oauth_states (
  state_hash bytea PRIMARY KEY,
  browser_nonce_hash bytea NOT NULL,
  return_path text NOT NULL DEFAULT '/sloptogether/control',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE sloptogether.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  twitch_user_id text NOT NULL,
  twitch_login text NOT NULL,
  display_name text NOT NULL,
  access_token_encrypted bytea NOT NULL,
  refresh_token_encrypted bytea,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  token_expires_at timestamptz NOT NULL,
  token_validated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_active ON sloptogether.sessions(twitch_user_id,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE sloptogether.application_keys (
  key_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_hash bytea NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  issuing_twitch_user_id text NOT NULL,
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['worker:generation','worker:upscale','story:write_future','artifact:system_approve','streamer:control']::text[]),
  worker_roles text[] NOT NULL DEFAULT '{}',
  recipe_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  key_revision integer NOT NULL DEFAULT 1 CHECK (key_revision > 0)
);

CREATE TABLE sloptogether.worker_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL,
  display_name text NOT NULL,
  public_key text,
  credential_hash bytea UNIQUE,
  platform text NOT NULL CHECK (platform IN ('windows','linux','fal')),
  gpu_profile text NOT NULL DEFAULT 'unknown',
  roles text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'paired' CHECK (status IN ('paired','revoked','banned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE sloptogether.worker_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_code_hash bytea NOT NULL UNIQUE,
  polling_secret_hash bytea NOT NULL UNIQUE,
  requested_device jsonb NOT NULL,
  approved_by_twitch_user_id text,
  twitch_channel_id text REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  requested_roles text[] NOT NULL DEFAULT '{}',
  credential_hash bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz
);

CREATE TABLE sloptogether.trusted_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  key_id uuid REFERENCES sloptogether.application_keys(key_id),
  worker_device_id uuid REFERENCES sloptogether.worker_devices(id),
  issuer_twitch_user_id text NOT NULL,
  execution_role text NOT NULL CHECK (execution_role IN ('generation','upscale','story_producer','streamer_control')),
  recipe_ids text[] NOT NULL DEFAULT '{}',
  policy_revision integer NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (key_id IS NOT NULL OR worker_device_id IS NOT NULL)
);

CREATE TABLE sloptogether.boundary_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  asset_id uuid NOT NULL,
  source_revision_id uuid,
  transformation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  moderation_evidence_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE sloptogether.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_branch_id uuid REFERENCES sloptogether.branches(id),
  fork_boundary_revision_id uuid REFERENCES sloptogether.boundary_revisions(id),
  is_selected boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX one_selected_branch_per_channel ON sloptogether.branches(twitch_channel_id) WHERE is_selected AND archived_at IS NULL;

CREATE TABLE sloptogether.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  sha256 bytea,
  media_kind text NOT NULL CHECK (media_kind IN ('image','video','audio','hls_segment','manifest')),
  content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  width integer,
  height integer,
  fps_num integer,
  fps_den integer,
  frame_count integer,
  duration_seconds numeric(12,6),
  status text NOT NULL DEFAULT 'quarantine' CHECK (status IN ('uploading','quarantine','validated','approved','published','rejected','retired')),
  producer_key_id uuid REFERENCES sloptogether.application_keys(key_id),
  worker_device_id uuid REFERENCES sloptogether.worker_devices(id),
  uploaded_by_twitch_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz
);
ALTER TABLE sloptogether.boundary_revisions ADD CONSTRAINT boundary_asset_fk FOREIGN KEY (asset_id) REFERENCES sloptogether.assets(id);

CREATE TABLE sloptogether.segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES sloptogether.branches(id),
  ordinal bigint NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','voting','selected','locked','rendering','ready','rejected','played','retired')),
  source_pts_start numeric(14,6),
  source_pts_end numeric(14,6),
  selected_revision_id uuid,
  protected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id,ordinal)
);

CREATE TABLE sloptogether.funding_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('twitch_extension_bits','owner_budget','channel_budget')),
  twitch_transaction_id text UNIQUE,
  purchaser_twitch_user_id text,
  action_intent_id uuid UNIQUE,
  amount_bits integer CHECK (amount_bits IS NULL OR amount_bits > 0),
  reserved_usd numeric(12,4) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  actual_cost_usd numeric(12,4),
  attempts_authorized integer NOT NULL DEFAULT 1 CHECK (attempts_authorized=1),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','consumed_uncertain','consumed_succeeded','consumed_failed','consumed_rejected','paid_unfulfilled','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  settled_at timestamptz
);

CREATE TABLE sloptogether.segment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id uuid NOT NULL REFERENCES sloptogether.segments(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  prompt text NOT NULL,
  visual_prompt text,
  dialogue text,
  start_boundary_revision_id uuid NOT NULL REFERENCES sloptogether.boundary_revisions(id),
  requested_end_boundary_revision_id uuid REFERENCES sloptogether.boundary_revisions(id),
  planning_mode text NOT NULL CHECK (planning_mode IN ('planned_anchors','continuation')),
  provider_recipe_id text NOT NULL,
  seed bigint,
  target_funding_id uuid REFERENCES sloptogether.funding_authorizations(id),
  input_sha256 bytea NOT NULL,
  requested_by text NOT NULL,
  state text NOT NULL DEFAULT 'proposal' CHECK (state IN ('proposal','selected','locked','rendering','ready','rejected','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (segment_id,revision),
  CHECK ((planning_mode='continuation' AND requested_end_boundary_revision_id IS NULL) OR planning_mode='planned_anchors')
);
ALTER TABLE sloptogether.segments ADD CONSTRAINT segment_selected_revision_fk FOREIGN KEY (selected_revision_id) REFERENCES sloptogether.segment_revisions(id);

CREATE TABLE sloptogether.endpoint_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_revision_id uuid NOT NULL REFERENCES sloptogether.segment_revisions(id),
  source_artifact_id uuid NOT NULL REFERENCES sloptogether.assets(id),
  source_sha256 bytea NOT NULL,
  source_input_sha256 bytea NOT NULL,
  resolved_end_boundary_revision_id uuid NOT NULL REFERENCES sloptogether.boundary_revisions(id),
  approval_path text NOT NULL CHECK (approval_path IN ('human_review','trusted_execution_policy','trusted_uploader_policy','streamer_override')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (segment_revision_id,source_artifact_id)
);

CREATE TABLE sloptogether.input_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  input_sha256 bytea NOT NULL,
  prompt_sha256 bytea NOT NULL,
  image_sha256s text[] NOT NULL DEFAULT '{}',
  moderation_model text NOT NULL,
  moderation_policy_revision integer NOT NULL,
  provider_result_id text,
  category_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_input_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  automated_state text NOT NULL CHECK (automated_state IN ('clear','held','pending','error')),
  effective_state text NOT NULL CHECK (effective_state IN ('clear','held','pending')),
  manual_resolution_by text,
  manual_resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
ALTER TABLE sloptogether.boundary_revisions ADD CONSTRAINT boundary_moderation_fk FOREIGN KEY (moderation_evidence_id) REFERENCES sloptogether.input_screens(id);

CREATE TABLE sloptogether.elections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id uuid NOT NULL REFERENCES sloptogether.segments(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','selected','cancelled','superseded')),
  closes_at timestamptz NOT NULL,
  rule_snapshot jsonb NOT NULL,
  winner_proposal_id uuid,
  closed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sloptogether.proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id uuid NOT NULL REFERENCES sloptogether.elections(id) ON DELETE CASCADE,
  author_twitch_user_id text NOT NULL,
  proposal_kind text NOT NULL CHECK (proposal_kind IN ('scene','prompt','start_frame','anchor_pair')),
  prompt text,
  start_boundary_revision_id uuid REFERENCES sloptogether.boundary_revisions(id),
  end_boundary_revision_id uuid REFERENCES sloptogether.boundary_revisions(id),
  input_screen_id uuid REFERENCES sloptogether.input_screens(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','eligible','rejected','withdrawn','selected','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_reason text
);
ALTER TABLE sloptogether.elections ADD CONSTRAINT election_winner_proposal_fk FOREIGN KEY (winner_proposal_id) REFERENCES sloptogether.proposals(id);

CREATE TABLE sloptogether.ballots (
  election_id uuid NOT NULL REFERENCES sloptogether.elections(id) ON DELETE CASCADE,
  twitch_user_id text NOT NULL,
  proposal_id uuid NOT NULL REFERENCES sloptogether.proposals(id) ON DELETE CASCADE,
  source_surface text NOT NULL CHECK (source_surface IN ('extension','chat','website')),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (election_id,twitch_user_id)
);

CREATE TABLE sloptogether.chat_event_receipts (
  twitch_message_id text PRIMARY KEY,
  broadcaster_twitch_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  chatter_twitch_user_id text NOT NULL,
  normalized_command text NOT NULL,
  event_at timestamptz NOT NULL,
  processed_at timestamptz,
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sloptogether.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  segment_revision_id uuid REFERENCES sloptogether.segment_revisions(id),
  interrupt_id uuid,
  stage text NOT NULL CHECK (stage IN ('story_plan','subscriber_interrupt_plan','prompt_plan','image_boundary','video_base','video_upscale')),
  execution_mode text NOT NULL CHECK (execution_mode IN ('pull_worker','provider_queue')),
  state text NOT NULL DEFAULT 'blocked' CHECK (state IN ('blocked','ready','leased','running','uncertain','uploaded','validating','succeeded','failed','cancelled','expired')),
  recipe_id text NOT NULL,
  recipe_sha256 bytea NOT NULL,
  input_sha256 bytea NOT NULL,
  requested_by text NOT NULL,
  funding_id uuid REFERENCES sloptogether.funding_authorizations(id),
  parent_asset_id uuid REFERENCES sloptogether.assets(id),
  dependency_resolution_id uuid REFERENCES sloptogether.endpoint_resolutions(id),
  planning_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 0,
  result_deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX ready_jobs_by_channel ON sloptogether.jobs(twitch_channel_id,stage,priority DESC,created_at) WHERE state='ready';

CREATE TABLE sloptogether.job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES sloptogether.jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  fence bigint NOT NULL,
  worker_device_id uuid REFERENCES sloptogether.worker_devices(id),
  execution_binding_id uuid REFERENCES sloptogether.trusted_executions(id),
  funding_id uuid REFERENCES sloptogether.funding_authorizations(id),
  provider_request_id text,
  client_idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','leased','running','uncertain','uploaded','validating','succeeded','failed','rejected','expired','cancelled')),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_deadline_at timestamptz,
  upload_grace_deadline_at timestamptz,
  input_sha256 bytea NOT NULL,
  output_asset_id uuid REFERENCES sloptogether.assets(id),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (job_id,attempt_number)
);
CREATE UNIQUE INDEX one_billable_generation_per_funding ON sloptogether.job_attempts(funding_id) WHERE funding_id IS NOT NULL;
ALTER TABLE sloptogether.job_attempts ADD CONSTRAINT attempt_funding_fk FOREIGN KEY (funding_id) REFERENCES sloptogether.funding_authorizations(id);

CREATE TABLE sloptogether.artifact_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES sloptogether.assets(id),
  sha256 bytea NOT NULL,
  input_screen_id uuid NOT NULL REFERENCES sloptogether.input_screens(id),
  approval_path text NOT NULL CHECK (approval_path IN ('human_review','trusted_execution_policy','trusted_uploader_policy','streamer_override')),
  reviewer_twitch_user_id text,
  execution_binding_id uuid REFERENCES sloptogether.trusted_executions(id),
  uploader_twitch_user_id text,
  trust_policy_revision integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected','revoked')),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sloptogether.endpoint_resolution_dependencies (
  resolution_id uuid NOT NULL REFERENCES sloptogether.endpoint_resolutions(id) ON DELETE CASCADE,
  dependent_job_id uuid NOT NULL REFERENCES sloptogether.jobs(id) ON DELETE CASCADE,
  dependency_kind text NOT NULL DEFAULT 'resolved_end_boundary',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resolution_id,dependent_job_id)
);

CREATE TABLE sloptogether.upload_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES sloptogether.job_attempts(id),
  fence bigint NOT NULL,
  staging_key text NOT NULL UNIQUE,
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  content_type text NOT NULL,
  expires_at timestamptz NOT NULL,
  uploaded_bytes bigint,
  source_sha256 bytea,
  immutable_snapshot_key text UNIQUE,
  snapshot_sha256 bytea,
  state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','uploaded','snapshotted','expired','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE sloptogether.subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_message_id text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('channel.subscribe','channel.subscription.message','channel.subscription.gift')),
  broadcaster_twitch_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  twitch_actor_id text,
  is_anonymous boolean NOT NULL DEFAULT false,
  event_payload jsonb NOT NULL,
  event_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','ignored','queued','planned','rendering','ready','played','expired','cancelled','failed')),
  interrupt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sloptogether.interrupt_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_twitch_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id),
  trigger_event_id uuid NOT NULL REFERENCES sloptogether.subscription_events(id),
  idempotency_key text NOT NULL UNIQUE,
  subscriber_label text NOT NULL,
  plan_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  program_state text NOT NULL DEFAULT 'queued' CHECK (program_state IN ('queued','planning','screening','rendering','validating','ready','scheduled','playing','played','skipped','expired','cancelled','failed')),
  funding_id uuid REFERENCES sloptogether.funding_authorizations(id),
  asset_id uuid REFERENCES sloptogether.assets(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  played_at timestamptz,
  UNIQUE (trigger_event_id)
);
ALTER TABLE sloptogether.subscription_events ADD CONSTRAINT subscription_interrupt_fk FOREIGN KEY (interrupt_id) REFERENCES sloptogether.interrupt_requests(id);
ALTER TABLE sloptogether.interrupt_requests ADD COLUMN job_id uuid REFERENCES sloptogether.jobs(id);

CREATE TABLE sloptogether.story_producers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  worker_device_id uuid REFERENCES sloptogether.worker_devices(id),
  execution_binding_id uuid REFERENCES sloptogether.trusted_executions(id),
  fence bigint NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz NOT NULL,
  writer_hold_revision bigint NOT NULL DEFAULT 0,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_story_producer_per_channel ON sloptogether.story_producers(twitch_channel_id) WHERE released_at IS NULL;

CREATE TABLE sloptogether.story_plan_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  producer_id uuid NOT NULL REFERENCES sloptogether.story_producers(id) ON DELETE CASCADE,
  producer_fence bigint NOT NULL,
  sequence bigint NOT NULL,
  idempotency_key text NOT NULL,
  expected_channel_revision integer NOT NULL,
  input_payload jsonb NOT NULL,
  plan_payload jsonb,
  compiled_prompt text,
  screen_id uuid REFERENCES sloptogether.input_screens(id),
  resulting_segment_id uuid REFERENCES sloptogether.segments(id),
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','pending_screen','eligible','selected','rendering','ready','played','held','failed','superseded')),
  owner_reservation_id uuid REFERENCES sloptogether.funding_authorizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twitch_channel_id,idempotency_key),
  UNIQUE (producer_id,sequence)
);

CREATE TABLE sloptogether.program_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('story','subscriber_interrupt')),
  segment_id uuid REFERENCES sloptogether.segments(id),
  interrupt_id uuid REFERENCES sloptogether.interrupt_requests(id),
  asset_id uuid NOT NULL REFERENCES sloptogether.assets(id),
  item_order bigint NOT NULL,
  source_pts_start numeric(14,6),
  source_pts_end numeric(14,6),
  program_epoch bigint NOT NULL,
  discontinuity_before boolean NOT NULL DEFAULT false,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((item_kind='story' AND segment_id IS NOT NULL AND interrupt_id IS NULL) OR (item_kind='subscriber_interrupt' AND interrupt_id IS NOT NULL))
);
CREATE UNIQUE INDEX program_order_per_epoch ON sloptogether.program_items(twitch_channel_id,program_epoch,item_order);

-- HLS packets are encoded by a separate validated media worker. The mutable
-- live playlist only appends ordered immutable media objects; committed PTS is
-- never rewritten when a subscriber interstitial or a streamer override is added.
CREATE TABLE sloptogether.program_media_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_item_id uuid NOT NULL REFERENCES sloptogether.program_items(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES sloptogether.assets(id),
  media_sequence integer NOT NULL,
  duration_seconds numeric(12,6) NOT NULL CHECK (duration_seconds>0),
  source_pts_start numeric(14,6) NOT NULL,
  source_pts_end numeric(14,6) NOT NULL,
  discontinuity_before boolean NOT NULL DEFAULT false,
  sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(program_item_id,media_sequence),
  CHECK(source_pts_end>=source_pts_start)
);

CREATE TABLE sloptogether.program_manifests (
  twitch_channel_id text NOT NULL REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  program_epoch bigint NOT NULL,
  manifest_revision bigint NOT NULL,
  channel_duration_seconds numeric(14,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(twitch_channel_id,program_epoch)
);

CREATE TABLE sloptogether.playback_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_channel_id text NOT NULL UNIQUE REFERENCES sloptogether.channels(twitch_channel_id) ON DELETE CASCADE,
  controller_user_id text,
  controller_epoch bigint NOT NULL DEFAULT 1,
  active_item_id uuid REFERENCES sloptogether.program_items(id),
  item_offset_seconds numeric(14,6) NOT NULL DEFAULT 0,
  event_sequence bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sloptogether.audit_log (
  id bigserial PRIMARY KEY,
  twitch_channel_id text REFERENCES sloptogether.channels(twitch_channel_id),
  actor_twitch_user_id text,
  actor_key_id uuid REFERENCES sloptogether.application_keys(key_id),
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  policy_revision integer,
  reason text NOT NULL DEFAULT '',
  before_state jsonb,
  after_state jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (twitch_channel_id,idempotency_key)
);

CREATE TABLE sloptogether.outbox (
  id bigserial PRIMARY KEY,
  event_kind text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ALL TABLES IN SCHEMA sloptogether FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sloptogether FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT USAGE ON SCHEMA sloptogether TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA sloptogether TO service_role;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA sloptogether TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA sloptogether GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA sloptogether GRANT USAGE,SELECT ON SEQUENCES TO service_role;
  END IF;
END;
$$;

COMMIT;
