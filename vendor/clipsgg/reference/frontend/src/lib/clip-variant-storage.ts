import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { getR2StorageConfig } from "@/platform/config";
import { createR2Client } from "@/platform/providers/r2";

export function buildClipVariantKey(input: {
  clipId: string;
  contentType: string;
  extensionForContentType: (contentType: string) => string;
  taskId: string;
  variant: string;
  variantFolder: string;
}) {
  const extension = input.extensionForContentType(input.contentType);
  return `${input.variantFolder}/${input.taskId}/${input.clipId}/${input.variant}-${Date.now()}-${randomUUID()}.${extension}`;
}

export async function uploadClipVariant(input: {
  bytes: Buffer;
  bucketKey: string;
  contentType: string;
}) {
  const r2 = createR2Client();
  const config = getR2StorageConfig();

  await r2.send(
    new PutObjectCommand({
      Body: input.bytes,
      Bucket: config.bucketName,
      ContentType: input.contentType,
      Key: input.bucketKey,
    }),
  );

  return `${config.publicUrl.replace(/\/$/, "")}/${input.bucketKey}`;
}
