import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { signedDirectUploadUrl } from "./storage";

const previous = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  for (const [key, value] of Object.entries(previous)) process.env[key] = value;
});

describe("signedDirectUploadUrl", () => {
  it("uses the R2 account endpoint and binds PUTs to the reserved byte size", async () => {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.R2_BUCKET_NAME = "sloptogether-media";
    delete process.env.SLOPTOGETHER_LOCAL_S3_ENDPOINT;

    const signed = new URL(await signedDirectUploadUrl("incoming/123/attempt/output.mp4", "video/mp4", 1234));
    expect(signed.hostname).toBe("test-account.r2.cloudflarestorage.com");
    expect(signed.pathname).toBe("/sloptogether-media/incoming/123/attempt/output.mp4");
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });

  it("rejects unknown or unbounded direct upload sizes", async () => {
    await expect(signedDirectUploadUrl("key", "video/mp4", 0)).rejects.toMatchObject({ code: "invalid_upload_content_length" });
    await expect(signedDirectUploadUrl("key", "video/mp4", 1.5)).rejects.toMatchObject({ code: "invalid_upload_content_length" });
  });
});
