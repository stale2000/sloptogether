import { describe, expect, it } from "vitest";
import { shouldRetryControllerClaim } from "./output-source";

describe("shouldRetryControllerClaim", () => {
  it("stops polling when Twitch auth or channel permission is required", () => {
    expect(shouldRetryControllerClaim(401)).toBe(false);
    expect(shouldRetryControllerClaim(403)).toBe(false);
  });

  it("keeps retrying temporary failures and controller contention", () => {
    expect(shouldRetryControllerClaim(409)).toBe(true);
    expect(shouldRetryControllerClaim(503)).toBe(true);
    expect(shouldRetryControllerClaim(null)).toBe(true);
  });
});
