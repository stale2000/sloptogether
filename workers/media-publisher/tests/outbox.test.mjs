import test from "node:test";
import assert from "node:assert/strict";
import { validSnapshotCandidateKey, validStagingKey, validateOutboxPayload } from "../src/index.mjs";

const payload={
  assetId:"73afcad4-d30a-4fd8-9c33-f6c1c277a7bf",
  attemptId:"53020861-c114-4d86-93ec-12d1a457c414",
  jobId:"28549fbf-68b7-4983-88d8-7e751b43d59e",
  channelId:"12345",
  fence:"2",
  storageKey:"private/12345/artifacts/73afcad4-d30a-4fd8-9c33-f6c1c277a7bf/result.mp4",
  sha256:"a".repeat(64),
  inputScreenId:"f42e106c-7945-45b4-a2a1-ea44e48f1da0",
  stage:"video_base",
};

test("validates and normalizes the outbox binding before storage access",()=>{
  assert.equal(validateOutboxPayload(payload).fence,2);
  assert.equal(validateOutboxPayload(payload).sha256,"a".repeat(64));
});

test("rejects incomplete and unsupported outbox events",()=>{
  assert.throws(()=>validateOutboxPayload({...payload,stage:"story_plan"}),error=>error.code==="media_payload_invalid");
  assert.throws(()=>validateOutboxPayload({...payload,storageKey:"incoming/12345/attempt/source.mp4"}),error=>error.code==="media_payload_invalid");
});

test("limits staging deletion to the reservation channel's incoming prefix",()=>{
  assert.equal(validStagingKey("incoming/12345/upload/abc.mp4","12345"),true);
  assert.equal(validStagingKey("incoming/99999/upload/abc.mp4","12345"),false);
  assert.equal(validStagingKey("incoming/12345/../private/other.mp4","12345"),false);
  assert.equal(validStagingKey("private/12345/artifacts/file.mp4","12345"),false);
});

test("limits orphan snapshot cleanup to private channel image and artifact objects",()=>{
  assert.equal(validSnapshotCandidateKey("private/12345/images/73afcad4-d30a-4fd8-9c33-f6c1c277a7bf/53020861-c114-4d86-93ec-12d1a457c414","12345"),true);
  assert.equal(validSnapshotCandidateKey("private/12345/artifacts/73afcad4-d30a-4fd8-9c33-f6c1c277a7bf/53020861-c114-4d86-93ec-12d1a457c414.mp4","12345"),true);
  assert.equal(validSnapshotCandidateKey("private/99999/images/73afcad4-d30a-4fd8-9c33-f6c1c277a7bf/53020861-c114-4d86-93ec-12d1a457c414","12345"),false);
  assert.equal(validSnapshotCandidateKey("private/12345/../../other.mp4","12345"),false);
  assert.equal(validSnapshotCandidateKey("incoming/12345/upload/file.mp4","12345"),false);
});
