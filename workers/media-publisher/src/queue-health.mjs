import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { databasePoolOptions, publisherEventKinds, requiredEnvironment } from "./index.mjs";

const execFileAsync = promisify(execFile);

export function maxQueueAgeSeconds(value) {
  if (value === undefined || value === "") return 900;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86400) throw new Error("MEDIA_PUBLISHER_MAX_QUEUE_AGE_SECONDS_invalid");
  return parsed;
}

export function maxQueueAttempts(value) {
  if (value === undefined || value === "") return 5;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) throw new Error("MEDIA_PUBLISHER_MAX_ATTEMPTS_invalid");
  return parsed;
}

export async function queueSnapshot(pool, mediaGatewayUrl, maxAgeSeconds, maxAttempts = 5) {
  const result = await pool.query(`SELECT count(*) FILTER (WHERE available_at<=clock_timestamp())::int AS due,
    count(*) FILTER (WHERE available_at<=clock_timestamp() AND leased_until > clock_timestamp())::int AS leased,
    count(*) FILTER (WHERE attempts >= $2)::int AS retrying,
    coalesce(greatest(0, extract(epoch FROM (clock_timestamp() - min(available_at)
      FILTER (WHERE available_at<=clock_timestamp())))), 0)::int AS oldest_due_seconds
    FROM sloptogether.outbox
    WHERE event_kind=ANY($1::text[]) AND delivered_at IS NULL`,
  [publisherEventKinds(mediaGatewayUrl), maxAttempts]);
  const row = result.rows[0];
  if (!row || ![row.due, row.leased, row.retrying, row.oldest_due_seconds].every(value => Number.isSafeInteger(value) && value >= 0)
    || row.leased > row.due) throw new Error("publisher_queue_snapshot_invalid");
  return {
    event: "media_publisher_health", healthy: row.oldest_due_seconds <= maxAgeSeconds && row.retrying === 0,
    due: row.due, leased: row.leased, retryingAtLimit: row.retrying, oldestDueSeconds: row.oldest_due_seconds,
    maxQueueAgeSeconds: maxAgeSeconds, maxAttempts,
  };
}

async function verifyMediaTool(executable) {
  await execFileAsync(executable, ["-version"], { timeout: 5000, maxBuffer: 1024 * 1024 });
}

export async function checkHealth(env = process.env) {
  const config = requiredEnvironment(env);
  const maxAgeSeconds = maxQueueAgeSeconds(env.MEDIA_PUBLISHER_MAX_QUEUE_AGE_SECONDS);
  const maxAttempts = maxQueueAttempts(env.MEDIA_PUBLISHER_MAX_ATTEMPTS);
  const pool = new pg.Pool({
    ...databasePoolOptions(config.databaseUrl, env), max: 1, idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: "sloptogether-media-health",
  });
  try {
    await Promise.all([verifyMediaTool(config.ffmpeg), verifyMediaTool(config.ffprobe)]);
    return await queueSnapshot(pool, config.mediaGatewayUrl, maxAgeSeconds, maxAttempts);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkHealth();
    console.log(JSON.stringify(result));
    if (!result.healthy) process.exitCode = 1;
  } catch (error) {
    // Do not log exception messages: a failed database connection may contain credentials.
    const code = typeof error?.code === "string" && /^[A-Za-z0-9_]{1,60}$/.test(error.code) ? error.code : "health_check_failed";
    console.error(JSON.stringify({ event: "media_publisher_health", healthy: false, code }));
    process.exitCode = 2;
  }
}
