interface Env {
  MEDIA_BUCKET: R2Bucket;
  APP_ORIGIN: string;
  UPLOAD_GATEWAY_SECRET: string;
  UPLOAD_TICKET_KEY: string;
}

interface R2Bucket {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; etag: string } | null>;
  head(key: string): Promise<unknown | null>;
  delete(key: string): Promise<void>;
  put(key: string, value: ReadableStream<Uint8Array>, options: {
    onlyIf: { etagDoesNotMatch: string };
    httpMetadata: { contentType: string };
  }): Promise<unknown | null>;
}

declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number);
}

interface UploadTicket {
  version: 1;
  uploadId: string;
  channelId: string;
  storageKey: string;
  contentType: string;
  maxBytes: number;
  expiresAt: string;
}

interface WorkerMediaTicket {
  version: 1;
  purpose: "worker_asset_read";
  channelId: string;
  leaseId: string;
  assetId: string;
  fence: number;
  storageKey: string;
  contentType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  byteSize: number;
  expiresAt: string;
}

const encoder = new TextEncoder();
const MAX_TICKET_CHARS = 4096;

function response(status: number, body: unknown, origin: string | null) {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (origin === "https://www.clips.gg") {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "600");
    headers.set("Vary", "Origin");
  }
  if (body === null) return new Response(null, { status, headers });
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("ticket_encoding_invalid");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifySignedPayload(value: string, secret: string): Promise<Record<string, unknown>> {
  if (value.length > MAX_TICKET_CHARS || !secret || secret.length < 32) throw new Error("ticket_invalid");
  const separator = value.indexOf(".");
  if (separator < 1 || separator !== value.lastIndexOf(".")) throw new Error("ticket_invalid");
  const encoded = value.slice(0, separator);
  const supplied = decodeBase64url(value.slice(separator + 1));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signatureBuffer=new ArrayBuffer(supplied.byteLength);
  new Uint8Array(signatureBuffer).set(supplied);
  if (!await crypto.subtle.verify("HMAC", key, signatureBuffer, encoder.encode(encoded))) throw new Error("ticket_invalid");
  const bytes = decodeBase64url(encoded);
  const ticket = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) throw new Error("ticket_invalid");
  return ticket as Record<string, unknown>;
}

