import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DatabaseUnavailable } from "./db";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
    this.name = "ApiError";
  }
}

/** Compatibility alias for auth/service helpers. */
export class HttpError extends ApiError {
  constructor(status: number, code: string, message = code) {
    super(status, code, message);
    this.name = "HttpError";
  }
}

export { publicAppUrl } from "./database";

export function jsonOk(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return NextResponse.json(body, { ...init, headers });
}

export function jsonError(error: unknown) {
  if (error instanceof ApiError) return jsonOk({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof DatabaseUnavailable) return jsonOk({ error: "service_unavailable", message: "Service is being configured" }, { status: 503 });
  if (error instanceof ZodError) return jsonOk({ error: "invalid_request", message: "The submitted data is invalid" }, { status: 400 });
  const id = randomUUID();
  const name = error instanceof Error ? error.name : "unknown_error";
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/i.test(error.code)
    ? error.code : undefined;
  console.error(JSON.stringify({ event: "api_internal_error", requestId: id, name, ...(code ? { code } : {}) }));
  return jsonOk({ error: "internal_error", requestId: id }, { status: 500 });
}

export async function readJson<T>(request: Request, schema: { parse(input: unknown): T }): Promise<T> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new ApiError(415, "content_type_required");
  const maximum=256_000;
  const lengthHeader=request.headers.get("content-length");
  if(lengthHeader!==null&&(!/^\d+$/.test(lengthHeader)||Number(lengthHeader)>maximum))throw new ApiError(413,"request_too_large");
  const reader=request.body?.getReader();if(!reader)throw new ApiError(400,"request_body_required");
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){
      const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;if(size>maximum){await reader.cancel();throw new ApiError(413,"request_too_large");}
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  let raw:string;
  try{raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),size));}
  catch{throw new ApiError(400,"invalid_json");}
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ApiError(400, "invalid_json"); }
  return schema.parse(value);
}

export function assertSameOrigin(request: Request) {
  const expected = process.env.PUBLIC_APP_URL;
  if (!expected) throw new ApiError(503, "service_unavailable");
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== new URL(expected).origin) {
    throw new ApiError(403, "origin_not_allowed");
  }
}
