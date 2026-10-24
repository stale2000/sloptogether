import { NextResponse } from "next/server";

type DevvitAuthOptions = {
  enabled?: boolean;
  sharedSecret?: string;
};

function getRequestHost(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    return forwardedHost.split(",")[0]!.trim().toLowerCase();
  }

  const hostHeader = request.headers.get("host");
  if (hostHeader) {
    return hostHeader.split(",")[0]!.trim().toLowerCase();
  }

  return new URL(request.url).hostname.toLowerCase();
}

function getRequestSecret(request: Request): string {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  return request.headers.get("x-devvit-secret")?.trim() ?? "";
}

export function jsonNotFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function isDevvitApiHostname(
  request: Request,
  apiHostname = process.env.API_HOSTNAME,
): boolean {
  if (!apiHostname) {
    return false;
  }

  return getRequestHost(request) === apiHostname.toLowerCase();
}

export async function authenticateDevvitRequest(
  request: Request,
  options: DevvitAuthOptions = {},
): Promise<Response | null> {
  const enabled = options.enabled ?? process.env.DEVVIT_API_ENABLED !== "false";
  if (!enabled) {
    return jsonNotFound();
  }

  const sharedSecret = options.sharedSecret ?? process.env.DEVVIT_SHARED_SECRET ?? "";
  const requestSecret = getRequestSecret(request);
  if (!sharedSecret || requestSecret !== sharedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
