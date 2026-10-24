import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { refreshSupabaseSession } from "./src/lib/supabase-middleware";
import { isDevvitApiHostname, jsonNotFound } from "./src/lib/devvit-api";

const PUBLIC_FILE = /\.(.*)$/;
const PUBLIC_PAGE_PREFIXES = ["/clips", "/c/", "/sign-in", "/sign-up", "/terms", "/privacy"];
const PROTECTED_PAGE_PREFIXES = ["/admin", "/list", "/lists", "/projects", "/settings", "/tasks"];
const PUBLIC_API_PREFIXES = ["/api/billing/webhook", "/api/clips/top", "/api/devvit/", "/api/waitlist"];

function isPublicPagePath(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/_next") ||
    PUBLIC_FILE.test(pathname) ||
    PUBLIC_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))
  );
}

function shouldRefreshSession(pathname: string) {
  if (
    PROTECTED_PAGE_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }

  if (!pathname.startsWith("/api")) {
    return false;
  }

  return !PUBLIC_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isDevvitApiHostname(request, process.env.API_HOSTNAME)) {
    if (pathname === "/api/clips/top" || pathname.startsWith("/api/devvit/")) {
      return NextResponse.next();
    }

    return jsonNotFound();
  }

  const isLandingOnlyModeEnabled =
    process.env.NEXT_PUBLIC_LANDING_ONLY_MODE === "true";

  if (isLandingOnlyModeEnabled) {
    if (
      pathname === "/" ||
      pathname.startsWith("/_next") ||
      PUBLIC_API_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(prefix),
      ) ||
      PUBLIC_FILE.test(pathname)
    ) {
      return NextResponse.next();
    }

    if (pathname.startsWith("/api")) {
      return NextResponse.json(
        { error: "ClipsGG is in landing-page-only mode." },
        { status: 503 }
      );
    }

    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (shouldRefreshSession(pathname)) {
    return refreshSupabaseSession(request);
  }

  if (isPublicPagePath(pathname) || pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/:path*",
};
