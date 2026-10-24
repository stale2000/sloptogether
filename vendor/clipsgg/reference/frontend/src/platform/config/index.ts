export { getAppConfig } from "@/lib/config";
export type { AppConfig } from "@/lib/config";

function sanitizeEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  const sanitized = sanitizeEnvValue(value);
  if (!sanitized) {
    throw new Error(`${name} is not configured`);
  }

  return sanitized;
}

export function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
}

export function getPublicAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export function getDiscordFeedbackWebhookUrl() {
  return process.env.DISCORD_FEEDBACK_WEBHOOK_URL || "";
}

export function getStripeRuntimeConfig() {
  return {
    checkoutUrl: process.env.STRIPE_CHECKOUT_URL || "",
    customerPortalUrl: process.env.STRIPE_CUSTOMER_PORTAL_URL || "",
    priceId: process.env.STRIPE_PRICE_ID || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  };
}

export function getR2StorageConfig() {
  return {
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    bucketName: requireEnv("R2_BUCKET_NAME"),
    endpoint: requireEnv("R2_ENDPOINT"),
    publicUrl: requireEnv("R2_PUBLIC_URL"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  };
}

export function getOauthCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionRuntime(),
  };
}