async function verifyTicket(value: string, secret: string): Promise<UploadTicket> {
  const ticket = await verifySignedPayload(value, secret) as unknown as UploadTicket;
  if (!ticket || ticket.version !== 1 || !/^[0-9a-f-]{36}$/i.test(ticket.uploadId)
    || !/^[0-9]{1,32}$/.test(ticket.channelId) || !ticket.storageKey.startsWith(`incoming/${ticket.channelId}/`)
    || !Number.isSafeInteger(ticket.maxBytes) || ticket.maxBytes < 1 || ticket.maxBytes > 128 * 1024 * 1024
    || !["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(ticket.contentType)
    || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) {
    throw new Error("ticket_invalid");
  }
  return ticket;
}

async function verifyWorkerMediaTicket(value: string, secret: string): Promise<WorkerMediaTicket> {
  const ticket = await verifySignedPayload(value, secret) as unknown as WorkerMediaTicket;
  const prefix = `private/${ticket.channelId}/`;
  const incomingPrefix = `incoming/${ticket.channelId}/`;
  const validKey = typeof ticket.storageKey === "string" && ticket.storageKey.length <= 1024
    && (ticket.storageKey.startsWith(prefix) || ticket.storageKey.startsWith(incomingPrefix))
    && !ticket.storageKey.includes("..") && !ticket.storageKey.includes("\\") && !/[\0-\x1f\x7f]/.test(ticket.storageKey);
  const expiresAt = Date.parse(ticket.expiresAt);
  if (ticket.version !== 1 || ticket.purpose !== "worker_asset_read"
    || !/^[0-9]{1,32}$/.test(ticket.channelId)
    || !/^[0-9a-f-]{36}$/i.test(ticket.leaseId) || !/^[0-9a-f-]{36}$/i.test(ticket.assetId)
    || !Number.isSafeInteger(ticket.fence) || ticket.fence < 1 || !validKey
    || !["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(ticket.contentType)
    || !Number.isSafeInteger(ticket.byteSize) || ticket.byteSize < 1 || ticket.byteSize > 128 * 1024 * 1024
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 2 * 60 * 1000) {
    throw new Error("worker_media_ticket_invalid");
  }
  return ticket;
}

async function serveWorkerMedia(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin") || new URL(request.url).search) return response(400, { error: "worker_media_request_invalid" }, null);
  const value = request.headers.get("x-worker-artifact-ticket") ?? "";
  let ticket: WorkerMediaTicket;
  try { ticket = await verifyWorkerMediaTicket(value, env.UPLOAD_TICKET_KEY); }
  catch { return response(403, { error: "worker_media_ticket_invalid" }, null); }
  let object: Awaited<ReturnType<R2Bucket["get"]>>;
  try { object = await env.MEDIA_BUCKET.get(ticket.storageKey); }
  catch { return response(502, { error: "worker_media_read_failed" }, null); }
  if (!object) return response(404, { error: "worker_media_not_found" }, null);
  if (object.size !== ticket.byteSize) return response(409, { error: "worker_media_size_changed" }, null);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    "Content-Type": ticket.contentType,
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(object.body, { status: 200, headers });
}

async function authorizeUpload(env: Env, uploadId: string): Promise<{ storageKey: string; maxBytes: number; contentType: string; expiresAt: string }> {
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password || !["", "/"].includes(origin.pathname) || origin.search || origin.hash) throw new Error("app_origin_invalid");
  let response: Response;
  try {
    response = await fetch(`${origin.origin}/sloptogether/api/v1/internal/uploads/${encodeURIComponent(uploadId)}/authorize`, {
      method: "POST",
      headers: { "x-upload-gateway-secret": env.UPLOAD_GATEWAY_SECRET, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
    console.error(
      "upload_authorization_fetch_failed",
      error instanceof Error ? error.name : "unknown",
      error instanceof Error ? error.message : "",
      cause?.name ?? "",
      cause?.message ?? "",
    );
    throw error;
  }
  if (!response.ok) {
    console.error("upload_authorization_http_status", response.status);
    throw new Error("upload_capability_inactive");
  }
  const result = await response.json() as { authorized?: boolean; storageKey?: string; maxBytes?: number; contentType?: string; expiresAt?: string };
  if (result.authorized !== true || typeof result.storageKey !== "string" || !Number.isSafeInteger(result.maxBytes)
    || typeof result.contentType !== "string" || typeof result.expiresAt !== "string") throw new Error("upload_authorization_invalid");
  return result as { storageKey: string; maxBytes: number; contentType: string; expiresAt: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") return response(204, null, origin);
    if (origin !== null && origin !== "https://www.clips.gg") return response(403, { error: "origin_not_allowed" }, null);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/worker-media") return serveWorkerMedia(request, env);
    if (request.method !== "PUT") return response(405, { error: "method_not_allowed" }, origin);
    const match = /^\/uploads\/([0-9a-f-]{36})$/i.exec(url.pathname);
    const ticketValue = url.searchParams.get("ticket");
    if (!match || !ticketValue || url.searchParams.size !== 1) return response(400, { error: "upload_ticket_required" }, origin);
    let ticket: UploadTicket;
    try { ticket = await verifyTicket(ticketValue, env.UPLOAD_TICKET_KEY); }
    catch { return response(403, { error: "upload_ticket_invalid" }, origin); }
    if (ticket.uploadId !== match[1]) return response(403, { error: "upload_ticket_mismatch" }, origin);
    const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (contentType !== ticket.contentType) return response(415, { error: "content_type_mismatch" }, origin);
    const lengthHeader = request.headers.get("content-length");
    const declaredSize = lengthHeader === null ? null : Number(lengthHeader);
    if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(declaredSize))) return response(400, { error: "content_length_invalid" }, origin);
    if (declaredSize !== null && declaredSize > ticket.maxBytes) return response(413, { error: "upload_too_large" }, origin);
    if (!request.body) return response(400, { error: "upload_body_required" }, origin);

    let grant: Awaited<ReturnType<typeof authorizeUpload>>;
    try { grant = await authorizeUpload(env, ticket.uploadId); }
    catch { return response(409, { error: "upload_capability_inactive" }, origin); }
    if (grant.storageKey !== ticket.storageKey || grant.maxBytes !== ticket.maxBytes || grant.contentType !== ticket.contentType
      || Date.parse(grant.expiresAt) <= Date.now()) return response(409, { error: "upload_capability_changed" }, origin);
    if (await env.MEDIA_BUCKET.head(grant.storageKey)) return response(409, { error: "upload_already_written" }, origin);

    let total = 0;
    const counted = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > grant.maxBytes) throw new Error("upload_too_large");
        controller.enqueue(chunk);
      },
    }));
    const bounded = counted.pipeThrough(new FixedLengthStream(grant.maxBytes));
    try {
      const stored = await env.MEDIA_BUCKET.put(grant.storageKey, bounded, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: grant.contentType },
      });
      if (!stored) return response(409, { error: "upload_already_written" }, origin);
      if (total < 1) {
        await env.MEDIA_BUCKET.delete(grant.storageKey);
        return response(400, { error: "upload_empty" }, origin);
      }
      if (declaredSize !== null && total !== declaredSize) {
        await env.MEDIA_BUCKET.delete(grant.storageKey);
        return response(400, { error: "content_length_mismatch" }, origin);
      }
      return response(201, { uploadId: ticket.uploadId, bytes: total }, origin);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "upload_too_large";
      if (!tooLarge) console.error("upload_store_failed", error instanceof Error ? error.name : "unknown", error instanceof Error ? error.message : "");
      return response(tooLarge ? 413 : 502, { error: tooLarge ? "upload_too_large" : "upload_store_failed" }, origin);
    }
  },
};
