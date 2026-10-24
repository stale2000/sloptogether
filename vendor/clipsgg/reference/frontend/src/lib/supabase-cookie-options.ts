const SUPABASE_AUTH_COOKIE_NAME = "clipsgg-sb-auth";

export const supabaseCookieOptions = {
  name: SUPABASE_AUTH_COOKIE_NAME,
  path: "/",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 400,
};
