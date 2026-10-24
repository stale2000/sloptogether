BEGIN;

ALTER TABLE sloptogether.comfy_frame_generations
  ADD COLUMN generation_kind text NOT NULL DEFAULT 'frame'
    CHECK (generation_kind IN ('frame','prompt')),
  ADD COLUMN generated_text text;

COMMIT;
