# Pre-air upscale rollout

The pre-air option is off by default. It schedules an upscale after a base clip
is approved, waits up to the channel's configured deadline, and publishes the
approved derivative if it is ready. Failure, rejection, timeout, or disabling
the option fences unfinished work and releases the approved base. Planned-anchor
scenes and subscriber interrupts continue through their existing base path.

## Deployment order

1. Back up and apply `db/migrations/020_preair_upscale.sql` to the existing
   SlopTogether schema. It adds only SlopTogether columns, a table, and a
   function. Confirm the runtime role can read the new fields and execute the
   function. Do not enable the option yet.
2. Deploy the capability-gated web API and compatible generation/upscale
   workers. The low-resolution worker must advertise
   `sol-h3-upscale-pruna-fast-1184-v1`. Older workers can continue to claim
   legacy jobs but cannot claim this recipe.
3. Restart the media publisher with the matching pre-air implementation. The
   schema's default-off policy keeps existing channels on base publication.
4. Confirm the publisher drains its outbox, then enable the option for a test
   channel and verify approval, fallback, HLS playback, and the next start frame.

The migration must precede both the web and publisher releases: both query the
new objects even when the feature is off. Do not enable the setting while an
old publisher is running; it would publish the base without honoring the wait.

## Rollback

Disable the option through the updated channel settings first. This fences
unfinished pre-air attempts, expires their upload grants, marks pending choices
for base fallback, and wakes publication. Confirm no rows remain `pending` and
the outbox is drained before reverting the publisher or web release. Already
committed program items and their HLS objects remain immutable.

Keep the additive schema and history during application rollback. Dropping the
table or function would erase the selection history and can strand pending work;
only remove schema objects after an explicit data-retention decision and backup.
